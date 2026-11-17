// The token radar's model: one sealed snapshot in, one ranked board out.
//
// WHAT THE BOARD RANKS
// The board ranks protocols that record no token (no market cap, no CoinGecko
// id, no symbol in the snapshot). It covers every slug on the snapshot's
// watchlist — the floor, never the ceiling — and adds the highest-valued
// pre-token protocols below the floor, the early rows the radar exists to
// find. Protocols whose token already trades are never ranked here: they get
// a separate view showing the market's own market cap, never a modelled
// value, so the two sets are visibly apart.
//
// HOW THE MODEL IS CHOSEN
// The scoring model is not hand-picked. lib/validate.ts tests 23 candidates
// against the snapshot's own trading protocols in grouped 5-fold
// cross-validation plus leave-one-group-out, under a pre-registered adoption
// rule, and the board is scored with the winner — or with the first version's
// model when no challenger passes the rule. The dashboard shows the whole
// candidate table, so the choice is auditable. What the winner is depends on
// the snapshot: the code below never assumes it.
//
// THE SCORING FORM (whatever candidate wins, the shape is the same)
//   implied_value_usd = tvl_usd x R x G x A
//
//   R  the fitted multiple: a category median, a shrunk blend, the global
//      median, or a size curve's ratio at this TVL — whichever the validation
//      selected. Clamped to [MULTIPLE_FLOOR, MULTIPLE_CAP].
//   G  growth: 1 + growth_weight x clamp(change_7d, GROWTH_FLOOR,
//      GROWTH_CAP) / 100. An unreported 7-day change counts as 0.
//   A  maturity: maturity_floor + (1 - maturity_floor) x
//      min(age_days, MATURITY_DAYS) / MATURITY_DAYS, where age_days runs from
//      listed_at to the snapshot's as_of date. An unknown listing date is
//      handled as the selected spec says.
//
// No protocol name is ever special-cased: the same function scores every row,
// and the only per-category input is what the snapshot itself yields.

import {
  deduplicate,
  evalSetup,
  fitCandidate,
  growthFactor,
  maturityFactor,
  rankRanges,
  reportersOf,
  scatterPoints,
  selectModel,
  trainMedianAgeOf,
  type CandidateResult,
  type CandidateSpec,
  type FittedModel,
  type CalibrationFit,
} from './validate.ts';
import { farmSteps, maskTemplate } from './farm.ts';

export { farmSteps } from './farm.ts';

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's fixed constants. The multiples are NOT constants: they are calibrated from the snapshot. */
export interface ModelConstants {
  /** Token-bearing protocols needed before a category earns its own median multiple. */
  min_category_sample: number;
  /** The multiple's floor and cap, so one thin or wild category cannot dominate the board. */
  multiple_floor: number;
  multiple_cap: number;
  /** How much of the clamped 7-day change feeds the growth multiplier. */
  growth_weight: number;
  growth_floor_pct: number;
  growth_cap_pct: number;
  /** The maturity multiplier runs from maturity_floor (new) to 1 (seasoned). */
  maturity_floor: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  min_category_sample: 5,
  multiple_floor: 0.05,
  multiple_cap: 0.75,
  growth_weight: 0.5,
  growth_floor_pct: -40,
  growth_cap_pct: 60,
  maturity_floor: 0.7,
  maturity_days: 730,
  unknown_age_days: 365,
};

export const MODEL_VERSION = 'radar-validated-2';

/** Early rows added below the watchlist floor, by implied value. */
export const EARLY_ROWS = 160;
/** Live-token protocols shown in the separate trading view, by market cap. */
export const LIVE_ROWS = 24;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a non-empty list of finite numbers. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from `listedAt` to the snapshot's `asOf` date, clamped at zero; null when unknown or unparsable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token when all three token fields are absent. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a version marker (V2, v3, 2.0, ...) names a versioned pool, not a fresh launch candidate. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * Whether a below-floor protocol may join the early rows: pre-token, not an
 * exchange, and not a versioned pool. The watchlist's own slugs always join
 * regardless: the watchlist is the floor the house already filtered.
 */
