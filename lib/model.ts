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
// THE IMPLIED VALUE FORMULA
// Every row's implied value is a pure function of the snapshot's own figures,
// stated here, in the README, and on the dashboard:
//
//   implied_value_usd = tvl_usd x M(category) x G x A
//
//   M(category)  the median market-cap-to-TVL ratio of the token-bearing
//                protocols in the same category (only when at least
//                MIN_CATEGORY_SAMPLE of them report both figures),
//                otherwise the global median across every token-bearing
//                protocol; clamped to [MULTIPLE_FLOOR, MULTIPLE_CAP].
//                Both medians are computed from this snapshot at run time.
//   G            growth: 1 + GROWTH_WEIGHT x clamp(change_7d, GROWTH_FLOOR,
//                GROWTH_CAP) / 100. An unreported 7-day change counts as 0.
//   A            maturity: MATURITY_FLOOR + (1 - MATURITY_FLOOR) x
//                min(age_days, MATURITY_DAYS) / MATURITY_DAYS, where
//                age_days runs from listed_at to the snapshot's as_of date.
//                An unknown listing date counts as UNKNOWN_AGE_DAYS.
//
// No protocol name is ever special-cased: the same function scores every row,
// and the only per-category input is the median the snapshot itself yields.

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

export const MODEL_VERSION = 'radar-median-1';

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

/** One category's calibrated multiple: its median mcap/TVL and how many protocols set it. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  sample: number;
}

/** Everything the calibration learned from the snapshot, so the dashboard can show its work. */
export interface Calibration {
  global_median: number;
  global_sample: number;
  categories: CategoryMultiple[];
}

/**
 * Calibrate the multiples from the snapshot itself: for every category with
 * at least MIN_CATEGORY_SAMPLE token-bearing protocols, the median of their
 * mcap_usd / tvl_usd; plus the global median over all token-bearing
 * protocols as the fallback. Ratios use only protocols reporting both a
 * market cap and a positive TVL.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? 'Uncategorized';
    const list = byCategory.get(key) ?? [];
    list.push(ratio);
    byCategory.set(key, list);
  }
  if (all.length === 0) throw new SnapshotError('snapshot holds no token-bearing protocol to calibrate from');
  const categories: CategoryMultiple[] = [];
  for (const [category, ratios] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ratios.length < model.min_category_sample) continue;
    categories.push({ category, multiple: round4(clamp(median(ratios), model.multiple_floor, model.multiple_cap)), sample: ratios.length });
  }
  return { global_median: round4(clamp(median(all), model.multiple_floor, model.multiple_cap)), global_sample: all.length, categories };
}

/** The multiple one protocol gets, and whether its own category set it. */
export function multipleFor(p: SnapshotProtocol, calibration: Calibration): { multiple: number; from_category: boolean } {
  const hit = calibration.categories.find((c) => c.category === (p.category ?? 'Uncategorized'));
  if (hit !== undefined) return { multiple: hit.multiple, from_category: true };
  return { multiple: calibration.global_median, from_category: false };
}

/** The full scoring breakdown of one protocol, so the dashboard can show every factor. */
export interface ScoreBreakdown {
  implied_value_usd: number;
  multiple: number;
  multiple_from_category: boolean;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
}

/** Score one protocol under the calibrated model. */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  calibration: Calibration,
  model: ModelConstants = MODEL,
): ScoreBreakdown {
  const { multiple, from_category } = multipleFor(p, calibration);
  const growthPct = clamp(typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0, model.growth_floor_pct, model.growth_cap_pct);
  const growthMultiplier = 1 + model.growth_weight * (growthPct / 100);
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMultiplier = model.maturity_floor + (1 - model.maturity_floor) * (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMultiplier * maturityMultiplier));
  return {
    implied_value_usd: implied,
    multiple,
    multiple_from_category: from_category,
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
  farm_steps: string[];
}

