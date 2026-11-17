// Farm plans: six steps per protocol, each an action with an estimated cost
// and time. A plan is derived only from what the snapshot records about the
// protocol — its category, its chains, its TVL, its age — plus generic
// wording. No step invents a protocol-specific feature: no pool names, no
// points programs, no reward tokens. Every cost and time is an estimate,
// labelled as one.
//
// THREE AXES OF VARIATION
//   1. Mechanism family, from the category: lending, dex, bridge, staking,
//      derivatives, yield, stable, RWA, insurance, prediction, basis, chain,
//      other. The verbs follow the mechanism: a lending plan borrows and
//      repays, a dex plan rebalances a range, a bridge plan makes a return
//      trip. The family matchers run in a fixed priority order so a category
//      that names two mechanisms (a cross-chain bridge, a leveraged farm)
//      gets one family, deterministically.
//   2. Chain gas tier, from the first chain the snapshot names. The tier
//      table below is an AUTHOR ESTIMATE — the snapshot carries no gas data
//      — and the dashboard says so. Three tiers: high (Ethereum), low (the
//      cheap chains listed), medium (everything else, including Bitcoin).
//   3. TVL tier capital ($75 / $150 / $250) and hold window from age
//      (45 / 60 / 90 days).
//
// NETTING
// The last step totals the plan itself: the gas-bearing transaction count,
// the gas range, and the active minutes are all computed from the same
// constants the earlier steps used, so the summary cannot drift from the
// plan. Weekly actions run ceil(hold/7) times, monthly checks ceil(hold/30)
// times; reads cost no gas, so only setup, core, weekly, and exit
// transactions count toward the gas total.

import type { SnapshotProtocol } from './model.ts';

/** The mechanism family a category maps to. */
export type MechanismFamily =
  | 'lending'
  | 'dex'
  | 'bridge'
  | 'staking'
  | 'derivatives'
  | 'yield'
  | 'stable'
  | 'rwa'
  | 'insurance'
  | 'prediction'
  | 'basis'
  | 'chain'
  | 'other';

/**
 * The family for a category, by substring match in a fixed priority order.
 * Priority matters: 'bridge' beats 'chain' (cross-chain bridges), 'staking'
 * beats 'lending' (liquid staking), 'yield' beats 'chain' (onchain capital
 * allocators). A category matching nothing is 'other'.
 */
export function mechanismOf(category: string | null): MechanismFamily {
  const c = (category ?? '').toLowerCase();
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('stak')) return 'staking';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('dex') || c.includes('swap') || c.includes('liquidity manager') || c.includes('amm')) return 'dex';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('leveraged')) return 'derivatives';
  if (c.includes('yield') || c.includes('vault') || c.includes('curator') || c.includes('allocator')) return 'yield';
  if (c.includes('stable')) return 'stable';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('basis')) return 'basis';
  if (c === 'chain' || c.includes('chain')) return 'chain';
  return 'other';
}

/** Gas tier for a chain name. AUTHOR ESTIMATES — the snapshot carries no gas data. */
export type GasTier = 'high' | 'medium' | 'low';

/** Chains whose transactions are cheap, by the snapshot's own chain names. */
const LOW_GAS_CHAINS = new Set([
  'Solana', 'Binance', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'Avalanche', 'Tron',
  'Sui', 'Aptos', 'Near', 'Fantom', 'Linea', 'zkSync Era', 'Scroll', 'Blast', 'Mantle',
  'Hyperliquid L1', 'Starknet', 'Sei', 'Injective', 'Ink', 'World Chain', 'Gnosis',
  'xDai', 'Celo', 'Moonbeam', 'Manta', 'Cronos', 'Kava', 'Berachain', 'opBNB',
  'Fraxtal', 'Mode', 'Redstone',
]);

export function gasTierOf(chain: string): GasTier {
  if (chain === 'Ethereum') return 'high';
  if (LOW_GAS_CHAINS.has(chain)) return 'low';
  return 'medium';
}