export function isEarlyEligible(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

// ---------------------------------------------------------------- scoring

/** The full scoring breakdown of one protocol, so the dashboard can show every factor. */
export interface ScoreBreakdown {
  implied_value_usd: number;
  multiple: number;
  multiple_from_category: boolean;
  /** Where the multiple came from: category, global, shrunk, curve, curve-offset, curve-seg. */
  multiple_kind: string;
  /** Shrinkage weight on the category's own median; null when not shrunk. */
  multiple_w: number | null;
  /** Reporters (or groups) behind the multiple; null when not applicable. */
  multiple_n: number | null;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
}

/** Score one protocol under a fitted model and the selected spec. */
export function scoreWithFit(
  p: SnapshotProtocol,
  asOf: string,
  fit: FittedModel,
  spec: CandidateSpec,
  trainMedianAge: number,
  model: ModelConstants = MODEL,
): ScoreBreakdown {
  const category = p.category ?? 'Uncategorized';
  const desc = fit.describe(p.tvl_usd, category);
  const growthPct = clamp(typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0, model.growth_floor_pct, model.growth_cap_pct);
  const growthMultiplier = growthFactor(p.change_7d, spec, model);
  const age = ageDays(asOf, p.listed_at);
  const maturityMultiplier = maturityFactor(age, spec, model, trainMedianAge);
  const implied = Math.max(1, Math.round(p.tvl_usd * desc.multiple * growthMultiplier * maturityMultiplier));
  return {
    implied_value_usd: implied,
    multiple: desc.multiple,
    multiple_from_category: desc.kind === 'category',
    multiple_kind: desc.kind,
    multiple_w: desc.w,
    multiple_n: desc.n,
    growth_pct: round4(growthPct),
    growth_multiplier: round4(growthMultiplier),
    maturity_multiplier: round4(maturityMultiplier),
    age_days: age,
  };
}

/** One row of board.json. Extra keys are allowed by the gate; the breakdown is the dashboard's evidence. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: ScoreBreakdown;
  /** Leave-one-group-out rank range: sensitivity to one calibration group, not prediction error. */
  rank_lo: number;
  rank_hi: number;
  farm_steps: string[];
}

/** Build the ranked board under a fitted model: every watchlist slug, then the best early rows below the floor. */
export function buildBoard(
  snapshot: Snapshot,
  fit: FittedModel,
  spec: CandidateSpec,
  trainMedianAge: number,
  ranges: Map<string, { lo: number; hi: number }>,
  model: ModelConstants = MODEL,
): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Early rows: eligible pre-token protocols below the floor, ranked by the
  // same implied value the board uses, so the radar's finds compete on value.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isEarlyEligible(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => ({ p, score: scoreWithFit(p, snapshot.as_of, fit, spec, trainMedianAge, model) }))
    .sort((a, b) => b.score.implied_value_usd - a.score.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const { p } of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, score: scoreWithFit(p, snapshot.as_of, fit, spec, trainMedianAge, model) }));
  scored.sort((a, b) => b.score.implied_value_usd - a.score.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const watchlist = new Set(snapshot.watchlist);
  return scored.map((s, i) => {
    const range = ranges.get(s.p.slug) ?? { lo: i + 1, hi: i + 1 };
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      on_watchlist: watchlist.has(s.p.slug),
      age_days: s.score.age_days,
      implied_value_usd: s.score.implied_value_usd,
      model: s.score,
      rank_lo: range.lo,
      rank_hi: range.hi,
      farm_steps: farmSteps(s.p, s.score.age_days),
    };
  });
}

// ---------------------------------------------------------------- live view

/** A protocol whose token already trades: the board shows the market's own value, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
}

/** The live-token set, by market cap, kept apart from the ranked board. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      symbol: p.symbol,
    }));
}

// ---------------------------------------------------------------- dashboard data

/** The validation evidence the dashboard shows: every candidate, every number, the rule, the caveats. */
export interface ValidationData {
  reporter_rows: number;
  groups: number;
  merges_tier1: number;
  merges_tier2: number;
  spread_flagged: number;
  fold_sizes: number[];
  candidates: CandidateResult[];
  baseline_id: string;
  winner_id: string;
  winner_is_baseline: boolean;
  notes: string[];
}

