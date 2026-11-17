// Model validation for the token radar: deduplication, grouped cross-validation,
// candidate comparison, and the pre-registered adoption rule.
//
// Everything here is a pure function of the snapshot: no clock, no randomness,
// no network. Fold assignment is a string hash, so two runs over the same
// snapshot produce the same folds, the same fits, and the same numbers.
//
// WHY THIS MODULE EXISTS
// The first version of this entry scored with hand-set constants and no
// evidence that its model beat anything simpler. This module tests the model
// against the snapshot's own trading protocols before the board is built, so
// the entry can say what it tested, what won, and what it kept — with numbers
// the dashboard shows.
//
// THE ANTI-LEAKAGE RULE (the whole module stands on it)
// Every statistic a candidate uses — medians, curve parameters, trim
// thresholds, shrinkage strengths, the median age for unknown listing dates —
// is computed ONLY from the training fold. Nothing is computed from the full
// data before splitting, and no normalization uses full-dataset statistics.
// Folds are grouped by token identity: rows that share one token never split
// across train and test, so a token cannot leak into its own prediction.
//
// THE ADOPTION RULE (pre-registered: written before any result was seen)
// The baseline is the first version's model, `baseline-v1`. A challenger is
// adopted only when ALL THREE hold against the baseline:
//   1. its pooled out-of-sample MdAPE is at least 10% relatively better, and
//   2. it wins at least 3 of the 5 folds (a lower fold MdAPE), and
//   3. its pooled Spearman rank correlation is not worse.
// Stage 1 picks the best passing calibration candidate; when none passes, the
// baseline is kept and that is reported honestly. Stage 2 tests ablation
// variants on top of the stage-1 winner, one factor at a time, under the same
// rule against the stage-1 winner; adopted changes combine. The final model's
// numbers are reported with the caveat that the same holdout selected it, so
// its error is optimistic as an absolute figure and the table's value is the
// relative comparison.
//
// CAVEATS (stated on the dashboard too)
// The test population is the protocols whose token already trades — survivors.
// The holdout measures how well a multiple fits trading tokens, NOT how
// accurate any implied launch value is. Pre-token protocols may behave
// differently, and nothing here claims otherwise.

import type { Snapshot, SnapshotProtocol } from './model.ts';

// ---------------------------------------------------------------- primitives

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a non-empty list of finite numbers. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Population variance of a list; 0 for fewer than two values. */
function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
}

/**
 * Whole days from `listedAt` to the snapshot's `asOf` date, clamped at zero;
 * null when unknown or unparsable. This duplicates the same-named helper in
 * lib/model.ts on purpose: this module must not import model.ts at run time
 * (model.ts imports this module), and the two copies parse the same date
 * format the same way.
 */
const DAY_MS = 86_400_000;
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** FNV-1a 32-bit hash: deterministic across runs and machines. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- reporters

/** A token-bearing protocol reduced to what calibration and validation use. */
export interface ReporterPoint {
  slug: string;
  category: string;
  tvl: number;
  mcap: number;
  ratio: number;
  change7d: number | null;
  ageDays: number | null;
  geckoId: string | null;
  symbol: string | null;
  name: string;
}

/** The calibration population: protocols reporting both a market cap and a positive TVL. */
export function reportersOf(snapshot: Snapshot): ReporterPoint[] {
  const points: ReporterPoint[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    points.push({
      slug: p.slug,
      category: p.category ?? 'Uncategorized',
      tvl: p.tvl_usd,
      mcap: p.mcap_usd,
      ratio,
      change7d: p.change_7d,
      ageDays: ageDays(snapshot.as_of, p.listed_at),
      geckoId: p.gecko_id,
      symbol: p.symbol,
      name: p.name,
    });
  }
  points.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return points;
}

// ---------------------------------------------------------------- dedup

/** One token identity: the reporter rows that record the same token. */
export interface TokenGroup {
  key: string;
  members: string[];
  geckoId: string | null;
  /** Median member market cap; the token's own value, robust to one odd entry. */
  mcap: number;
  /** Sum of member TVLs: the token's total secured value across entries. */
  tvl: number;
  ratio: number;
  /** The category of the largest-TVL member (min slug breaks ties). */
  category: string;
  /** How the group formed: 1 = shared gecko_id, 2 = symbol + name, 3 = singleton. */
  tier: 1 | 2 | 3;
  /** Largest over smallest member market cap; 1 for a singleton. */
  mcapSpread: number;
}

export interface DedupReport {
  groups: TokenGroup[];
  rows: number;
  mergesTier1: number;
  mergesTier2: number;
  /** Groups whose member market caps spread by more than 1.5x: flagged, not hidden. */
  spreadFlagged: number;
}

const normalizeSymbol = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const nameWords = (name: string): Set<string> =>
  new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0));

/**
 * Word overlap between two names: shared words over the smaller word count.
 * "Aave" and "Aave V3" score 1; "Uniswap V3" and "Uniswap V2" score 0.5.
 */
function nameOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * Group reporter rows by token identity, in three tiers, evaluated in order:
 * Tier 1 shares a gecko_id (chain-agnostic: one token on many chains is one
 * group; the chain is deliberately NOT part of the key). Tier 2 merges rows
 * without a gecko_id only when BOTH the normalized symbol matches AND the
 * names share strong word overlap — and never merges two distinct gecko_ids.
 * Tier 3 is every row left alone. Union-find over slug-sorted rows, so the
 * grouping is deterministic.
 *
 * Assumption, stated wherever the groups are shown: member TVLs do not
 * double-count the same liquidity, so summing them is the token's total.
 */