/** Estimated gas per transaction, in dollars. AUTHOR ESTIMATES, not snapshot data. */
export const GAS_ESTIMATES: Record<GasTier, { lo: number; hi: number; label: string }> = {
  high: { lo: 5, hi: 20, label: '$5 to $20' },
  medium: { lo: 2, hi: 8, label: '$2 to $8' },
  low: { lo: 0.1, hi: 2, label: '$0.10 to $2' },
};

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

const money = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** The four mechanism-specific action clauses of a plan. */
interface MechanismText {
  core: string;
  repeat: string;
  check: string;
  hold: string;
}

/** Per-family wording. Each clause names the protocol and the chain so the plan reads as written for it. */
function mechanismText(family: MechanismFamily, name: string, capital: number, chain: string): MechanismText {
  switch (family) {
    case 'lending':
      return {
        core: `Supply $${capital} of USDC to ${name}'s lending market on ${chain} and leave the supply open so the position accrues over time`,
        repeat: `Run one borrow-and-repay cycle each week on ${name}: borrow a small amount against the supply, then repay it in the same session`,
        check: `check the supply balance, the borrow position, and the health factor on ${name}'s own page`,
        hold: `keep the supply open on ${name}`,
      };
    case 'dex':
      return {
        core: `Provide $${capital} of liquidity to ${name}'s largest pool on ${chain} and keep the position in range`,
        repeat: `Rebalance the ${name} liquidity range once a week if the price moved out of it, and collect any accrued fees back into the position`,
        check: `check whether the ${name} position is still in range and how much in fees it has earned`,
        hold: `keep the ${name} liquidity position open and in range`,
      };
    case 'bridge':
      return {
        core: `Bridge $${capital} of USDC through ${name} onto ${chain}, then use the bridged funds inside the destination app`,
        repeat: `Make one return trip each week through ${name}: bridge a small amount back, then bridge it forward again`,
        check: `check the bridge history and any pending transfers on ${name}'s own page`,
        hold: `keep a balance on the destination side of ${name}`,
      };
    case 'staking':
      return {
        core: `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the same wallet`,
        repeat: `Top up the ${name} stake with a small amount each week, or restake any rewards the position earned`,
        check: `check the staked balance and the rewards accrued on ${name}'s own page`,
        hold: `keep the ${name} stake active`,
      };
    case 'derivatives':
      return {
        core: `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, then close it the same week`,
        repeat: `Open and close one small hedged position each week on ${name}, keeping the margin deposit in place between trades`,
        check: `check the margin balance and the open-position history on ${name}'s own page`,
        hold: `keep the margin deposited on ${name}`,
      };
    case 'yield':
      return {
        core: `Deposit $${capital} into one of ${name}'s vaults on ${chain} and hold the vault shares in the farming wallet`,
        repeat: `Add a small amount to the ${name} vault each week, or compound the yield the shares earned`,
        check: `check the vault share balance and the yield earned on ${name}'s own page`,
        hold: `hold the ${name} vault shares`,
      };
    case 'stable':
      return {
        core: `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it for the full window`,
        repeat: `Top up the ${name} stable balance with a small amount each week, or redeem and re-mint a small amount to show activity`,
        check: `check the stable balance and any yield accrued on ${name}'s own page`,
        hold: `hold the ${name} stable balance`,
      };
    case 'rwa':
      return {
        core: `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the farming wallet`,
        repeat: `Top up the ${name} asset holding with a small amount each week`,
        check: `check the asset balance and the yield accrued on ${name}'s own page`,
        hold: `hold the ${name} asset`,
      };
    case 'insurance':
      return {
        core: `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the full window`,
        repeat: `Review the ${name} cover once a week and extend or top it up if the policy is close to expiring`,
        check: `check that the ${name} policy is still active and what it covers`,
        hold: `keep the ${name} policy active`,
      };
    case 'prediction':
      return {
        core: `Fund the wallet with $${capital} and place one position on an active ${name} market on ${chain}`,
        repeat: `Place one new position each week on an active ${name} market, keeping stakes small and varied`,
        check: `check the open positions and their outcomes on ${name}'s own page`,
        hold: `keep funds in the ${name} account`,
      };
    case 'basis':
      return {
        core: `Deposit $${capital} into ${name}'s basis strategy on ${chain} and keep the position open for the full window`,
        repeat: `Top up the ${name} basis position with a small amount each week`,
        check: `check the strategy balance and the yield earned on ${name}'s own page`,
        hold: `keep the ${name} basis position open`,
      };
    case 'chain':
      return {
        core: `Bridge $${capital} onto ${name} and use it in one of the chain's own apps: a swap, a stake, or a contract call`,
        repeat: `Make one on-chain action each week on ${name}: a swap, a stake, a vote, or a contract interaction`,
        check: `check the wallet's transaction history on ${name}'s own explorer page`,
        hold: `keep using ${name} weekly`,
      };
    case 'other':
      return {
        core: `Deposit $${capital} of USDC into ${name}'s main product on ${chain} and keep the position open`,
        repeat: `Repeat one on-chain action each week on ${name}, such as a deposit, a swap, or a vote, so the wallet shows steady use`,
        check: `check the wallet's standing on the page ${name} itself publishes`,
        hold: `keep the ${name} position open`,
      };
  }
}