/** How repetitive the farm plans are, measured from the board itself. */
export interface FarmMetrics {
  total_steps: number;
  distinct_steps: number;
  distinct_ratio: number;
  /** Distinct plan shapes with names, chains, and numbers masked out — the honest variety measure. */
  template_distinct: number;
  template_ratio: number;
  per_step_distinct: number[];
  min_len: number;
  max_len: number;
}

export function farmMetricsOf(board: BoardRow[]): FarmMetrics {
  const all: string[] = [];
  const templates: string[] = [];
  for (const r of board) {
    all.push(...r.farm_steps);
    for (const s of r.farm_steps) templates.push(maskTemplate(s, r.name, r.chains));
  }
  const perStep: number[] = [];
  const maxSteps = Math.max(...board.map((r) => r.farm_steps.length));
  for (let i = 0; i < maxSteps; i++) {
    perStep.push(new Set(board.map((r) => r.farm_steps[i]).filter((s): s is string => s !== undefined)).size);
  }
  const lens = all.map((s) => s.trim().length);
  const distinct = new Set(all).size;
  const templateDistinct = new Set(templates).size;
  return {
    total_steps: all.length,
    distinct_steps: distinct,
    distinct_ratio: Math.round((distinct / all.length) * 1000) / 1000,
    template_distinct: templateDistinct,
    template_ratio: Math.round((templateDistinct / all.length) * 1000) / 1000,
    per_step_distinct: perStep,
    min_len: Math.min(...lens),
    max_len: Math.max(...lens),
  };
}

/** Everything the dashboard renders: the board, the live set, and the model that scored them. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  model_description: string;
  final_spec: { id: string; calibration: string; use_dedup: boolean; growth_weight: number; maturity_floor: number; unknown_age: string };
  calibration: CalibrationFit;
  validation: ValidationData;
  scatter: Array<{ x: number; y: number; c: string }>;
  /** The winning curve as log-log polyline points, or null when the winner is not a curve. */
  curve_points: Array<{ x: number; y: number }> | null;
  median_line: number;
  farm_metrics: FarmMetrics;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** One honest sentence describing the selected model, for the dashboard header. */
export function describeSpec(spec: CandidateSpec, winnerIsBaseline: boolean): string {
  const cal =
    spec.calibration === 'category'
      ? 'the category median mcap/TVL (at least 5 reporters), otherwise the global median'
      : spec.calibration === 'flat'
        ? 'the global median mcap/TVL'
        : spec.calibration === 'shrink-n'
          ? `a shrunk blend of the category and global medians (k=${spec.shrinkK ?? 5})`
          : spec.calibration === 'shrink-var'
            ? 'a variance-ratio shrunk blend of the category and global medians'
            : spec.calibration === 'shrink-trim'
              ? 'a shrunk blend toward the trimmed-mean multiple'
              : spec.calibration === 'curve-ols'
                ? 'a log-log OLS size curve'
                : spec.calibration === 'curve-theilsen'
                  ? 'a Theil–Sen size curve'
                  : spec.calibration === 'curve-huber'
                    ? 'a Huber size curve'
                    : spec.calibration === 'curve-offset'
                      ? 'a log-log OLS size curve with shrunk category offsets'
                      : 'a two-segment log-log size curve';
  const dedup = spec.useDedup ? ', fitted on deduplicated token groups' : '';
  const kept = winnerIsBaseline ? " — the first version's model, kept because no challenger passed the adoption rule" : '';
  return `implied value = TVL × M × growth × maturity, where M is ${cal}${dedup}, growth weight ${spec.growthWeight}, maturity floor ${spec.maturityFloor}${kept}.`;
}