export function deduplicate(points: ReporterPoint[]): DedupReport {
  const n = points.length;
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== i) {
      const next = parent[i]!;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const geckoOf = (root: number): string | null => {
    let found: string | null = null;
    for (let i = 0; i < n; i++) {
      if (find(i) !== root) continue;
      const g = points[i]!.geckoId;
      if (g !== null) {
        if (found === null) found = g;
        else if (found !== g) return 'CONFLICT';
      }
    }
    return found;
  };
  // Union by the smaller root, so the representative is deterministic.
  const union = (a: number, b: number): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
    return true;
  };

  // Tier 1: shared gecko_id.
  let mergesTier1 = 0;
  const byGecko = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const g = points[i]!.geckoId;
    if (g === null) continue;
    const list = byGecko.get(g) ?? [];
    list.push(i);
    byGecko.set(g, list);
  }
  for (const list of byGecko.values()) {
    for (let k = 1; k < list.length; k++) if (union(list[0]!, list[k]!)) mergesTier1++;
  }

  // Tier 2: symbol + name, only where at least one side lacks a gecko_id,
  // and never across two distinct gecko_ids.
  let mergesTier2 = 0;
  const words = points.map((p) => nameWords(p.name));
  const symbols = points.map((p) => (p.symbol === null ? '' : normalizeSymbol(p.symbol)));
  for (let i = 0; i < n; i++) {
    if (symbols[i] === '') continue;
    for (let j = i + 1; j < n; j++) {
      if (symbols[j] === '' || symbols[j] !== symbols[i]) continue;
      if (points[i]!.geckoId !== null && points[j]!.geckoId !== null) continue;
      if (nameOverlap(words[i]!, words[j]!) < 0.5) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra === rb) continue;
      const ga = geckoOf(ra);
      const gb = geckoOf(rb);
      if (ga === 'CONFLICT' || gb === 'CONFLICT') continue;
      if (ga !== null && gb !== null && ga !== gb) continue;
      if (union(i, j)) mergesTier2++;
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = byRoot.get(r) ?? [];
    list.push(i);
    byRoot.set(r, list);
  }
  const groups: TokenGroup[] = [];
  let spreadFlagged = 0;
  for (const members of byRoot.values()) {
    const slugs = members.map((i) => points[i]!.slug).sort();
    const geckoId = members.map((i) => points[i]!.geckoId).find((g) => g !== null) ?? null;
    const mcaps = members.map((i) => points[i]!.mcap);
    const mcap = median(mcaps);
    const tvl = members.reduce((sum, i) => sum + points[i]!.tvl, 0);
    const spread = Math.max(...mcaps) / Math.min(...mcaps);
    if (spread > 1.5) spreadFlagged++;
    const largest = [...members].sort(
      (a, b) => points[b]!.tvl - points[a]!.tvl || (points[a]!.slug < points[b]!.slug ? -1 : 1),
    )[0]!;
    const tier: 1 | 2 | 3 = members.length === 1 ? 3 : geckoId !== null && members.length > 1 && members.every((i) => points[i]!.geckoId === geckoId) ? 1 : 2;
    groups.push({
      key: geckoId !== null ? `gecko:${geckoId}` : `slug:${slugs[0]!}`,
      members: slugs,
      geckoId,
      mcap,
      tvl,
      ratio: mcap / tvl,
      category: points[largest]!.category,
      tier,
      mcapSpread: round4(spread),
    });
  }
  groups.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { groups, rows: n, mergesTier1, mergesTier2, spreadFlagged };
}

// ---------------------------------------------------------------- candidates

/** How a candidate calibrates, and which growth/maturity constants it uses. */
export interface CandidateSpec {
  id: string;
  label: string;
  calibration: 'flat' | 'category' | 'shrink-n' | 'shrink-var' | 'shrink-trim' | 'curve-ols' | 'curve-theilsen' | 'curve-huber' | 'curve-offset' | 'curve-seg';
  shrinkK?: number;
  useDedup: boolean;
  growthWeight: number;
  maturityFloor: number;
  unknownAge: 'days365' | 'median' | 'zero';
}

export interface ModelConstantsLike {
  min_category_sample: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_floor_pct: number;
  growth_cap_pct: number;
  maturity_days: number;
  unknown_age_days: number;
}

/** One point a fit learns from: a reporter row, or a deduplicated token group. */
export interface CalPoint {
  tvl: number;
  mcap: number;
  ratio: number;
  category: string;
}

export interface CategoryFit {
  category: string;
  multiple: number;
  n: number;
  /** Shrinkage weight on the category's own median; null when not shrunk. */
  w: number | null;
  /** Where the multiple came from: the category's own median, the global one, or a shrunk blend. */
  kind: string;
}

export interface CalibrationFit {
  kind: 'median' | 'curve';
  globalMultiple: number;
  globalN: number;
  categories: CategoryFit[];
  /** Per-category log offsets, only for the curve-offset fit. */
  offsets: Array<{ category: string; offset: number; n: number }> | null;
  curve: { method: string; a: number; b: number; splitX?: number; a2?: number; b2?: number } | null;
}

