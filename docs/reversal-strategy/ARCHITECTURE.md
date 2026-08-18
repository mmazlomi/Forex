# Liquidity Sweep Reversal (LSR) — Architecture

Strategy id: `liquidity-sweep-reversal`. Display name: **Liquidity Sweep Reversal (LSR)**.

This document covers only the new subsystem added for this strategy. For the rest of the app
(existing crypto spot/futures trading, signals, orders, portfolios) see `docs/architecture.md`,
which this document does not repeat or modify.

## 0. Why this isn't bolted onto the existing `signals`/`strategies.js` system

The existing strategy system (`src/services/signals/strategies.js` + `scoring-engine.js`) is a
**per-candle weighted score**: one timeframe, one indicator-weighted number per bar, long-only
(spot has no short concept), stateless (no memory of prior bars beyond indicator warm-up).
`src/services/backtesting/backtest-engine.js#simulateStrategy` is built directly on top of that
shape (`computeSignal` called fresh each bar).

LSR is structurally different: it is a **stateful, multi-timeframe, multi-bar sequence**
(sweep → divergence → CHOCH → retest → entry) that can take many bars to resolve, and trades
both directions. Forcing it through `computeSignal`/`simulateStrategy` would mean either
faking statefulness through closures smuggled into a "config" object (fragile, hard to test) or
rewriting the existing engine's execution contract (which several other tests and the live
optimizer depend on). Both are worse than a small, parallel, purpose-built module family that
reuses everything reusable (indicators, candle fetching, position sizing, metrics primitives) and
duplicates only the orchestration loop.

## 1. Why "Forex bot" became a crypto strategy

This repository has no Forex broker integration, no pip/lot/contract-size math, and no FX data
source anywhere (`src/services/exchanges/exchange-client-factory.js` only registers KuCoin/
CoinEx/Nobitex crypto clients). Per explicit user decision, LSR is implemented against this
app's existing crypto market data/exchanges instead of building a second, disconnected broker
integration. Consequences:

- "Pip value" / "contract size" position sizing → replaced by the same
  `risk% × equity ÷ |entry − stopLoss|` sizing already used everywhere else in this app
  (`src/services/risk/position-sizing.js`, reused as-is).
- "Spread filter" → **not implemented**. OHLC candle data has no bid/ask; this app's existing
  backtest engine already substitutes `feePercent` + `slippagePercent` for that reality, and LSR
  does the same (see §8).
- "London/NY/Asian session" → implemented as a generic, named UTC-hour-range filter
  (`session-filter.js`) since crypto trades 24/7 and these labels are just conventional hour
  windows — useful for testing whether restricting to historically FX-liquid hours changes
  results on crypto pairs too, but not a strict requirement.
- Long AND short are both implemented (crypto futures support both directions natively via this
  app's existing `demo_futures_*`/`real_futures_*` tables — the backtest engine below trades on
  the futures side conceptually, i.e., it does not require holding an asset to short it).

## 2. Directory layout

```
src/services/reversal-strategy/     Pure detection/orchestration logic. No network, no DB.
  config.js                          DEFAULT_CONFIG + validateConfig() — every tunable in one place
  swing-detector.js                  Causal fractal swing high/low detection
  liquidity-sweep-detector.js        Bullish/bearish sweep over confirmed swings
  rsi-divergence-detector.js         RSI-at-swing-point divergence check
  market-structure.js                CHOCH (break of most recent confirmed opposing swing)
  retest-detector.js                 3 entry modes: immediate / retest / retest+confirmation
  htf-trend-filter.js                Ichimoku-based HTF trend filter (reuses technical-analysis/ichimoku.js)
  session-filter.js                  Named UTC session windows + weekday exclusion
  stop-loss.js                       sweep_extreme / atr stop-loss models
  take-profit.js                     Model A: fixed R multiple (see IMPLEMENTATION_PLAN.md for B/C)
  risk-guards.js                     Max daily loss / consecutive losses / open trades
  state-machine.js                   Orchestrates all of the above across bars, with expiry windows
  index.js                           Barrel export + createReversalEngine() factory

src/services/backtesting/
  reversal-metrics.js                 Extended metrics (Sharpe/Sortino/expectancy/recovery factor/
                                       long-short + monthly + session breakdowns) — additive, wraps
                                       the existing metrics.js#computeMetrics rather than editing it
  reversal-backtest-engine.js         Multi-timeframe, no-lookahead backtest runner
  reversal-walk-forward.js            Sequential out-of-sample window splitter
  reversal-sensitivity.js             1-D parameter sweep utility

tests/unit/reversal-strategy/         One file per detector module
tests/integration/                    reversal-backtest.test.js, reversal-walk-forward.test.js,
                                       reversal-sensitivity.test.js
```