/** Build the board and the dashboard's dataset from the snapshot in one pass. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const points = reportersOf(snapshot);
  const dedup = deduplicate(points);
  const setup = evalSetup(points, dedup.groups);
  const selection = selectModel(setup, model);
  const finalSpec = selection.finalSpec;
  const finalFit = fitCandidate(finalSpec, points, dedup.groups, model);
  const medAge = trainMedianAgeOf(points);

  // Rank ranges need the board's rows first: score once without ranges to fix
  // membership, then re-rank under each leave-one-group-out refit.
  const emptyRanges = new Map<string, { lo: number; hi: number }>();
  const draft = buildBoard(snapshot, finalFit, finalSpec, medAge, emptyRanges, model);
  const ranges = rankRanges(
    finalSpec,
    setup,
    draft.map((r) => ({ slug: r.slug, tvl_usd: r.tvl_usd, category: r.category, change_7d: r.change_7d, age_days: r.age_days })),
    model,
  );
  const board = buildBoard(snapshot, finalFit, finalSpec, medAge, ranges, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;

  // The winning curve as a polyline across the reporters' TVL range, when the
  // winner is a curve; the empty category falls through to the base curve.
  let curvePoints: Array<{ x: number; y: number }> | null = null;
  if (finalFit.calibration.kind === 'curve') {
    const logTvls = points.map((p) => Math.log(p.tvl));
    const lo = Math.min(...logTvls);
    const hi = Math.max(...logTvls);
    curvePoints = [];
    for (let i = 0; i < 24; i++) {
      const x = lo + ((hi - lo) * i) / 23;
      const tvl = Math.exp(x);
      curvePoints.push({ x: Math.round(x * 1000) / 1000, y: Math.round(Math.log(finalFit.ratioFor(tvl, '') * tvl) * 1000) / 1000 });
    }
  }

  return {
    board,
    radar: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      model,
      model_version: MODEL_VERSION,
      model_description: describeSpec(finalSpec, selection.winnerIsBaseline),
      final_spec: {
        id: finalSpec.id,
        calibration: finalSpec.calibration,
        use_dedup: finalSpec.useDedup,
        growth_weight: finalSpec.growthWeight,
        maturity_floor: finalSpec.maturityFloor,
        unknown_age: finalSpec.unknownAge,
      },
      calibration: finalFit.calibration,
      validation: {
        reporter_rows: points.length,
        groups: dedup.groups.length,
        merges_tier1: dedup.mergesTier1,
        merges_tier2: dedup.mergesTier2,
        spread_flagged: dedup.spreadFlagged,
        fold_sizes: setup.foldSizes,
        candidates: selection.results,
        baseline_id: 'baseline-v1',
        winner_id: selection.winnerSpec.id,
        winner_is_baseline: selection.winnerIsBaseline,
        notes: selection.notes,
      },
      scatter: scatterPoints(points),
      curve_points: curvePoints,
      // The chart's flat reference is always the plain global median of the
      // reporter ratios — not the fit's target, which a trimmed variant moves.
      median_line: round4(clamp(median(points.map((p) => p.ratio)), model.multiple_floor, model.multiple_cap)),
      farm_metrics: farmMetricsOf(board),
      watchlist_size: snapshot.watchlist.length,
      board_size: board.length,
      early_size: early,
      live_size: live.length,
      rows: board,
      live,
    },
  };
}

/** The dashboard's dataset as one script: no fetch, no network, the page reads window.RADAR. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

// ---------------------------------------------------------------- parsing

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols: SnapshotProtocol[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || p.slug.length === 0 || typeof p.name !== 'string' || p.name.length === 0) {
      throw new SnapshotError(`protocol ${i} lacks a slug or a name`);
    }
    if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd) || p.tvl_usd < 0) {
      throw new SnapshotError(`protocol ${i} (${p.slug}) lacks a usable tvl_usd`);
    }
    const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      slug: p.slug,
      name: p.name,
      category: strOrNull(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: strOrNull(p.listed_at),
      gecko_id: strOrNull(p.gecko_id),
      symbol: strOrNull(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- self-check

/**
 * Why a board is not one the gate will take, or null: watchlist coverage,
 * ranks exactly 1..N, implied values that do not rise with rank, more than
 * one distinct value, and farm steps inside 3..12 strings of 20..600 chars.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const invented = board.filter((r) => !known.has(r.slug));
  if (invented.length > 0) return `the board names ${invented.length} slugs the snapshot does not list`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) return `row ${i + 1} carries rank ${board[i]!.rank}`;
    if (i > 0 && board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `rank ${i + 1} outvalues rank ${i}`;
    }
  }
  if (board.length >= 2 && new Set(board.map((r) => r.implied_value_usd)).size === 1) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) return `${r.slug} has a farm step of ${n} characters`;
    }
  }
  return null;
}