/** A fitted model: the multiple (or curve) for any TVL and category, clamped. */
export interface FittedModel {
  ratioFor(tvl: number, category: string): number;
  describe(tvl: number, category: string): { multiple: number; kind: string; w: number | null; n: number | null };
  calibration: CalibrationFit;
}

function pointsOf(spec: CandidateSpec, rows: ReporterPoint[], groups: TokenGroup[]): CalPoint[] {
  if (!spec.useDedup) return rows.map((p) => ({ tvl: p.tvl, mcap: p.mcap, ratio: p.ratio, category: p.category }));
  const wanted = new Set(rows.map((p) => p.slug));
  return groups
    .filter((g) => g.members.every((s) => wanted.has(s)))
    .map((g) => ({ tvl: g.tvl, mcap: g.mcap, ratio: g.ratio, category: g.category }));
}

function trimmedMean(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 4) return sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const drop = Math.floor(sorted.length * 0.05);
  const kept = sorted.slice(drop, sorted.length - drop);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/** Ordinary least squares for y = a + b*x; guards a zero-variance x. */
function ols(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (sxx === 0) return { a: my, b: 0 };
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** Theil–Sen: the median pairwise slope, then the median intercept. Deterministic. */
function theilSen(xs: number[], ys: number[]): { a: number; b: number } {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[j] !== xs[i]) slopes.push((ys[j]! - ys[i]!) / (xs[j]! - xs[i]!));
    }
  }
  if (slopes.length === 0) return ols(xs, ys);
  const b = median(slopes);
  const a = median(xs.map((x, i) => ys[i]! - b * x));
  return { a, b };
}

/** Huber regression: fixed-iteration reweighted least squares from the OLS start. */
function huber(xs: number[], ys: number[]): { a: number; b: number } {
  const start = ols(xs, ys);
  const residuals = xs.map((x, i) => ys[i]! - (start.a + start.b * x));
  const mad = median(residuals.map((r) => Math.abs(r - median(residuals))));
  const scale = Math.max(1.4826 * mad, 1e-9);
  const c = 1.345;
  let { a, b } = start;
  for (let iter = 0; iter < 50; iter++) {
    const weights = xs.map((x, i) => {
      const r = Math.abs(ys[i]! - (a + b * x)) / scale;
      return r <= c ? 1 : c / r;
    });
    const sw = weights.reduce((s, w) => s + w, 0);
    const mx = xs.reduce((s, x, i) => s + weights[i]! * x, 0) / sw;
    const my = ys.reduce((s, y, i) => s + weights[i]! * y, 0) / sw;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxx += weights[i]! * (xs[i]! - mx) * (xs[i]! - mx);
      sxy += weights[i]! * (xs[i]! - mx) * (ys[i]! - my);
    }
    if (sxx === 0) break;
    const nb = sxy / sxx;
    const na = my - nb * mx;
    if (Math.abs(na - a) < 1e-12 && Math.abs(nb - b) < 1e-12) {
      a = na;
      b = nb;
      break;
    }
    a = na;
    b = nb;
  }
  return { a, b };
}

/**
 * Fit a candidate on training points only. `groups` is the full grouping;
 * only groups whose members are all in `rows` contribute when useDedup holds
 * (grouped folds guarantee a group never straddles train and test).
 */