/**
 * A protocol's farm plan: six steps, each an action with an estimated cost
 * and time, ending in a netting step that totals the plan itself. Derived
 * only from the protocol's category, chains, TVL and age.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const tier = gasTierOf(chain);
  const gas = GAS_ESTIMATES[tier];
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const months = Math.ceil(hold / 30);
  const text = mechanismText(mechanismOf(p.category), p.name, capital, chain);

  // Netting inputs, from the same constants the steps above use: setup (10
  // min, 1 tx), core (20 min, 1 tx), weekly (10 min and 1 tx each), monthly
  // checks (10 min, no gas — reads), exit and log (5 min, 1 tx).
  const txs = 1 + 1 + weeks + 1;
  const minutes = 10 + 20 + 10 * weeks + 10 * months + 5;
  const gasLo = money(gas.lo * txs);
  const gasHi = money(gas.hi * txs);

  const steps = [
    `Set up a fresh wallet that holds only the funds you plan to farm, and store its recovery phrase offline, never in a screenshot or chat. Fund it with $${capital} plus gas money for ${chain} (estimate ${gas.label} per transaction). Estimated cost: the funding amount only. Estimated time: 10 minutes.`,
    `${text.core}. Estimated cost: $${capital} of capital plus an estimated ${gas.label} of gas. Estimated time: 20 minutes to set up.`,
    `${text.repeat}, for each of the ${weeks} weeks. Estimated cost: about ${gas.label} of gas per week (estimate). Estimated time: 10 minutes per week.`,
    `Each month, ${text.check}, and claim only from the protocol's own page; never pay anyone to claim for you. That is ${months} checks over the window. Estimated cost: nothing to check. Estimated time: 10 minutes per check.`,
    `Keep the position open for at least ${hold} days (${weeks} weeks) so the activity spans more than one snapshot window: ${text.hold}, and avoid withdrawing everything at once near a window's end. Estimated cost: the $${capital} stays in the position. Estimated time: ${hold} days.`,
    `Netting for the ${p.name} plan on ${chain}: total estimated cost is $${capital} of capital plus ${gasLo} to ${gasHi} of gas across ${txs} transactions, and total active time is about ${minutes} minutes spread over ${hold} days (${weeks} weeks). All gas figures are author estimates, not snapshot data; actual gas varies with network demand.`,
  ];
  // The gate holds every step to 20..600 characters once trimmed: keep each
  // step inside it by construction, and guard the bound here.
  return steps.map((s) => {
    const t = s.trim();
    return t.length > 600 ? `${t.slice(0, 597)}...` : t;
  });
}

// ---------------------------------------------------------------- template metric

/**
 * A step's template: the protocol name, the chain names, and every number
 * masked out. Two steps share a template when they differ only in those
 * insertions. The raw distinct ratio counts insertions; the template ratio
 * counts genuinely different plan shapes. Both are reported honestly.
 */
export function maskTemplate(step: string, name: string, chains: string[]): string {
  let out = step.split(name).join('{name}');
  const sorted = [...chains].sort((a, b) => b.length - a.length);
  for (const c of sorted) {
    if (c.length > 0) out = out.split(c).join('{chain}');
  }
  return out.replace(/\$?[\d,]+(\.\d+)?/g, '{n}');
}