/** Build the ranked board: every watchlist slug, then the best early rows below the floor. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const calibration = calibrate(snapshot, model);
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
    .map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, calibration, model) }))
    .sort((a, b) => b.score.implied_value_usd - a.score.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const { p } of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, calibration, model) }));
  scored.sort((a, b) => b.score.implied_value_usd - a.score.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const watchlist = new Set(snapshot.watchlist);
  return scored.map((s, i) => ({
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
    farm_steps: farmSteps(s.p, s.score.age_days),
  }));
}

// ---------------------------------------------------------------- farm plans

/** Capital for one farm position, sized by the protocol's own TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  return 75;
}

/** How long to keep the position open, from the protocol's age: younger records get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The main chain the protocol names, or a neutral phrase when it names none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * The category's core action, in words a farmer can follow. The action comes
 * from the category and the chains the snapshot records — never from a
 * hand-written fact about one protocol — and every cost and time is an
 * estimate, labelled as one.
 */
function coreActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name}'s lending market on ${chain} and leave the supply open so the position accrues over time`;
  }
  if (c.includes('dex') || c.includes('swap') || c.includes('liquidity manager')) {
    return `Provide $${capital} of liquidity to ${name}'s largest pool on ${chain} and keep the position in range`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC through ${name} onto ${chain}, then use the bridged funds inside the destination app`;
  }
  if (c.includes('stak') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the same wallet`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, then close it the same week`;
  }
  if (c.includes('yield') || c.includes('vault') || c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into one of ${name}'s vaults on ${chain} and hold the vault shares in the farming wallet`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it for the full window`;
  }
  if (c.includes('rwa') || c.includes('real world')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the farming wallet`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the full window`;
  }
  if (c.includes('prediction')) {
    return `Fund the wallet with $${capital} and place one position on an active ${name} market on ${chain}`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} into ${name}'s basis strategy on ${chain} and keep the position open for the full window`;
  }
  return `Deposit $${capital} of USDC into ${name}'s main product on ${chain} and keep the position open`;
}

/**
 * A protocol's farm plan: six steps, each an action with an estimated cost
 * and time. Derived only from the protocol's category, chains, TVL and age.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const steps = [
    `Set up a fresh wallet that holds only the funds you plan to farm, and store its recovery phrase offline, never in a screenshot or chat. Estimated cost: nothing to create the wallet. Estimated time: 10 minutes.`,
    `${coreActionFor(p, capital, chain)}. Estimated cost: $${capital} of capital plus an estimated $2 to $8 of gas. Estimated time: 20 minutes to set up.`,
    `Repeat one on-chain action each week, such as a deposit, a borrow, a swap, or a vote, so the wallet shows steady use instead of a single day of activity. Estimated cost: about $2 of gas per week (estimate). Estimated time: 10 minutes per week.`,
    `Once a month, open the points or rewards page the protocol itself publishes and check the wallet's standing there; claim only from the protocol's own page, and never pay anyone to claim for you. Estimated cost: nothing to check. Estimated time: 10 minutes.`,
    `Keep the position open for at least ${hold} days so the activity spans more than one snapshot window, and avoid withdrawing everything at once near a window's end. Estimated cost: the $${capital} stays in the position. Estimated time: ${hold} days.`,
    `Log the wallet address, the dates, and every transaction hash in a notebook, and decide the exit before you need it: unwind in one transaction and keep the receipt. Estimated cost: nothing but the log. Estimated time: 5 minutes.`,
  ];
  // The gate holds every step to 20..600 characters once trimmed: keep each
  // step inside it by construction, and guard the bound here.
  return steps.map((s) => {
    const t = s.trim();
    return t.length > 600 ? `${t.slice(0, 597)}...` : t;
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

/** Everything the dashboard renders: the board, the live set, and the model that scored them. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** Build the board and the dashboard's dataset from the snapshot in one pass. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const calibration = calibrate(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;
  return {
    board,
    radar: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      model,
      model_version: MODEL_VERSION,
      calibration,
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