export function fitCandidate(spec: CandidateSpec, rows: ReporterPoint[], groups: TokenGroup[], model: ModelConstantsLike): FittedModel {
  const points = pointsOf(spec, rows, groups);
  if (points.length === 0) throw new Error(`fitCandidate: no training points for ${spec.id}`);
  const floor = model.multiple_floor;
  const cap = model.multiple_cap;
  const ratios = points.map((p) => p.ratio);
  // Multiples are rounded to 4 decimals at fit time, as the first version
  // did: what the dashboard shows is then exactly what scored the board.
  const globalMultiple = round4(clamp(median(ratios), floor, cap));

  const byCategory = new Map<string, number[]>();
  for (const p of points) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p.ratio);
    byCategory.set(p.category, list);
  }
  const catNames = [...byCategory.keys()].sort();

  // ---------------------------------------------------------- median family
  if (spec.calibration === 'flat' || spec.calibration === 'category' || spec.calibration === 'shrink-n' || spec.calibration === 'shrink-var' || spec.calibration === 'shrink-trim') {
    const target = spec.calibration === 'shrink-trim' ? round4(clamp(trimmedMean(ratios), floor, cap)) : globalMultiple;
    const globalVar = variance(ratios);
    const perCat = new Map<string, { multiple: number; n: number; w: number | null; kind: string }>();
    for (const cat of catNames) {
      const list = byCategory.get(cat)!;
      const n = list.length;
      const catMedian = round4(clamp(median(list), floor, cap));
      if (spec.calibration === 'flat') {
        perCat.set(cat, { multiple: target, n, w: null, kind: 'global' });
      } else if (spec.calibration === 'category') {
        perCat.set(cat, n >= model.min_category_sample ? { multiple: catMedian, n, w: null, kind: 'category' } : { multiple: target, n, w: null, kind: 'global' });
      } else if (spec.calibration === 'shrink-var') {
        if (n < 3) {
          perCat.set(cat, { multiple: target, n, w: 0, kind: 'global' });
        } else {
          const varCat = variance(list);
          const denom = globalVar + varCat;
          const w = denom === 0 ? n / (n + 5) : globalVar / denom;
          perCat.set(cat, { multiple: round4(clamp(w * catMedian + (1 - w) * target, floor, cap)), n, w: round4(w), kind: 'shrunk' });
        }
      } else {
        const k = spec.calibration === 'shrink-n' ? (spec.shrinkK ?? 5) : 5;
        if (n < 3) {
          perCat.set(cat, { multiple: target, n, w: 0, kind: 'global' });
        } else {
          const w = n / (n + k);
          perCat.set(cat, { multiple: round4(clamp(w * catMedian + (1 - w) * target, floor, cap)), n, w: round4(w), kind: 'shrunk' });
        }
      }
    }
    const categories: CategoryFit[] = catNames.map((cat) => {
      const fit = perCat.get(cat)!;
      return { category: cat, multiple: fit.multiple, n: fit.n, w: fit.w, kind: fit.kind };
    });
    const ratioFor = (_tvl: number, category: string): number => perCat.get(category)?.multiple ?? target;
    return {
      ratioFor,
      describe: (_tvl, category) => {
        const fit = perCat.get(category);
        if (fit === undefined) return { multiple: target, kind: 'global', w: null, n: 0 };
        return { multiple: fit.multiple, kind: fit.kind, w: fit.w, n: fit.n };
      },
      calibration: { kind: 'median', globalMultiple: target, globalN: points.length, categories, offsets: null, curve: null },
    };
  }

  // ---------------------------------------------------------- curve family
  const xs = points.map((p) => Math.log(p.tvl));
  const ys = points.map((p) => Math.log(p.mcap));
  const fitter = spec.calibration === 'curve-theilsen' ? theilSen : spec.calibration === 'curve-huber' ? huber : ols;
  const main = fitter(xs, ys);
  if (spec.calibration === 'curve-seg') {
    const splitX = median(xs);
    const loX: number[] = [];
    const loY: number[] = [];
    const hiX: number[] = [];
    const hiY: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      if (xs[i]! <= splitX) {
        loX.push(xs[i]!);
        loY.push(ys[i]!);
      } else {
        hiX.push(xs[i]!);
        hiY.push(ys[i]!);
      }
    }
    const loFit = loX.length >= 3 ? ols(loX, loY) : main;
    const hiFit = hiX.length >= 3 ? ols(hiX, hiY) : main;
    // Store the low segment in (a, b) and the high segment in (a2, b2).
    return curveModel(main, loFit, hiFit, splitX, points, spec, globalMultiple, floor, cap);
  }
  if (spec.calibration === 'curve-offset') {
    const residuals = points.map((p, i) => ys[i]! - (main.a + main.b * xs[i]!));
    const offsets = new Map<string, number>();
    for (const cat of catNames) {
      const res: number[] = [];
      for (let i = 0; i < points.length; i++) if (points[i]!.category === cat) res.push(residuals[i]!);
      const n = res.length;
      const w = n < 3 ? 0 : n / (n + 5);
      offsets.set(cat, w * (res.reduce((a, b) => a + b, 0) / n));
    }
    const ratioFor = (tvl: number, category: string): number => {
      const logMcap = main.a + main.b * Math.log(tvl) + (offsets.get(category) ?? 0);
      return round4(clamp(Math.exp(logMcap) / tvl, floor, cap));
    };
    return {
      ratioFor,
      describe: (tvl, category) => ({ multiple: ratioFor(tvl, category), kind: 'curve-offset', w: null, n: byCategory.get(category)?.length ?? 0 }),
      calibration: {
        kind: 'curve',
        globalMultiple,
        globalN: points.length,
        categories: [],
        offsets: catNames.map((cat) => ({ category: cat, offset: round4(offsets.get(cat) ?? 0), n: byCategory.get(cat)!.length })),
        curve: { method: 'ols+offset', a: round4(main.a), b: round4(main.b) },
      },
    };
  }
  const ratioFor = (tvl: number, _category: string): number => {
    const logMcap = main.a + main.b * Math.log(tvl);
    return round4(clamp(Math.exp(logMcap) / tvl, floor, cap));
  };
  const method = spec.calibration === 'curve-theilsen' ? 'theil-sen' : spec.calibration === 'curve-huber' ? 'huber' : 'ols';
  return {
    ratioFor,
    describe: (tvl, _category) => ({ multiple: ratioFor(tvl, _category), kind: 'curve', w: null, n: points.length }),
    calibration: { kind: 'curve', globalMultiple, globalN: points.length, categories: [], offsets: null, curve: { method, a: round4(main.a), b: round4(main.b) } },
  };
}

function curveModel(
  _main: { a: number; b: number },
  loFit: { a: number; b: number },
  hiFit: { a: number; b: number },
  splitX: number,
  points: CalPoint[],
  _spec: CandidateSpec,
  globalMultiple: number,
  floor: number,
  cap: number,
): FittedModel {
  const ratioFor = (tvl: number, _category: string): number => {
    const x = Math.log(tvl);
    const fit = x <= splitX ? loFit : hiFit;
    return round4(clamp(Math.exp(fit.a + fit.b * x) / tvl, floor, cap));
  };
  return {
    ratioFor,
    describe: (tvl, _category) => ({ multiple: ratioFor(tvl, _category), kind: 'curve-seg', w: null, n: points.length }),
    calibration: {
      kind: 'curve',
      globalMultiple,
      globalN: points.length,
      categories: [],
      offsets: null,
      curve: { method: 'segmented-ols', a: round4(loFit.a), b: round4(loFit.b), splitX: round4(splitX), a2: round4(hiFit.a), b2: round4(hiFit.b) },
    },
  };
}

