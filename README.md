[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/joker31313131/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/joker31313131/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Launch Radar

A token launch radar for the [make.fun](https://make.fun/bounty/token-radar-01)
`token-radar-01` bounty. It reads a sealed snapshot of the protocol universe
(DefiLlama data, frozen at fetch time), ranks the protocols that record no
token yet by an implied launch value derived only from the snapshot's own
figures, and hands in a static dashboard: the ranked board, a detail view for
every protocol, and a concrete farm plan per protocol.

## The value model

Every row's implied value is a pure function of the snapshot:

```
implied_value_usd = TVL x M(category) x G x A
```

- `M(category)` — the median market-cap-to-TVL ratio of the token-bearing
  protocols in the same category (at least 5 of them), otherwise the global
  median across all token-bearing protocols; clamped to [0.05, 0.75].
  Computed from the snapshot at run time, never hardcoded per protocol.
- `G` — growth: `1 + 0.5 x clamp(change_7d, -40, +60) / 100`.
  Unreported 7-day change counts as 0.
- `A` — maturity: `0.7 + 0.3 x min(age_days, 730) / 730`, where age is the
  days from `listed_at` to the snapshot's `as_of` date. Unknown listing date
  counts as 365 days.

No protocol name is ever special-cased. Protocols whose token already trades
are kept in a separate "Already trading" view showing the market's own market
cap, never mixed into the ranked board.

## The board

- All 40 watchlist protocols, plus the 160 highest-implied-value pre-token
  protocols below the watchlist floor: 200 rows, ranks 1..200.
- Each row carries 6 farm steps derived from its category, chains, TVL and
  age, each with an estimated cost and time. Estimates are labelled as
  estimates; nothing is presented as a guaranteed airdrop.
- A protocol is described as recording no token, never as having none:
  DefiLlama's record is not proof.

## Layout

- `main.ts` — the entrypoint (Node 22, standard library only). Reads
  `/input/snapshot.json`, writes `/output/board.json`, `/output/data.js`,
  copies `dashboard/` and `screenshots/`, and writes `/output/dossier.json`.
- `lib/model.ts` — the snapshot parser, the value model, the board builder
  and the farm-plan generator.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied byte for
  byte from the kit (the scorer runs the same file).
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`. No
  network, no framework, no external assets.
- `screenshots/` — three real renders of the dashboard: the board, a protocol
  detail view, and a filtered view.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Two runs over the same snapshot write byte-identical outputs: the program is
a pure function of the snapshot (no clock, no randomness, no network).
