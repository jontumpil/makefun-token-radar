# Launch Radar — token-radar-01

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/jontumpil/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/jontumpil/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar scans a snapshot of 758 protocols, sets aside the 416 that already
trade, and prices the pre-token remainder with a model fitted on the traded
ones. The board holds 198 protocols; 144 pre-token names are set aside as
wrapped / staked / bridged / versioned / exchange-branded products or excluded
categories. All 40 watchlist protocols are covered.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path snapshot>
```

`--input` accepts the snapshot file or the directory containing it; `--output`
overrides the output directory. The program self-checks the board (row count,
unique slugs, exact rank sequence, non-increasing implied values, watchlist
coverage, farm-step shape, implied-value sanity) and exits non-zero on any
failure. Repeated runs are byte-identical. Outputs: `board.json`, `data.js`,
`dashboard/`, `screenshots/`, `dossier.json`.

## The model

- Training pool: the 128 protocols with a positive market cap and positive TVL.
- Features: `[1, log10(TVL), log10(age in days, median-imputed), log10(chain count)]`.
- Fit: two-stage OLS on `log10(mcap)` (normal equations, ridge 1e-8, Gaussian
  elimination with partial pivoting). Stage 1 residuals give a per-category
  offset, shrunk by `n/(n+4)` and kept only for categories with at least 6
  training members; stage 2 refits with the offset removed.
- Implied value: `max(1, round(10^(w·features + category offset)))`, ranked
  descending with a slug tiebreak.
- Verdicts: FARM FIRST at implied ≥ $25M with a category peer record ≥ 40%
  already trading; FARM at ≥ $15M; WATCH at ≥ $6M; otherwise SKIP. Peer records
  count, per category, how many snapshot protocols already trade (category
  figures used when the category has at least 8 protocols, else the global
  416/758).
- Farm plans are costed estimates from category archetypes (setup, monthly
  running cost, weeks, working capital), five concrete steps per row.

## Validation (from the actual run)

Computed at runtime on the snapshot dated 2026-11-14 (folds are md5(slug) mod 5):

| Evaluation | n | median pred/actual | median \|log10 err\| | typical multiple | within [0.5, 2] |
|---|---|---|---|---|---|
| Held-out A (fold 0) | 20 | 0.680 | 0.461 | 2.89x | 30.0% |
| Held-out B (fold 2) | 29 | 1.044 | 0.527 | 3.36x | 41.4% |
| Walk-forward (first 70% by listing date) | 29 | 0.172 | 0.784 | 6.08x | 20.7% |
| Leave-one-out | 128 | 1.001 | 0.595 | 3.94x | 33.6% |
| Growth variant, held-out A | 20 | 0.547 | 0.495 | 3.13x | 20.0% |
| Growth variant, held-out B | 29 | 1.743 | 0.555 | 3.59x | 17.2% |

The growth variant (adding clipped 7d change as a feature) is worse than the
chosen model on both held-out folds — higher typical multiple and a lower
share within 2x — so the pricing model does not use it; 7d change only
informs timing judgement. The walk-forward fold is the weakest, as expected:
the newest listings are the hardest to price from older data.

Run summary: 198 board rows, watchlist covered 40/40, verdicts FARM FIRST 11 /
FARM 32 / WATCH 95 / SKIP 60, median implied value $7,776,176, top row
Steakhouse Financial at $90,073,223.