// ---------------------------------------------------------------- prediction

export interface PredictInput {
  tvl: number;
  category: string;
  change7d: number | null;
  ageDays: number | null;
}

export function growthFactor(change7d: number | null, spec: CandidateSpec, model: ModelConstantsLike): number {
  const pct = clamp(typeof change7d === 'number' && Number.isFinite(change7d) ? change7d : 0, model.growth_floor_pct, model.growth_cap_pct);
  return 1 + spec.growthWeight * (pct / 100);
}

export function maturityFactor(ageDaysValue: number | null, spec: CandidateSpec, model: ModelConstantsLike, trainMedianAge: number): number {
  let age: number;
  if (ageDaysValue !== null) age = ageDaysValue;
  else if (spec.unknownAge === 'median') age = trainMedianAge;
  else if (spec.unknownAge === 'zero') age = 0;
  else age = model.unknown_age_days;
  return spec.maturityFloor + (1 - spec.maturityFloor) * (clamp(age, 0, model.maturity_days) / model.maturity_days);
}

/** The model's predicted market cap for one protocol, from a fit on training data. */
export function predictMcap(fit: FittedModel, input: PredictInput, spec: CandidateSpec, model: ModelConstantsLike, trainMedianAge: number): number {
  const ratio = fit.ratioFor(input.tvl, input.category);
  return input.tvl * ratio * growthFactor(input.change7d, spec, model) * maturityFactor(input.ageDays, spec, model, trainMedianAge);
}

/** Median known age among training points; 365 when none is known. */
export function trainMedianAgeOf(rows: ReporterPoint[]): number {
  const known = rows.map((p) => p.ageDays).filter((a): a is number => a !== null);
  return known.length === 0 ? 365 : median(known);
}

// ---------------------------------------------------------------- metrics

/** Ranks with ties averaged: the input order is preserved in the output. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const out = new Array<number>(values.length);
  let k = 0;
  while (k < order.length) {
    let end = k + 1;
    while (end < order.length && order[end]!.v === order[k]!.v) end++;
    const avg = (k + 1 + end) / 2;
    for (let j = k; j < end; j++) out[order[j]!.i] = avg;
    k = end;
  }
  return out;
}

/** Spearman rank correlation between predicted and actual values. */
export function spearman(predicted: number[], actual: number[]): number {
  const n = predicted.length;
  if (n < 2) return 0;
  const rp = ranks(predicted);
  const ra = ranks(actual);
  const mp = rp.reduce((a, b) => a + b, 0) / n;
  const ma = ra.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dp = 0;
  let da = 0;
  for (let i = 0; i < n; i++) {
    num += (rp[i]! - mp) * (ra[i]! - ma);
    dp += (rp[i]! - mp) * (rp[i]! - mp);
    da += (ra[i]! - ma) * (ra[i]! - ma);
  }
  if (dp === 0 || da === 0) return 0;
  return num / Math.sqrt(dp * da);
}

export interface EvalNumbers {
  mdape: number;
  signed: number;
  spearman: number;
  foldMdapes: number[];
}

function summarize(preds: number[], actuals: number[], foldOfRow: number[]): EvalNumbers {
  const apes = preds.map((p, i) => Math.abs(p - actuals[i]!) / actuals[i]!);
  const signedList = preds.map((p, i) => (p - actuals[i]!) / actuals[i]!);
  const foldMdapes: number[] = [];
  for (let f = 0; f < 5; f++) {
    const foldApes = apes.filter((_, i) => foldOfRow[i] === f);
    foldMdapes.push(foldApes.length === 0 ? 0 : median(foldApes));
  }
  return { mdape: median(apes), signed: median(signedList), spearman: spearman(preds, actuals), foldMdapes };
}

// ---------------------------------------------------------------- evaluation

export const FOLD_COUNT = 5;

export function foldOfGroup(groupKey: string): number {
  return fnv1a(groupKey) % FOLD_COUNT;
}

export interface EvalSetup {
  points: ReporterPoint[];
  groups: TokenGroup[];
  groupOfSlug: Map<string, string>;
  foldOfSlug: Map<string, number>;
  foldSizes: number[];
}

export function evalSetup(points: ReporterPoint[], groups: TokenGroup[]): EvalSetup {
  const groupOfSlug = new Map<string, string>();
  for (const g of groups) for (const s of g.members) groupOfSlug.set(s, g.key);
  const foldOfSlug = new Map<string, number>();
  const foldSizes = [0, 0, 0, 0, 0];
  for (const p of points) {
    const key = groupOfSlug.get(p.slug) ?? `slug:${p.slug}`;
    const f = foldOfGroup(key);
    foldOfSlug.set(p.slug, f);
    foldSizes[f]!++;
  }
  return { points, groups, groupOfSlug, foldOfSlug, foldSizes };
}