Nothing in `src/routes`, `src/controllers`, `public/` is touched in Phase 1 — this is a
backtesting/research module only, invoked programmatically (script or test), not yet wired to
any HTTP endpoint or the live auto-trader. See IMPLEMENTATION_PLAN.md §Phase 2 for that wiring.

## 3. Data flow (single backtest run)

```
reversal-backtest-engine.runReversalBacktest(args)
  │
  ├─ fetchHistoricalRange() × 3   (HTF 4h, signal 15m, entry 5m — existing historical-data.js, unmodified)
  │
  ├─ for each entry-timeframe (5m) bar, in order:
  │     ├─ resolve "as of this bar" HTF/signal-timeframe context = latest candle on that
  │     │   timeframe whose OWN close time <= this bar's open time (see §4 — no lookahead)
  │     ├─ htf-trend-filter.evaluate(htfCandles-as-of-now)   -> allowed direction(s) or 'none'
  │     ├─ state-machine.onBar(bar, context)                  -> possibly advances state, possibly
  │     │                                                          emits an ENTRY_TRIGGERED event
  │     ├─ if a position is open: check SL/TP against this bar's high/low (existing engine's
  │     │   SL-before-TP-in-same-bar convention, see §5)
  │     └─ if ENTRY_TRIGGERED emitted last bar: fill at *this* bar's open (one-bar execution lag,
  │         same convention as the existing spot backtest-engine.js)
  │
  └─ reversal-metrics.computeExtendedMetrics(trades, equityCurve) -> full report
```

## 4. No-lookahead guarantees (see also STRATEGY_SPEC.md §"Anti-lookahead checklist")

1. **Swing confirmation lag**: a fractal swing at bar `i` (using `swingLookback = N` bars each
   side) is only added to the "confirmed swings" list once bar `i + N` has closed. Every detector
   downstream (sweep, CHOCH) only ever reads from that confirmed list — never a provisional
   in-progress pivot.
2. **Multi-timeframe alignment**: `latestClosedCandleAsOf(candles, timeframeMs, atTsUtc)` returns
   the last HTF/signal-timeframe candle whose `tsUtc + timeframeMs <= atTsUtc`. A still-forming
   or future higher-timeframe candle is never visible to a lower-timeframe bar.
3. **Execution lag**: a signal decided using bar `i`'s own O/H/L/C only ever fills at bar `i+1`'s
   open (with slippage) — identical convention to the existing `backtest-engine.js`. No fill ever
   uses information from the bar that produced the signal beyond that bar's own closed OHLC.
4. **RSI/ATR/Ichimoku windows**: every indicator call is passed `candles.slice(0, i + 1)` — the
   same "windowed recomputation" pattern `backtest-engine.js#simulateStrategy` already uses —
   never the full array with a later index picked out.
5. **Candle fetch range**: HTF/signal/entry candles are all fetched only up to `endUtc`; no
   candle with `tsUtc > endUtc` is ever loaded into the backtest.

These are also exercised directly by unit tests (see `tests/unit/reversal-strategy/*` and
`tests/integration/reversal-backtest.test.js`'s "no-lookahead" cases).

## 5. Fill/exit conservatism (shared with the existing engine)

Same-bar SL and TP: if a bar's low touches the stop-loss AND its high touches the take-profit,
the true intrabar order is unknowable from OHLC data alone. Like the existing engine, LSR checks
stop-loss first (the conservative assumption — better to under-report than over-report edge in a
backtest). Documented, not hidden.

## 6. Extension seams for Phase 2

- `state-machine.js`'s `POSITION_MANAGED` state calls a single `managePosition(position, bar,
  config)` hook every bar — Phase 2 partial-exit/trailing-stop models (Take-Profit Models B/C)
  plug in here without touching the state transitions above it.
- `reversal-backtest-engine.js` and a hypothetical `reversal-live-engine.js` (Phase 2, wiring into
  `futures-demo-orders.js`/`futures-real-orders.js`) are meant to share every module under
  `src/services/reversal-strategy/` — only the "what happens when ENTRY_TRIGGERED fires" and
  "where do candles come from" edges differ (backtest: in-memory arrays + simulated fills; live:
  `market-data-service.js` + `placeDemoFuturesOrder`/`placeRealFuturesOrder`).
- `session-filter.js` exposes a single `isSessionAllowed(tsUtc, config)` predicate — a Phase 2
  news filter (spec §10, "architecture so a news filter can be added later") is meant to be a
  sibling predicate (`isNewsBlackoutActive(tsUtc, config)`) combined with `&&`, not a rewrite of
  this one.
