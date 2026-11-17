[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/joker31313131/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/joker31313131/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Launch Radar

A token launch radar for the [make.fun](https://make.fun/bounty/token-radar-01)
`token-radar-01` bounty. It reads a sealed snapshot of the protocol universe
(DefiLlama data, frozen at fetch time), ranks the protocols that record no
token yet by an implied launch value derived only from the snapshot's own
figures, and hands in a static dashboard: the ranked board, a detail view for
every protocol, a concrete farm plan per protocol, and the validation
evidence behind the model that scored it.

## The value model — and how it was chosen

Every row's implied value has the same shape:

```
implied_value_usd = TVL x M x G x A
```

The model is not hand-picked. At run time, `lib/validate.ts` tests 23
candidates against the snapshot's own trading protocols in grouped 5-fold
cross-validation plus leave-one-group-out, under a pre-registered adoption
rule, and the board is scored with the winner — or with the first version's
model when no challenger passes the rule. The dashboard shows the whole
candidate table, so the choice is auditable.

On the sealed snapshot (as of 2026-11-14), **no challenger passed the rule,
so the first version's model was kept**:

- `M` — the median market-cap-to-TVL ratio of the token-bearing protocols in
  the same category (at least 5 of them), otherwise the global median across
  all token-bearing protocols; clamped to [0.05, 0.75]. Computed from the
  snapshot at run time, never hardcoded per protocol.
- `G` — growth: `1 + 0.5 x clamp(change_7d, -40, +60) / 100`.
  Unreported 7-day change counts as 0.
- `A` — maturity: `0.7 + 0.3 x min(age_days, 730) / 730`, where age is the
  days from `listed_at` to the snapshot's `as_of` date. Unknown listing date
  counts as 365 days.

### What the validation found

- **Test population:** 128 token-bearing reporters, deduplicated into 128
  token groups — 0 merges at either tier (no two rows share a CoinGecko id,
  and no pair shares both a symbol and strong name overlap), so the dedup
  variants tie the baseline exactly. Fold sizes 26/25/25/30/22.
- **Adoption rule (pre-registered):** a challenger is adopted only if its
  pooled MdAPE is at least 10% relatively better than the baseline AND it
  wins at least 3 of 5 folds AND its Spearman correlation is not worse.
- **Baseline (kept):** MdAPE 0.9162, median signed error −0.0471, Spearman
  0.4301, leave-one-out MdAPE 0.9183.
- **Best challenger:** curve + shrunk category offsets, MdAPE 0.8607 — only
  6.1% better than the baseline, short of the 10% bar. The flat global median
  (MdAPE 0.8735, 5 fold wins) also failed: its Spearman was worse. The
  trimmed-mean shrinkage target was notably worse (MdAPE 0.997): a trimmed
  mean overpredicts on this right-skewed ratio distribution.
- **Ablations:** no growth-weight, maturity-floor, or unknown-age variant
  passed the rule against the winner, so the original constants stand.
- **Caveats, stated on the dashboard:** survivorship bias (the test
  population is traded survivors only); the holdout measures multiple fit,
  not launch-value accuracy; the final model's error is optimistic because
  the same holdout selected it; with MdAPE ≈ 0.92 and Spearman ≈ 0.43 the
  board is a rough ranking heuristic, not pricing.

Each row also carries a leave-one-out rank range (median width 17 ranks, max
118): how much the rank moves when one calibration group is removed —
sensitivity to one reporter, not prediction error.

No protocol name is ever special-cased. Protocols whose token already trades
are kept in a separate "Already trading" view showing the market's own market
cap, never mixed into the ranked board.

## The board

- All 40 watchlist protocols, plus the 160 highest-implied-value pre-token
  protocols below the watchlist floor: 200 rows, ranks 1..200.
- Each row carries 6 farm steps derived from its category, chains, TVL and
  age, each with an estimated cost and time. Plans vary by mechanism family
  (13 families from the category), chain gas tier, TVL-tier capital
  ($75/$150/$250), and hold window (45/60/90 days), and end in a netting step
  that totals the plan's own estimated cost and time. Gas tiers are author
  estimates, labelled as such — the snapshot carries no gas data. Measured on
  this snapshot: 1,200 steps, 1,064 distinct strings (ratio 0.887), 56
  distinct plan shapes with names, chains, and numbers masked out.
- A protocol is described as recording no token, never as having none:
  DefiLlama's record is not proof.

## Layout

- `main.ts` — the entrypoint (Node 22, standard library only). Reads
  `/input/snapshot.json`, writes `/output/board.json`, `/output/data.js`,
  copies `dashboard/` and `screenshots/`, and writes `/output/dossier.json`.
  Fails the run if the dashboard source exceeds its 64,000-byte budget, so
  the judge always sees the dashboard whole.
- `lib/model.ts` — the snapshot parser, the board builder, the dashboard
  dataset, and the board self-check.
- `lib/validate.ts` — token-identity dedup, grouped 5-fold cross-validation,
  leave-one-out, the 23 candidates, and the pre-registered adoption rule.
- `lib/farm.ts` — the farm-plan generator: mechanism families, chain gas
  tiers, and the netting step.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied byte for
  byte from the kit (the scorer runs the same file).
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`. No
  network, no framework, no external assets. Two inline SVG charts, generated
  from the data: a log-log scatter and an MdAPE comparison.
- `screenshots/` — four real renders of the dashboard: the board, a protocol
  detail view, a filtered view, and the validation section.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Two runs over the same snapshot write byte-identical outputs: the program is
a pure function of the snapshot (no clock, no randomness, no network).