/** Grouped 5-fold cross-validation of one candidate: every statistic from the training fold only. */
export function evaluateCandidate(spec: CandidateSpec, setup: EvalSetup, model: ModelConstantsLike): EvalNumbers {
  const preds: number[] = [];
  const actuals: number[] = [];
  const folds: number[] = [];
  for (let f = 0; f < FOLD_COUNT; f++) {
    const train = setup.points.filter((p) => setup.foldOfSlug.get(p.slug) !== f);
    const test = setup.points.filter((p) => setup.foldOfSlug.get(p.slug) === f);
    if (test.length === 0) continue;
    const fit = fitCandidate(spec, train, setup.groups, model);
    const medAge = trainMedianAgeOf(train);
    for (const p of test) {
      preds.push(predictMcap(fit, { tvl: p.tvl, category: p.category, change7d: p.change7d, ageDays: p.ageDays }, spec, model, medAge));
      actuals.push(p.mcap);
      folds.push(f);
    }
  }
  return summarize(preds, actuals, folds);
}

/** Leave-one-group-out: each token group held out once, the rest training. */
export function evaluateLogo(spec: CandidateSpec, setup: EvalSetup, model: ModelConstantsLike): { mdape: number; signed: number; spearman: number } {
  const preds: number[] = [];
  const actuals: number[] = [];
  for (const g of setup.groups) {
    const held = new Set(g.members);
    const train = setup.points.filter((p) => !held.has(p.slug));
    const test = setup.points.filter((p) => held.has(p.slug));
    if (train.length === 0 || test.length === 0) continue;
    const fit = fitCandidate(spec, train, setup.groups, model);
    const medAge = trainMedianAgeOf(train);
    for (const p of test) {
      preds.push(predictMcap(fit, { tvl: p.tvl, category: p.category, change7d: p.change7d, ageDays: p.ageDays }, spec, model, medAge));
      actuals.push(p.mcap);
    }
  }
  const apes = preds.map((p, i) => Math.abs(p - actuals[i]!) / actuals[i]!);
  const signedList = preds.map((p, i) => (p - actuals[i]!) / actuals[i]!);
  return { mdape: median(apes), signed: median(signedList), spearman: spearman(preds, actuals) };
}

// ---------------------------------------------------------------- candidates

export function candidateList(): CandidateSpec[] {
  const ga = { growthWeight: 0.5, maturityFloor: 0.7, unknownAge: 'days365' as const };
  const noGA = { growthWeight: 0, maturityFloor: 1.0, unknownAge: 'days365' as const };
  const list: CandidateSpec[] = [
    { id: 'baseline-v1', label: 'v1 baseline (category median, GxA)', calibration: 'category', useDedup: false, ...ga },
    { id: 'flat', label: 'Flat global median (no G/A)', calibration: 'flat', useDedup: false, ...noGA },
    { id: 'flat-ga', label: 'Flat global median xGxA', calibration: 'flat', useDedup: false, ...ga },
    { id: 'cat-noga', label: 'Category median (no G/A)', calibration: 'category', useDedup: false, ...noGA },
    { id: 'dedup-cat', label: 'Dedup + category median xGxA', calibration: 'category', useDedup: true, ...ga },
    { id: 'shrink-k3', label: 'Shrinkage k=3 xGxA', calibration: 'shrink-n', shrinkK: 3, useDedup: false, ...ga },
    { id: 'shrink-k5', label: 'Shrinkage k=5 xGxA', calibration: 'shrink-n', shrinkK: 5, useDedup: false, ...ga },
    { id: 'shrink-k10', label: 'Shrinkage k=10 xGxA', calibration: 'shrink-n', shrinkK: 10, useDedup: false, ...ga },
    { id: 'shrink-var', label: 'Variance-ratio shrinkage xGxA', calibration: 'shrink-var', useDedup: false, ...ga },
    { id: 'shrink-trim', label: 'Trimmed-target shrinkage xGxA', calibration: 'shrink-trim', useDedup: false, ...ga },
    { id: 'dedup-shrink-k5', label: 'Dedup + shrinkage k=5 xGxA', calibration: 'shrink-n', shrinkK: 5, useDedup: true, ...ga },
    { id: 'curve-ols', label: 'Log-log OLS curve xGxA', calibration: 'curve-ols', useDedup: false, ...ga },
    { id: 'curve-theilsen', label: 'Theil-Sen curve xGxA', calibration: 'curve-theilsen', useDedup: false, ...ga },
    { id: 'curve-huber', label: 'Huber curve xGxA', calibration: 'curve-huber', useDedup: false, ...ga },
    { id: 'curve-offset', label: 'OLS curve + shrunk offsets xGxA', calibration: 'curve-offset', useDedup: false, ...ga },
    { id: 'curve-seg', label: 'Two-segment OLS curve xGxA', calibration: 'curve-seg', useDedup: false, ...ga },
    { id: 'dedup-curve-ols', label: 'Dedup + OLS curve xGxA', calibration: 'curve-ols', useDedup: true, ...ga },
    { id: 'abl-g0', label: 'Baseline, growth weight 0', calibration: 'category', useDedup: false, growthWeight: 0, maturityFloor: 0.7, unknownAge: 'days365' },
    { id: 'abl-g025', label: 'Baseline, growth weight 0.25', calibration: 'category', useDedup: false, growthWeight: 0.25, maturityFloor: 0.7, unknownAge: 'days365' },
    { id: 'abl-a085', label: 'Baseline, maturity floor 0.85', calibration: 'category', useDedup: false, growthWeight: 0.5, maturityFloor: 0.85, unknownAge: 'days365' },
    { id: 'abl-a100', label: 'Baseline, maturity floor 1.0', calibration: 'category', useDedup: false, growthWeight: 0.5, maturityFloor: 1.0, unknownAge: 'days365' },
    { id: 'abl-age-median', label: 'Baseline, unknown age = median', calibration: 'category', useDedup: false, growthWeight: 0.5, maturityFloor: 0.7, unknownAge: 'median' },
    { id: 'abl-age-0', label: 'Baseline, unknown age = 0 days', calibration: 'category', useDedup: false, growthWeight: 0.5, maturityFloor: 0.7, unknownAge: 'zero' },
  ];
  return list;
}

