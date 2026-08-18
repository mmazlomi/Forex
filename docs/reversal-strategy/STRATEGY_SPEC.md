# Liquidity Sweep Reversal (LSR) — Strategy Specification

This is the precise, implementable definition of `Liquidity Sweep → RSI Divergence → CHOCH →
Retest → Entry`. Every ambiguity in the original request is resolved below with an explicit
default — all defaults are configurable (see `src/services/reversal-strategy/config.js`), none
are hardcoded into the detection logic.

## 1. Timeframes

| Role | Config key | Default |
|---|---|---|
| Higher timeframe (trend filter) | `htfTimeframe` | `'4h'` |
| Signal timeframe (structure/divergence) | `signalTimeframe` | `'15m'` |
| Entry/trigger timeframe (retest/fill) | `entryTimeframe` | `'5m'` |

All three configurable and independently settable (no hardcoded ratio between them, though
`htfTimeframe` should stay ≥ `signalTimeframe` ≥ `entryTimeframe` for the "higher timeframe
filter" framing to make sense — this is not enforced by the code, only documented).

Swing/sweep/divergence/CHOCH detection all run on the **signal timeframe**. Retest and order
execution run on the **entry timeframe**. The HTF is consulted only for the trend filter (§2).

## 2. HTF trend filter (`htf-trend-filter.js`)

Computed once per **entry-timeframe bar**, from the latest fully-closed HTF candle as of that
bar (see ARCHITECTURE.md §4.2 — never a forming HTF candle).

Default conditions (all three required for a direction to be "allowed"), each individually
togglable via `htfFilter.requireXxx` flags so relaxed variants can be backtested:

- **LONG allowed** iff: `price > cloudTop` (Ichimoku Kumo) AND `tenkan > kijun` AND
  `kijunSlope > 0`.
- **SHORT allowed** iff: `price < cloudBottom` AND `tenkan < kijun` AND `kijunSlope < 0`.
- If neither condition holds (or Ichimoku reports `insufficient_history`), **no direction is
  allowed** — the strategy stays flat regardless of what the lower timeframes show. This is a
  hard veto, not a bias, per the spec's "NOT as the primary entry trigger... trend filter"
  framing.

**Kijun slope**: `kijun[current] - kijun[N bars ago]`, where `N = htfFilter.kijunSlopeLookback`
(default `3` HTF bars). Sign only is used (positive/negative/zero); zero counts as "no slope",
which fails both the LONG and SHORT slope conditions.

Uses `technical-analysis/ichimoku.js` unmodified (already implements the correct displacement
handling — see that file's own header comment).

## 3. Swing / pivot detection (`swing-detector.js`)

**Method: causal fractal.** A bar at index `i` is a confirmed **swing high** once bar
`i + swingLookback` has closed, if `high[i]` is strictly greater than `high[i-swingLookback..i-1]`
and `high[i+1..i+swingLookback]`. Swing low is the mirror image on `low`. Ties (equal highs) do
not count as a swing — strict inequality only, avoiding ambiguous double-counted pivots.

| Config key | Default | Meaning |
|---|---|---|
| `swingLookback` | `2` | Bars required on each side (a 5-bar fractal) |

A swing is **not visible to any other module** until its confirmation bar has closed. This is
the single mechanism that makes every downstream detector (sweep, CHOCH) automatically
lookahead-free, since they only ever query "confirmed swings as of bar `i`".

Smaller `swingLookback` = more, noisier swings, faster confirmation. Larger = fewer, more
significant swings, slower (more lag) confirmation. Explicitly called out for the sensitivity
sweep (§9).

## 4. Liquidity sweep (`liquidity-sweep-detector.js`)

Evaluated once per signal-timeframe bar, only while the state machine is `IDLE`.

**Bullish sweep** at bar `i` requires, using the most recent confirmed swing low `L`
(bar `j < i`, price `lowL`) within `sweepLookbackBars` of bar `i`:

1. `low[i] < lowL - lowL * sweepMinPenetrationPercent / 100` (meaningful penetration below the
   swing low — "trades below a significant previous swing low").
2. `close[i] > lowL` (closes back above the swept level, same bar).

Bearish sweep is the exact mirror using the most recent confirmed swing high.

| Config key | Default | Meaning |
|---|---|---|
| `sweepLookbackBars` | `50` | Max age (signal-timeframe bars) of the swing being swept |
| `sweepMinPenetrationPercent` | `0.05` | Minimum penetration below/above the level, as % of level price |

**Only same-bar reclaim counts** (both the sweep and the reclaim are properties of bar `i`'s own
O/H/L/C — this is a deliberate simplification; a sweep that penetrates on bar `i` but only
reclaims on bar `i+1` or later is, in this Phase 1 implementation, not detected as a sweep. This
is called out as a known limitation in IMPLEMENTATION_PLAN.md, not a hidden gap).

No "already used" tracking: if the same swing gets swept again later (a legitimate "double
sweep" SMC pattern), it can trigger a new sweep event. Simplification, documented as a Phase 2
refinement candidate.

## 5. RSI divergence (`rsi-divergence-detector.js`)

**Design decision (the most consequential ambiguity in the original spec):** "the divergence
must occur within a configurable maximum distance from the liquidity sweep" is implemented as:
the sweep bar's own extreme (its low, for a bullish sweep) **is** the "lower low" side of the
divergence comparison; the other side is the swept swing `L`'s bar. `maxDivergenceDistanceBars`
therefore bounds how far back swing `L` may be from the sweep bar (not a separate, later
divergence event) — i.e., it is the same value as (or a tighter bound than) `sweepLookbackBars`.

This mirrors how divergence indicators actually work in practice (e.g., TradingView's built-in
divergence tooling reads the oscillator value **at** algorithmically-detected price-pivot bars,
rather than independently re-pivoting the oscillator and then fuzzy-matching the two pivot sets).
It also keeps divergence and sweep resolvable at the *same* signal-timeframe bar close, which is
realistic (you know both simultaneously) while still being logged/tested as a distinct state
(`DIVERGENCE_CONFIRMED`) per the state-machine spec.

**Bullish divergence**: `RSI[sweepBar] > RSI[swingLowBar]` (price made a lower low, RSI made a
higher low). **Bearish**: `RSI[sweepBar] < RSI[swingHighBar]`.

| Config key | Default | Meaning |
|---|---|---|
| `rsiPeriod` | `14` | RSI lookback (reuses `technical-analysis/rsi.js`'s formula via `technicalindicators`) |
| `maxDivergenceDistanceBars` | `50` | Max bars between the sweep bar and the compared swing bar |

If RSI reports `insufficient_history` at either bar, the sweep is discarded (state machine
returns to `IDLE`) rather than waiting — more history won't retroactively fix a past bar's RSI
availability.

## 6. CHOCH / market structure (`market-structure.js`)

State: `WAITING_FOR_CHOCH`, entered immediately after `DIVERGENCE_CONFIRMED`.

**For LONG**: the target level is the most recent confirmed swing **high** with bar index before
(or equal to) the sweep bar. Each subsequent signal-timeframe bar, check whether that bar's
`close` (default) exceeds the level. First bar that does is the CHOCH bar.

**For SHORT**: mirror, using the most recent confirmed swing **low**.

| Config key | Default | Meaning |
|---|---|---|
| `chochConfirmationBasis` | `'close'` | `'close'` (conservative) or `'wick'` (high/low touch — noisier, faster) |
| `chochExpiryBars` | `30` | Max signal-timeframe bars to wait before the setup is invalidated |

If no confirmed opposing swing exists before the sweep bar (e.g., start of the data), the setup
is invalidated (back to `IDLE`) — there is nothing to break.

## 7. Retest & entry (`retest-detector.js`)

State: `WAITING_FOR_RETEST` (skipped entirely in `immediate` mode), entered after
`CHOCH_CONFIRMED`. Runs on the **entry timeframe** (finer-grained than CHOCH detection, which
runs on the signal timeframe) — the CHOCH level is a fixed price, evaluable at any granularity.

Three modes (`entryMode` config, default `'retest_confirmation'` — the spec's own stated
preference: *"Do NOT enter immediately after CHOCH unless a configurable option allows it...
Preferred entry: CHOCH → retracement → retest → confirmation → entry"*):

1. **`immediate`**: enters at the CHOCH bar's close; fills next entry-timeframe bar's open.
2. **`retest`**: waits (up to `retestExpiryBars`, entry-timeframe bars) for price to trade back
   into the retest zone — `[level × (1 − tolerance), level × (1 + tolerance)]` where
   `tolerance = retestTolerancePercent / 100`. First touch triggers entry; fills next bar's open.
3. **`retest_confirmation`** (default): same zone-touch detection, then additionally requires the
   *next* bar (within `confirmationExpiryBars`) to close as a rejection candle in the trade
   direction — defined as `close` on the correct side of the level AND `close` on the correct
   side of that same candle's own `open` (i.e., a same-direction candle, not just any close past
   the level). Entry fills the bar *after* that confirmation candle's open.

| Config key | Default | Meaning |
|---|---|---|
| `entryMode` | `'retest_confirmation'` | `'immediate'` \| `'retest'` \| `'retest_confirmation'` |
| `retestTolerancePercent` | `0.1` | Retest zone half-width, % of level price |
| `retestExpiryBars` | `40` | Max entry-timeframe bars to wait for a retest touch |
| `confirmationExpiryBars` | `10` | Max entry-timeframe bars to wait for the confirmation candle |

## 8. Execution model

- **Signal detection time**: the bar close at which the state machine reaches
  `ENTRY_TRIGGERED` (uses only that bar's own O/H/L/C).
- **Order submission time**: immediately after detection (simulated instantly — no network
  latency modeled, consistent with the existing backtest engine).
- **Order execution/fill time**: the *next* entry-timeframe bar's `open`, adjusted by
  `slippagePercent` unfavorably (matches `backtest-engine.js#simulateStrategy`'s exact
  convention: `fillPrice = open × (1 ± slippagePercent/100)`).
- **Fees**: `feePercent` applied to both entry and exit notional (matches existing engine).
- **Spread**: not modeled (no bid/ask in OHLC candle data) — `feePercent`/`slippagePercent`
  stand in for it, same limitation the existing engine already has and documents.
- **Same-bar SL+TP ambiguity**: stop-loss checked before take-profit (conservative), identical
  to the existing engine.

## 9. Stop-loss (`stop-loss.js`)

| Model | Formula (LONG) | Formula (SHORT) |
|---|---|---|
| `sweep_extreme` (default) | `sweepBar.low × (1 − slBufferPercent/100)` | `sweepBar.high × (1 + slBufferPercent/100)` |
| `atr` | `sweepBar.low − ATR(atrPeriod) × atrMultiplier` | `sweepBar.high + ATR(atrPeriod) × atrMultiplier` |

| Config key | Default |
|---|---|
| `slModel` | `'sweep_extreme'` |
| `slBufferPercent` | `0.05` |
| `atrPeriod` | `14` |
| `atrMultiplier` | `1.5` |

## 10. Take-profit (Phase 1: Model A only)

`TP = entry ± (entry − stopLoss) × riskRewardRatio`, sign per direction.

| Config key | Default |
|---|---|
| `riskRewardRatio` | `2` |

Models B (partial exits + breakeven) and C (ATR/structure trailing stop) are **not implemented**
in Phase 1 — see IMPLEMENTATION_PLAN.md's Phase 2 roadmap and ARCHITECTURE.md §6 for the
extension seam they'll plug into.

## 11. Position sizing & risk guards

Sizing reuses `risk/position-sizing.js` unmodified:
`qty = (equity × riskPerTradePercent/100) / |entry − stopLoss|`. No pip/contract-size step (N/A
for crypto — qty is directly in base-asset units, same as the rest of this app).

| Config key | Default | Enforcement |
|---|---|---|
| `riskPerTradePercent` | `0.5` | Position sizing input |
| `maxDailyLossPercent` | `3` | No new entries for the remainder of the UTC day once breached |
| `maxConsecutiveLosses` | `4` | No new entries until a winning trade resets the counter |
| `maxOpenTrades` | `1` | Phase 1 tracks exactly one open position at a time per run (single-symbol backtest) — this cap is enforced trivially but kept configurable for the Phase 2 multi-symbol runner |
| `minRiskRewardRatio` | `1.5` | Entry skipped if the actual computed R:R falls below this (guards Phase 2's variable-TP models; with Model A fixed-R this is trivially satisfied whenever `riskRewardRatio ≥ minRiskRewardRatio`) |

**Not implemented**: max exposure (meaningless for a single-symbol, ≤1-open-trade Phase 1
runner — becomes relevant once Phase 2 supports multiple concurrent symbols), max spread (no
bid/ask data, see §8).

## 12. Session filter (`session-filter.js`)

Pure predicate `isSessionAllowed(tsUtc, config)`. Disabled by default (`sessionFilter.enabled =
false` — crypto trades 24/7, this exists for experimentation, not because crypto needs it).

| Named preset | UTC hours |
|---|---|
| `asian` | 00:00–08:00 |
| `london` | 08:00–16:00 |
| `newYork` | 13:00–21:00 |

`sessionFilter.allowedSessions`: array of the above names, or a custom `{startHourUtc,
endHourUtc}`. `sessionFilter.excludeWeekends` (default `false` for crypto — unlike FX, crypto
doesn't close on weekends) and `sessionFilter.excludeFriday` (default `false`) are both available
and meaningful mainly for anyone deliberately mimicking FX-style low-liquidity avoidance.

## 13. State machine

```
IDLE → LIQUIDITY_SWEEP_DETECTED → DIVERGENCE_CONFIRMED → WAITING_FOR_CHOCH → CHOCH_CONFIRMED
     → [WAITING_FOR_RETEST →] ENTRY_TRIGGERED → POSITION_OPEN → POSITION_MANAGED → POSITION_CLOSED → IDLE
```

- `LIQUIDITY_SWEEP_DETECTED` → `DIVERGENCE_CONFIRMED` happens within the same bar-close
  evaluation (§5's design decision) but is modeled as two states for observability/logging and
  because Phase 2 may relax this coupling.
- `WAITING_FOR_RETEST` is skipped when `entryMode = 'immediate'`.
- Every `WAITING_FOR_*` state has an expiry window (bars); exceeding it returns the machine to
  `IDLE` and discards all setup state — a fresh sweep is required to restart the sequence. This
  is what makes "conditions may occur across multiple candles" concrete rather than aspirational.
- Only one setup (and, once open, one position) is tracked at a time per state-machine instance.
  A Phase 1 backtest runs exactly one instance per symbol.

## 14. Anti-lookahead checklist (cross-referenced against the original spec's §11 concerns)

| Concern | How it's addressed |
|---|---|
| Look-ahead bias | Every detector reads only `candles.slice(0, i+1)` or the confirmed-swings list (§3) |
| Future candle information | Candle fetch is bounded to `endUtc`; HTF/signal context uses `latestClosedCandleAsOf` |
| Repainting indicators | Ichimoku's displacement handling already fixed upstream (see `ichimoku.js`'s own comment); RSI/ATR are non-repainting by construction (fixed-formula, no future-dependent smoothing in this library) |
| Future-confirmed pivots used as historical | Swings are invisible until `i + swingLookback` bars close (§3) — enforced structurally, not by convention |
| Data leakage | Backtest fetch and simulation are two separate steps (`fetchHistoricalRange` then bar-by-bar loop); no train/test data ever shares a fetch call |
| Unrealistic execution | One-bar fill lag, next-bar open price, slippage/fees applied (§8) |
| Unrealistic spreads | Not modeled; documented as a real limitation, not silently assumed zero |
| Impossible fills | Position sizing checks `orderValue <= cash` before opening, mirroring the existing engine |

## 15. Sensitivity-analysis parameters (Phase 1 lite — see IMPLEMENTATION_PLAN.md §9)

`rsiPeriod`, `swingLookback`, `maxDivergenceDistanceBars`, `atrMultiplier`, `riskRewardRatio`,
`retestTolerancePercent`, `sweepMinPenetrationPercent`, `sessionFilter.enabled` — each swept
independently (1-D), holding all other parameters at their defaults, per the original spec's
explicit "do not optimize dozens of parameters simultaneously" / "prefer robust parameter
regions" guidance.
