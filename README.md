# Token Radar — which pre-token protocol is worth farming next

![Competition](https://make.fun/badge/token-radar-01.svg)
![Rank](https://make.fun/badge/token-radar-01/jontumpil/makefun-token-radar/rank.svg)
![Reward](https://make.fun/badge/token-radar-01/jontumpil/makefun-token-radar/reward.svg)

An entry for make.fun's [token-radar-01](https://make.fun/c/token-radar-01) bounty. The program
reads the sealed DefiLlama snapshot (758 protocols), finds the ones that record no token yet,
ranks them by what a launch would be worth if their record stayed as it is, and hands in a static
dashboard: the ranked board, a detail view for every protocol with its price's full workings and
a concrete farm plan, an "already trading" view, and a method view that states the model.

## The model: priced from the snapshot, not from a list

Most radars price a pre-token protocol at a flat multiple of its TVL, chosen by hand. This one
calibrates the multiple from the snapshot itself:

1. **Calibrate.** Every protocol whose token already trades records both a market cap and a TVL,
   so the snapshot records what the market pays per dollar of TVL. Group those live ratios by
   category and take the median (128 live protocols here; global median 0.214x). A category's
   median is winsorised to [0.02, 2.0] and shrunk toward the global median with a prior of 6
   samples, so a thin category cannot produce a wild price; the result is clamped to [0.05, 1.5].
2. **Price.** `implied = TVL x category_multiple x growth_factor x maturity_factor x breadth_factor`
   — growth is the 7-day TVL change clamped to [-50, +100] and damped by 0.4; maturity is how long
   the protocol has run with no token, saturating at 4 years (an unknown age uses the snapshot's
   median age); breadth adds 1.5% per extra chain, up to 10. Every factor is rounded to 4 places
   before it prices a row, so the dashboard recomputes each row's implied value from the factors
   it prints and lands on board.json's number exactly.

No protocol's name is special-cased anywhere: one function prices every row, and the dashboard's
Method tab prints the whole calibration table the multiples came from.

**Who is ranked.** All 40 watchlist protocols (the floor), plus every other genuine launch
candidate at any size — 198 rows in all. The board applies the watchlist's own product exclusions
at every size and drops only its $50M floor: wrapped, staked and bridged products of tokens that
already trade (WBTC, Binance staked ETH, USDT0), exchanges and their products, and versioned
pools are set aside, never ranked as launches. The 416 live-token protocols are shown separately,
with the market caps that are facts rather than model claims.

**Farm plans.** Each row carries a 7-step plan generated from its own record by
`dashboard/farm.js` — the one generator the program and the page share, so the plan in
`board.json` and the plan on the page can never disagree. The category picks the archetype (16 of
them: lending loop, DEX volume + LP, bridge route, restaking, curated vault, hedged derivatives,
and so on), the first chain prices the gas, the TVL sizes the position, and the age sets the
plan's length. Every step names its cost and its time; the board shows each plan's gas total and
weeks.

## Run it

Node 22.18 or later, standard library only, nothing to install:

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to>/snapshot.json
```

This writes `out/board.json` (the ranked board), `out/data.js` (the dashboard's dataset),
`out/dashboard/` and `out/screenshots/` (copies of the ones here), and `out/dossier.json` (the
judge's dossier, written with `vendor/makefun-board.ts`, byte for byte what the scorer rebuilds).
The program is deterministic: two runs on the same snapshot write identical bytes. Open
`out/dashboard/index.html` in a browser to use the dashboard — it renders with no network.

## Layout

- `main.ts` — the program: snapshot in, board + dashboard + dossier out
- `lib/model.ts` — the calibration, the pricing model, the board builder, the gate self-check
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`) plus `farm.js`, the shared
  farm-plan generator
- `screenshots/` — the board, a protocol's detail view, and a filtered view, rendered from the
  dashboard itself
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored byte for byte as the kit
  requires

## License

MIT (see `LICENSE`).