export interface CandidateResult {
  id: string;
  label: string;
  stage: 'calibration' | 'ablation' | 'ablation-on-winner' | 'final';
  mdape: number;
  signed: number;
  spearman: number;
  foldMdapes: number[];
  foldWins: number;
  logoMdape: number;
  adopted: boolean;
}

/** The adoption rule, applied exactly as pre-registered in the header. */
export function passesRule(challenger: EvalNumbers, foldWins: number, baseline: EvalNumbers): boolean {
  return challenger.mdape <= 0.9 * baseline.mdape && foldWins >= 3 && challenger.spearman >= baseline.spearman - 1e-12;
}

function foldWinsAgainst(evalNumbers: EvalNumbers, baseline: EvalNumbers): number {
  let wins = 0;
  for (let f = 0; f < FOLD_COUNT; f++) {
    if (evalNumbers.foldMdapes[f]! < baseline.foldMdapes[f]!) wins++;
  }
  return wins;
}

export interface SelectionOutcome {
  results: CandidateResult[];
  winnerSpec: CandidateSpec;
  winnerIsBaseline: boolean;
  finalSpec: CandidateSpec;
  notes: string[];
}

/**
 * Run every candidate through grouped 5-fold CV and leave-one-group-out,
 * then apply the pre-registered two-stage adoption rule. Deterministic:
 * the same snapshot always selects the same model.
 */
export function selectModel(setup: EvalSetup, model: ModelConstantsLike): SelectionOutcome {
  const specs = candidateList();
  const evals = new Map<string, EvalNumbers>();
  for (const spec of specs) evals.set(spec.id, evaluateCandidate(spec, setup, model));
  const baselineEval = evals.get('baseline-v1')!;
  const logos = new Map<string, number>();
  for (const spec of specs) logos.set(spec.id, evaluateLogo(spec, setup, model).mdape);

  const results: CandidateResult[] = [];
  // Fold wins are measured against the baseline, except for the stage-2
  // variants, whose adoption rule runs against the stage-1 winner — the
  // dashboard's footnote says which reference each row uses.
  const pushResult = (spec: CandidateSpec, stage: CandidateResult['stage'], adopted: boolean, reference: EvalNumbers = baselineEval): void => {
    const ev = evals.get(spec.id)!;
    results.push({
      id: spec.id,
      label: spec.label,
      stage,
      mdape: round4(ev.mdape),
      signed: round4(ev.signed),
      spearman: round4(ev.spearman),
      foldMdapes: ev.foldMdapes.map(round4),
      foldWins: foldWinsAgainst(ev, reference),
      logoMdape: round4(logos.get(spec.id)!),
      adopted,
    });
  };

  // Stage 1: calibration candidates (v1 growth/maturity constants) vs baseline.
  const calibrationIds = specs.filter((s) => !s.id.startsWith('abl-')).map((s) => s.id);
  let winnerSpec = specs[0]!;
  let bestMdape = baselineEval.mdape;
  const notes: string[] = [];
  for (const id of calibrationIds) {
    if (id === 'baseline-v1') continue;
    const spec = specs.find((s) => s.id === id)!;
    const ev = evals.get(id)!;
    const wins = foldWinsAgainst(ev, baselineEval);
    if (passesRule(ev, wins, baselineEval) && ev.mdape < bestMdape) {
      bestMdape = ev.mdape;
      winnerSpec = spec;
    }
  }
  const winnerIsBaseline = winnerSpec.id === 'baseline-v1';
  notes.push(
    winnerIsBaseline
      ? 'Stage 1: no calibration challenger passed the adoption rule, so the v1 baseline calibration is kept.'
      : `Stage 1: ${winnerSpec.id} passed the adoption rule against the baseline and is the winning calibration.`,
  );

  // Stage 2: ablations on top of the stage-1 winner, one factor at a time.
  const winnerEval = evals.get(winnerSpec.id)!;
  const ablationVariants: CandidateSpec[] = [
    { ...winnerSpec, id: 'w-g0', label: `Winner, growth weight 0`, growthWeight: 0 },
    { ...winnerSpec, id: 'w-g025', label: `Winner, growth weight 0.25`, growthWeight: 0.25 },
    { ...winnerSpec, id: 'w-a085', label: `Winner, maturity floor 0.85`, maturityFloor: 0.85 },
    { ...winnerSpec, id: 'w-a100', label: `Winner, maturity floor 1.0`, maturityFloor: 1.0 },
    { ...winnerSpec, id: 'w-age-median', label: `Winner, unknown age = median`, unknownAge: 'median' },
    { ...winnerSpec, id: 'w-age-0', label: `Winner, unknown age = 0 days`, unknownAge: 'zero' },
  ];
  const finalSpec: CandidateSpec = { ...winnerSpec, id: 'final', label: 'Selected model (final)' };
  const adoptedChanges: string[] = [];
  // One factor at a time: for each factor, test its alternatives against the
  // stage-1 winner and keep the best passing one.
  const factorGroups: CandidateSpec[][] = [
    ablationVariants.slice(0, 2),
    ablationVariants.slice(2, 4),
    ablationVariants.slice(4, 6),
  ];
  for (const group of factorGroups) {
    let best: { spec: CandidateSpec; ev: EvalNumbers } | null = null;
    for (const variant of group) {
      const ev = evaluateCandidate(variant, setup, model);
      evals.set(variant.id, ev);
      logos.set(variant.id, evaluateLogo(variant, setup, model).mdape);
      const wins = foldWinsAgainst(ev, winnerEval);
      if (passesRule(ev, wins, winnerEval) && (best === null || ev.mdape < best.ev.mdape)) best = { spec: variant, ev };
    }
    if (best !== null) {
      if (best.spec.growthWeight !== winnerSpec.growthWeight) {
        finalSpec.growthWeight = best.spec.growthWeight;
        adoptedChanges.push(`growth weight ${best.spec.growthWeight}`);
      }
      if (best.spec.maturityFloor !== winnerSpec.maturityFloor) {
        finalSpec.maturityFloor = best.spec.maturityFloor;
        adoptedChanges.push(`maturity floor ${best.spec.maturityFloor}`);
      }
      if (best.spec.unknownAge !== winnerSpec.unknownAge) {
        finalSpec.unknownAge = best.spec.unknownAge;
        adoptedChanges.push(`unknown age = ${best.spec.unknownAge}`);
      }
    }
  }
  notes.push(
    adoptedChanges.length === 0
      ? 'Stage 2: no ablation variant passed the adoption rule against the stage-1 winner, so its constants are kept.'
      : `Stage 2: adopted ${adoptedChanges.join(', ')} — each passed the rule against the stage-1 winner on its own.`,
  );

  // The final spec, evaluated in the same protocol, with the selection caveat.
  const finalEval = evaluateCandidate(finalSpec, setup, model);
  evals.set('final', finalEval);
  logos.set('final', evaluateLogo(finalSpec, setup, model).mdape);
  notes.push('The final model was selected using this same holdout, so its error is optimistic as an absolute figure; the table is a relative comparison.');

  for (const spec of specs) {
    const stage: CandidateResult['stage'] = spec.id.startsWith('abl-') ? 'ablation' : 'calibration';
    pushResult(spec, stage, spec.id === winnerSpec.id);
  }
  for (const variant of ablationVariants) {
    pushResult(variant, 'ablation-on-winner', false, winnerEval);
  }
  pushResult(finalSpec, 'final', true);
  // Mark the adopted stage-2 variants: those whose single change made it in.
  for (const r of results) {
    if (r.stage !== 'ablation-on-winner') continue;
    if (r.id === 'w-g0' && finalSpec.growthWeight === 0) r.adopted = true;
    if (r.id === 'w-g025' && finalSpec.growthWeight === 0.25) r.adopted = true;
    if (r.id === 'w-a085' && finalSpec.maturityFloor === 0.85) r.adopted = true;
    if (r.id === 'w-a100' && finalSpec.maturityFloor === 1.0) r.adopted = true;
    if (r.id === 'w-age-median' && finalSpec.unknownAge === 'median') r.adopted = true;
    if (r.id === 'w-age-0' && finalSpec.unknownAge === 'zero') r.adopted = true;
  }

  return { results, winnerSpec, winnerIsBaseline, finalSpec, notes };
}

