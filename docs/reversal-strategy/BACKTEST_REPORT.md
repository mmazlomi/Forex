# Liquidity Sweep Reversal (LSR) — Phase 1 Backtest Report

Run 2026-08-14 against live KuCoin spot data (BTC/USDT), default config (see
`src/services/reversal-strategy/config.js#DEFAULT_CONFIG` / STRATEGY_SPEC.md), no parameters
tuned beforehand or after seeing these results. `feePercent=0.1`, `slippagePercent=0.05`,
`initialCapital=$10,000`, `riskPerTradePercent=0.5`.

**Headline: unprofitable on this symbol/period at default settings, and the sample is far too
small to conclude anything beyond "the machinery works end-to-end."** Full numbers below, plus
what to try next.

## 1. Single-pass backtest (last 30 days)

| Metric | Value |
|---|---|
| Trades | 4 |
| Win rate | 0% |
| Net P&L | −$295.02 (−2.95%) |
| Profit factor | 0.00 |
| Max drawdown | 2.95% |
| Avg trade duration | 4.5 hours |

All 4 trades hit their stop-loss. Long/short split 2/2 — no directional bias in what triggered.

## 2. Single-pass backtest (last 60 days — larger sample)

| Metric | Value |
|---|---|
| Trades | 5 |
| Win rate | 20% (1 win, 4 losses) |
| Net P&L | −$171.88 (−1.72%) |
| Profit factor | 0.384 |
| Expectancy | −$28.61/trade |
| Sharpe | −2.83 · Sortino | −0.60 |
| Max drawdown | 2.58% |
| Long: 4 trades, −$87.37 · Short: 1 trade, −$55.66 |

## 3. Walk-forward (60 days, 3 sequential 20-day windows, same fixed config every window)

| Window | Trades | Win rate | Net P&L |
|---|---|---|---|
| 1 (Jun 15 – Jul 5) | 3 | 33.3% | −0.42% |
| 2 (Jul 5 – Jul 25) | 2 | 0.0% | −1.31% |
| 3 (Jul 25 – Aug 14) | 4 | 0.0% | −2.95% |

**0 of 3 windows profitable.** Aggregate win rate 11.1% ± 19.2 (stdev), net P&L −1.56% ± 1.29
(stdev). The negative result is *consistent* across windows, not driven by one bad window — that
consistency is itself informative (a genuinely broken/unlucky single window would look different
from three independently-negative ones).

## 4. Sensitivity: `riskRewardRatio` (60-day range, 1.5 / 2 / 3, everything else at defaults)

| RR | Trades | Win rate | Net P&L | Profit factor |
|---|---|---|---|---|
| 1.5 | 8 | 25.0% | −2.93% | 0.354 |
| 2 (default) | 5 | 20.0% | −1.72% | 0.384 |
| 3 | 4 | 0.0% | −2.54% | 0.000 |

**No overfitting flag** (`overfittingWarning: null` — no narrow spike; every value underperforms
roughly consistently). This rules out "the default RR just happens to be unlucky" as the
explanation — the problem, if there is one, is more likely upstream of TP sizing (entry timing /
signal quality itself), not the R:R choice.

## Interpretation — do not over-read this

- **Sample size is the dominant caveat.** 4–8 trades is not statistically meaningful in any
  direction. This period (mid-June to mid-August 2026 BTC/USDT) also reads as choppy/range-bound
  in the trade log (price round-tripped 66k → 58k → 65k → 63k) rather than a clean trend — exactly
  the regime a trend-following-adjacent, HTF-filtered reversal strategy is expected to struggle in.
- **Every single trade exited via stop-loss or a near-immediate reversal**, not via take-profit
  reached-then-reversed — this pattern (low win rate, losses that hit SL cleanly) is more
  consistent with "entries are mistimed relative to true reversals" than with "SL/TP sizing is
  wrong," which the RR sensitivity sweep above corroborates.
- This is **one symbol, one exchange, one 60-day window** — nowhere near enough to judge the
  strategy concept itself, only enough to confirm the pipeline produces sane, executable trades
  with correct position sizing and R:R math.

## Known limitations (see IMPLEMENTATION_PLAN.md for the full Phase 2 roadmap)

- No leverage/margin modeling (Phase 1 is margin-free mark-to-market).
- Take-Profit Model A (fixed R) only — Models B (partials + breakeven) and C (trailing) are not
  implemented; a strategy this reversal-prone might benefit substantially from moving to breakeven
  after 1R instead of holding for a fixed 2R target, given how many trades here reversed hard
  after entry.
- No spread modeling (no bid/ask in OHLC data).
- Same-bar sweep+reclaim only (a sweep that reclaims one bar late is not detected — see
  STRATEGY_SPEC.md §4).
- Single symbol/exchange per run — no portfolio-level or multi-symbol backtesting yet.
- Walk-forward here used **the same fixed parameters** in every window, deliberately (see
  IMPLEMENTATION_PLAN.md on why in-loop optimization was intentionally deferred) — this measures
  robustness of one config, not "best achievable" performance.

## Recommended next experiments (in priority order)

1. **Run the same walk-forward across more symbols and a longer history** (90–180 days, several
   pairs) before drawing any conclusion about the strategy concept — 5–8 trades total is not
   enough evidence either way.
2. **Sensitivity-sweep `swingLookback`, `maxDivergenceDistanceBars`, and `retestTolerancePercent`
   next** (the tooling is built — `runReversalSensitivitySweep`) — these three most directly
   affect *entry timing*, which is where this report's evidence points, more than RR/exit sizing.
3. **Try `entryMode: 'immediate'` vs `'retest'` vs `'retest_confirmation'`** head to head on the
   same data — the current default (`retest_confirmation`, the spec's own stated preference) adds
   real lag between CHOCH and fill; on a choppy/fast-reversing symbol that lag could be costing
   more than the extra confirmation is worth. This is a single sensitivity-sweep call away.
4. **Only after (1)-(3)**, consider Take-Profit Model B (move to breakeven after 1R) as a Phase 2
   addition — the loss pattern in this report (SL hit cleanly, not "just missed" TP) suggests
   tighter risk management post-entry could matter more than the entry logic itself, but that's a
   hypothesis to test, not a conclusion from 5 trades.

## Explicit non-promise

Per the original task's instruction: **this strategy is not shown to be profitable.** On the one
symbol/period tested, it lost money with a low win rate, consistently across three independent
windows. This report exists to state that plainly, not to spin it — the value delivered in Phase 1
is a correct, lookahead-free, fully tested measurement instrument, not a validated trading edge.