// ---------------------------------------------------------------- rank ranges

/**
 * Leave-one-group-out rank ranges for a fixed board: refit the final model
 * with each token group held out, re-rank the same rows, and record each
 * row's lowest and highest rank. The range measures sensitivity to one
 * calibration group — not prediction error — and board membership is held
 * fixed, so a row's range comes only from re-scoring.
 */
export function rankRanges(
  finalSpec: CandidateSpec,
  setup: EvalSetup,
  rows: Array<{ slug: string; tvl_usd: number; category: string | null; change_7d: number | null; age_days: number | null }>,
  model: ModelConstantsLike,
): Map<string, { lo: number; hi: number }> {
  const ranks = new Map<string, number[]>();
  for (const r of rows) ranks.set(r.slug, []);
  for (const g of setup.groups) {
    const held = new Set(g.members);
    const train = setup.points.filter((p) => !held.has(p.slug));
    if (train.length === 0) continue;
    const fit = fitCandidate(finalSpec, train, setup.groups, model);
    const medAge = trainMedianAgeOf(train);
    const scored = rows
      .map((r) => ({
        slug: r.slug,
        value: predictMcap(fit, { tvl: r.tvl_usd, category: r.category ?? 'Uncategorized', change7d: r.change_7d, ageDays: r.age_days }, finalSpec, model, medAge),
      }))
      .sort((a, b) => b.value - a.value || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => ranks.get(s.slug)!.push(i + 1));
  }
  const out = new Map<string, { lo: number; hi: number }>();
  for (const [slug, list] of ranks) {
    out.set(slug, { lo: Math.min(...list), hi: Math.max(...list) });
  }
  return out;
}

// ---------------------------------------------------------------- scatter

/** Reporter points for the dashboard's log-log chart, rounded for size. */
export function scatterPoints(points: ReporterPoint[]): Array<{ x: number; y: number; c: string }> {
  return points.map((p) => ({ x: round3(Math.log(p.tvl)), y: round3(Math.log(p.mcap)), c: p.category }));
}
