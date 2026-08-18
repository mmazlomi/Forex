# Liquidity Sweep Reversal (LSR) — Implementation Plan

## Repository inspection summary (done before any code was written)

- **Language/runtime**: Node.js ≥ 22, CommonJS, no TypeScript, no build step.
- **Framework**: Express (thin routes → controllers → services → repositories layering).
- **Data**: `node:sqlite` (`DatabaseSync`), one `schema.js` with all `CREATE TABLE`s + additive
  migrations, one repository file per table/table-group.
- **Trading libraries**: `ccxt` (exchange access — KuCoin/CoinEx/Nobitex only, crypto),
  `technicalindicators` (RSI/ATR/Ichimoku/MACD/etc., already wrapped per-indicator in
  `src/services/technical-analysis/`).
- **Data format**: OHLCV candles, `{symbol, exchange, timeframe, tsUtc (open time, ms), open,
  high, low, close, volume}`, cached in the `candles` table, fetched/paginated via
  `src/services/backtesting/historical-data.js#fetchHistoricalRange`.
- **Broker/exchange integration**: crypto only, spot + futures (KuCoin-only futures), demo
  (simulated) and real (live) order placement, both already support `signalId`/strategy
  attribution (see the position-strategy-tracking work earlier in this session).
- **Existing backtesting**: `src/services/backtesting/backtest-engine.js` (single-timeframe,
  weighted-indicator score, buy-only) + `optimizer.js` (grid search over strategy × BUY/SELL
  threshold) + `metrics.js` (net P&L, drawdown, win rate, profit factor, avg win/loss).
- **Existing tests**: `node --test`, 315 passing at the start of this task, one file per
  concern, heavy use of `t.mock.method` on `marketDataService`/exchange clients rather than real
  network calls — this session's new tests follow that same convention.

Full detail in ARCHITECTURE.md and STRATEGY_SPEC.md. This file is the execution plan and the
Phase 2 roadmap.

## Ambiguities identified and resolved

See STRATEGY_SPEC.md for the full list with reasoning. Summary of the ones with real design
consequences:

1. **Forex vs. crypto** — resolved by explicit user choice: adapt to this app's existing crypto
   infrastructure, no new broker integration.
2. **"Divergence within a max distance from the sweep"** — resolved as: the sweep bar's own
   extreme *is* one side of the divergence comparison (§5 of STRATEGY_SPEC.md); the "distance" is
   how far back the compared swing may be, not a separately-timed later divergence event.
3. **Same-bar vs. multi-bar sweep reclaim** — resolved as same-bar only for Phase 1 (documented
   limitation, not silently assumed away).
4. **CHOCH confirmation basis** — resolved as close-based by default, wick-based as a
   configurable, faster/noisier alternative.
5. **Which take-profit models ship in Phase 1** — resolved as Model A (fixed R) only, by the
   user's own "Phase 1 core, rest as roadmap" scoping decision.
6. **Full walk-forward optimize-then-validate vs. a lighter robustness check** — resolved as the
   lighter version for Phase 1 (fixed parameters run across sequential out-of-sample windows, no
   in-loop re-optimization) specifically *because* the user's own overfitting-protection
   instructions favor this ("don't optimize dozens of parameters simultaneously", "prefer robust
   parameter regions") — a full per-window optimizer would need to be built carefully to avoid
   being exactly the overfitting risk the spec warns against, and is deferred to Phase 2 with that
   care.

## Phase 1 (this session) — scope and status

| # | Component | File(s) | Status |
|---|---|---|---|
| 1 | Docs | `docs/reversal-strategy/{ARCHITECTURE,STRATEGY_SPEC,IMPLEMENTATION_PLAN}.md` | done |
| 2 | Config | `src/services/reversal-strategy/config.js` | done |
| 3 | Swing detector | `.../swing-detector.js` | done |
| 4 | Liquidity sweep detector | `.../liquidity-sweep-detector.js` | done |
| 5 | RSI divergence detector | `.../rsi-divergence-detector.js` | done |
| 6 | CHOCH / market structure | `.../market-structure.js` | done |
| 7 | Retest / entry detector | `.../retest-detector.js` | done |
| 8 | HTF Ichimoku trend filter | `.../htf-trend-filter.js` | done |
| 9 | Session filter | `.../session-filter.js` | done |
| 10 | Stop-loss models | `.../stop-loss.js` | done |
| 11 | Take-profit (Model A) | `.../take-profit.js` | done |
| 12 | Risk guards | `.../risk-guards.js` | done |
| 13 | State machine | `.../state-machine.js` | done |
| 14 | Extended metrics | `src/services/backtesting/reversal-metrics.js` | done |
| 15 | Multi-timeframe backtest engine | `.../reversal-backtest-engine.js` | done |
| 16 | Walk-forward window splitter | `.../reversal-walk-forward.js` | done |
| 17 | Sensitivity sweep | `.../reversal-sensitivity.js` | done |
| 18 | Unit tests (one per module) | `tests/unit/reversal-strategy/*.test.js` | done |
| 19 | Integration test (full pipeline, synthetic data) | `tests/integration/reversal-backtest.test.js` | done |
| 20 | Real historical backtest attempt | see Final Report | done |

*(This table is filled in as "done" retroactively once each step completes — see the chat
transcript / final report for the actual order and any deviations.)*

## Phase 2 (this session, by explicit user request) — live execution wiring

Requested after Phase 1's backtest report came back unprofitable (see BACKTEST_REPORT.md) — the
user chose to wire up live trading anyway rather than backtest further first. Built:

| # | Component | File(s) | Status |
|---|---|---|---|
| 1 | Strategy id validation (accepts LSR without routing it through scoring) | `src/services/signals/strategies.js` (`resolveStrategyId`, `EXTENDED_STRATEGY_IDS`) | done |
| 2 | Strategy dropdown API (futures-only) | `signals-controller.js#getStrategies` (`?market=futures`), `api.js`, `futures.js` | done |
| 3 | `addAsset`/`setStrategy` validation uses the new resolver | `futures-controller.js` | done |
| 4 | Live per-asset persistent state machine driver | `src/services/reversal-strategy/live-engine.js` | done |
| 5 | `cancelEntry()` on the state machine (live-only: a triggered entry can be rejected, unlike a deterministic backtest fill) | `state-machine.js` | done |
| 6 | `notifyPositionOpened()` made defensive against a null `setup` (live DB-truth resync can call it on a fresh machine) | `state-machine.js` | done |
| 7 | Live scheduler (entries only — exits reuse the existing generic watcher) | `src/services/scheduler/reversal-auto-trader.js` | done |
| 8 | `futures-auto-trader.js` skips LSR-tagged assets | `futures-auto-trader.js#processAsset` | done |
| 9 | Server startup wiring | `server.js` | done |
| 10 | Tests (live-engine + scheduler) | `tests/unit/reversal-strategy/live-engine.test.js`, `tests/integration/reversal-auto-trader.test.js` | done |
| 11 | End-to-end browser/API verification | see "Phase 2 verification" below | done |

### Design decisions specific to Phase 2

- **Futures only, not spot.** LSR trades both directions; spot has no shorting. The Strategy
  dropdown only offers LSR when `?market=futures` is passed — `dashboard.js` (spot) never passes
  it, so LSR is structurally unreachable from the Spot Watchlist, not just discouraged.
- **LSR is deliberately excluded from `strategies.js#listStrategies()`** (the function
  `optimizer.js`/`strategy-selector.js` default their real-backtest candidate set to) — scoring it
  as a weighted config would silently fall back to "balanced" and corrupt strategy-selector's
  ranking. It's appended to the API response only, in `signals-controller.js`, and validated for
  storage via a separate `resolveStrategyId()` that recognizes it without ever calling
  `getStrategy()`. `futures-auto-trader.js#processAsset` has an explicit early-return guard so an
  LSR-tagged asset is never scored via `generateSignal()`/`generateCombinedSignal()` either.
- **State persistence is in-memory only**, one `createReversalStateMachine` instance per (mode,
  userId, symbol, exchange), held in a Map for the life of the Node process. A setup that's
  mid-sequence (e.g. `WAITING_FOR_CHOCH`) is **lost on server restart** — the machine just starts
  fresh at `IDLE`. This is safe (worst case: one missed signal, never a duplicate or wrong entry)
  but is a real limitation: an LSR asset effectively "forgets" everything it was tracking every
  time the server restarts. Phase 3 candidate: persist `setup` to a new DB table and rehydrate on
  boot.
- **Position exits reuse the existing generic `position-risk-watcher.js` unmodified** — every open
  futures position, regardless of which strategy or scheduler opened it, already gets its
  stop-loss/take-profit checked against live price every cycle and closed automatically. This
  scheduler never needed its own exit logic (no Take-Profit Model B/C wiring either — Phase 1's
  Model A stop/take levels are what get monitored).
- **Position lifecycle is resynced from DB truth every cycle**, not trusted from the machine's own
  prior-cycle bookkeeping (`live-engine.js#processLiveCycle`) — the machine has no way to
  otherwise learn that `position-risk-watcher.js` (a different scheduler entirely) closed a
  position, or that an order it triggered was rejected by the live risk pipeline
  (`validateTrade`, insufficient balance, exchange error). This is also why `cancelEntry()` had to
  be added: Phase 1's backtest fills are always deterministic, so this failure mode never existed
  there.
- **A real bug this uncovered**: the live engine's first draft processed ALL newly-closed signal
  bars in one pass, then ALL newly-closed entry bars in a second pass. That corrupts
  `retestWaitStartIndex` (anchored to whichever entry-bar index happens to be current when
  `CHOCH_CONFIRMED` is first observed) — since the signal pass ran to completion first, CHOCH
  looked like it happened at entry-bar index 0 instead of the real, much-later index, so
  `retestExpiryBars` expired the setup almost immediately. Fixed by interleaving (catch up signal
  bars closed as of each entry bar's own close time, inside the entry-bar loop) — exactly matching
  how `reversal-backtest-engine.js` already did it correctly from the start. Caught by
  `live-engine.test.js`'s single-cycle full-scenario test, which is why that test exists.
- **Position sizing goes through the existing account-level risk pipeline**
  (`validateTrade`/`futuresRiskSettingsRepository`, the same one every other strategy's live
  orders already use), not LSR's own `riskPerTradePercent`/`computePositionSize` (those stay
  backtest-only) — this keeps the Risk Settings UI meaningful and uniform across every strategy a
  user might run live, rather than LSR silently using a different risk% than what's configured.
- **`asset.default_timeframe` (the per-asset Timeframe dropdown) has no effect on an LSR asset** —
  its three timeframes come from `config.js`'s `DEFAULT_CONFIG` (4h/15m/5m), not from that field.
  The Watchlist row still shows the dropdown (no UI change was made to hide it for LSR rows); it's
  simply inert. Noted here rather than building a 3-timeframe config UI for Phase 2.

### Phase 2 verification performed

- Full test suite: 431/431 passing (422 after Phase 1 + 9 new for live-engine/scheduler), zero
  regressions.
- Booted the real server, signed up, confirmed `GET /api/strategies` excludes LSR and
  `GET /api/strategies?market=futures` includes it.
- Added a real `BTC/USDT:USDT` demo futures asset with `strategyId: "liquidity-sweep-reversal"`
  via the actual `POST /api/futures/assets` endpoint, confirmed it persisted correctly, enabled
  auto-trade via `PUT .../auto-trade`.
- Manually invoked `reversalAutoTrader.runCycle()` against that real asset with real KuCoin market
  data (network-backed, not mocked) — completed with `{ evaluated: 1, demoEvaluated: 1,
  realEvaluated: 0 }` and no error.
- Confirmed `futuresAutoTrader.getStatus()`/`reversalAutoTrader.getStatus()` both report cleanly
  with the LSR asset in place, and that `futures-auto-trader.js` genuinely never calls
  `generateSignal()` for it (asserted directly in `reversal-auto-trader.test.js`).

### What Phase 2 explicitly did NOT change

- No new DB columns/tables (LSR positions/orders use the exact same `demo_futures_positions`/
  `demo_futures_orders` schema as every other futures strategy — `source: 'auto'` and
  `strategy_id: 'liquidity-sweep-reversal'` on the originating asset are what identify them).
- No UI changes beyond the Strategy dropdown now listing one more option on the Futures Watchlist
  — no dedicated LSR panel, no way to view/tune its 4h/15m/5m config or in-flight state machine
  state from the browser.
- Take-Profit Models B/C, multi-symbol portfolio awareness, and state persistence across restarts
  remain unbuilt — see the (still-current) "Explicitly out of scope" list below, which now
  describes the Phase 3 backlog rather than Phase 2.

## Spot Phase (this session, by explicit user request) — CRYPTO SPOT MODE

Requested after Phase 2 (futures live wiring) shipped — the user asked for the same strategy to
also trade spot, long-only, with an extensive "production-grade execution engine" spec
(correlation filters, BTC regime filter, volatility filter, exchange precision/dust/partial-fill
handling, kill switch, restart reconciliation, trailing stops, etc.). A repo survey found most of
that already exists and is reused as-is (the 10-step risk pipeline, position sizing, and the
generic `position-risk-watcher.js` SL/TP exit monitor already work for any spot position
regardless of strategy) — what's genuinely missing (precision/dust/partial-fill handling, fee
modeling, correlation/regime/volatility portfolio filters, kill switch, restart reconciliation,
trailing stops) is a pre-existing, cross-cutting gap affecting every strategy in the app, not
something specific to add for LSR. By explicit user choice, this session scoped to **Spot Phase
core**: wire LSR into the existing spot pipeline exactly like the futures wiring, long-only,
real-money-capable (gated like futures), and left the cross-cutting infrastructure as a
documented backlog (now folded into "Phase 3 backlog" below alongside the futures-side gaps).

| # | Component | File(s) | Status |
|---|---|---|---|
| 1 | `real_auto_trade_enabled` column (spot's own explicit Real opt-in, separate from the existing Demo-only `auto_trade_enabled`) | `schema.js` (`migrateAddRealAutoTradeColumn`), `assets-repository.js` | done |
| 2 | `resolveStrategyId` fix in spot's `addAsset`/`setStrategy` (same bug class futures had) | `assets-controller.js` | done |
| 3 | `PUT /api/assets/:symbol/real-auto-trade` endpoint | `assets-controller.js`, `assets-routes.js` | done |
| 4 | `ENABLE_SPOT_AUTO_TRADING` gate (mirrors `ENABLE_FUTURES_AUTO_TRADING`) | `config/config.js` | done |
| 5 | `live-engine.js` parameterized for `market: 'spot'\|'futures'` (was hardcoded futures) | `reversal-strategy/live-engine.js` | done |
| 6 | Long-only spot scheduler (discards bearish decisions, calls `placeDemoOrder`/`placeRealOrder`) | `scheduler/reversal-spot-auto-trader.js` | done |
| 7 | Guard in the existing generic spot `auto-trader.js` skipping LSR-tagged assets | `scheduler/auto-trader.js` | done |
| 8 | Server startup wiring | `server.js` | done |
| 9 | Strategy dropdown now includes LSR for spot too (was futures-only) | `signals-controller.js#getStrategies` | done |
| 10 | "Real Auto-Trade" checkbox column on the Spot Signals Setting table | `public/index.html`, `public/js/dashboard.js`, `public/js/api.js` | done |
| 11 | Tests (scheduler + guard + real/demo opt-in separation) | `tests/integration/reversal-spot-auto-trader.test.js` | done |

### Design decisions specific to the Spot Phase

- **Long-only is enforced in the execution adapter, not the strategy engine.** `live-engine.js`
  still emits `{direction: 'bullish'|'bearish', ...}` regardless of market — exactly the
  "strategy engine must not know whether it's trading Spot or Futures" principle from the
  request. `reversal-spot-auto-trader.js` is the ONLY place that discards a `'bearish'` decision;
  `reversal-auto-trader.js` (futures) still executes both. This also means the same live engine
  instance-per-asset design, the same detector modules, and the same backtest engine are shared
  unmodified — only the two schedulers differ, plus the one-line `market` parameter threaded
  through `live-engine.js`.
- **Spot has one shared watchlist (`assets`), not futures' demo/real table split** — so real-mode
  eligibility needed its own explicit per-asset flag (`real_auto_trade_enabled`) rather than a
  second table. This preserves the same safety property futures has (a symbol must be
  *deliberately* opted into real trading, separate from Demo) without the larger, riskier schema
  change of splitting the shared table (which would also touch every other strategy, the
  Watchlist UI, `promoteToSignalsSetting`, and more — well beyond this feature's scope).
- **No new exchange-precision, partial-fill, dust, or fee-modeling infrastructure was added** —
  spot LSR orders go through `demo-orders.js`/`real-orders.js` exactly as every other spot
  strategy's orders always have, with the same pre-existing gaps (see the Phase 3 backlog below).
  This was an explicit scope choice, not an oversight — see the repo survey referenced in the
  chat transcript for the full list of what's missing app-wide, not just for LSR.
- **No trailing stop, no partial take-profit** — Take-Profit Model A (fixed R) is what spot LSR
  positions use too, monitored by the same generic `position-risk-watcher.js` that already
  handles every spot position's SL/TP. Same Phase 3 backlog item as futures.
- **`MARKET_MODE = SPOT` from the request maps to `market: 'spot'`** threaded through
  `live-engine.js`/`processLiveCycle` — there's no separate spot-specific config object; the
  existing `reversal-strategy/config.js` (timeframes, RSI period, swing lookback, etc.) is shared
  by both markets, since none of it is inherently futures-specific (no leverage/liquidation
  fields exist in that config to begin with).

### Spot Phase verification performed

- Full test suite: 442/442 passing (431 after Phase 2 + 11 new for the spot scheduler), zero
  regressions.
- Confirmed the existing 10 spot `auto-trader.test.js` tests still pass unmodified after adding
  the LSR-skip guard (same file, same assertions, no behavior change for non-LSR assets).
- Confirmed `assets-routes.test.js`/`config.test.js` still pass after the schema/config additions.

## Explicitly out of scope (Phase 3 backlog — both Spot and Futures)

- **Take-Profit Model B** (partial exits at 1R/2R + breakeven stop move) and **Model C** (ATR /
  structure trailing stop) — the position-management hook exists (ARCHITECTURE.md §6) but only
  Model A is implemented.
- **Full walk-forward optimization** (train → grid-search-optimize → validate → out-of-sample,
  repeated per rolling window) — Phase 1 ships the window-splitting + fixed-parameter-per-window
  version only. Adding in-loop optimization safely (without reintroducing the overfitting risk
  the spec warns about) needs its own design pass: which metric to optimize per window, how many
  parameters, and mandatory reporting of in-sample vs. out-of-sample degradation.
- **Multi-parameter joint sensitivity (heatmaps)** — Phase 1 ships 1-D sweeps only, one parameter
  at a time, per the spec's own anti-overfitting guidance. 2-D heatmaps (e.g., RSI period ×
  swing lookback) are a reasonable Phase 3 addition if 1-D sweeps show promising individual
  regions worth cross-checking.
- **News filter** — hook point documented (ARCHITECTURE.md §6), not implemented (no news data
  source exists in this app).
- **Spread modeling** — not possible from OHLC-only historical data; would need a bid/ask data
  source this app doesn't have.
- **Multi-symbol / portfolio-level backtesting** — Phase 1 runs one symbol per backtest call
  (matching every other backtest capability already in this app). `maxOpenTrades`/`maxExposure`
  config exists but is trivial at 1 symbol.
- **Live state persistence across server restarts** — Phase 2's per-asset state machine is
  in-memory only (see Phase 2's design decisions above); a mid-sequence setup is silently
  discarded on restart rather than resumed.
- **Dedicated LSR UI** — no way to view/tune its 4h/15m/5m timeframes, session filter, or in-flight
  state-machine state from the browser; the Strategy dropdown listing it (Phase 2) is the only
  frontend surface it has.
- **Exchange precision/step-size/min-notional normalization** — confirmed absent for EVERY
  strategy's live order placement in this app (`demo-orders.js`/`real-orders.js`,
  `futures-demo-orders.js`/`futures-real-orders.js`), not just LSR. Orders are placed with raw
  floating-point qty computed by the risk pipeline; ccxt's `market.precision`/`market.limits` are
  never consulted. A genuinely cross-cutting fix, not an LSR-specific one.
- **Partial-fill tracking** — confirmed absent app-wide: every order path assumes requested qty
  == filled qty. A market order's actual `filled`/`remaining` from the exchange response is never
  read; positions are opened at the originally-computed size regardless.
- **Fee/maker-taker modeling in LIVE orders** — confirmed absent app-wide (the backtest engines
  model `feePercent`/`slippagePercent`; live order placement does not apply either).
- **Correlation filter, BTC market-regime filter, ATR-based volatility filter** — confirmed absent
  anywhere in this app, portfolio-wide or per-strategy. `htf-trend-filter.js`/`session-filter.js`
  gate LSR's own entries but are not the portfolio-level risk controls the spec described.
- **Kill switch / restart reconciliation** — `emergency-stop-repository.js` only blocks new order
  submission; it never queries the exchange to reconcile actual positions/balances on restart.
  Confirmed no such reconciliation exists anywhere in this app (LSR's own in-memory state-machine
  loss on restart, noted above, is one symptom of this broader gap).
- **Liquidity/market-quality filter** (spread, order-book depth, estimated slippage) — not
  implemented; only 24h volume is visible via existing market-data snapshots, and no per-trade
  pre-execution liquidity check exists anywhere in this app.

## Verification performed after implementation

1. `node --test tests/unit/reversal-strategy/` — every detector's causality/correctness in
   isolation, including deliberately adversarial "does NOT trigger on this future-dependent
   pattern" cases.
2. `node --test tests/integration/reversal-backtest.test.js` — full pipeline against synthetic,
   hand-constructed OHLCV data engineered to contain exactly one valid LSR setup, asserting the
   state machine reaches `POSITION_CLOSED` with the expected entry/SL/TP/fill prices, and a
   separate case with a decoy pattern (sweep without divergence) asserting **no** trade fires.
3. `node --test` (full suite) — confirms zero regressions in the other 315 pre-existing tests.
4. A real historical backtest attempt against a live-fetched crypto symbol (network permitting)
   — see the final report for whether the sandbox had outbound network access and what, if
   anything, it produced.
5. A manual re-read of every detector for the specific failure modes listed in STRATEGY_SPEC.md
   §14 (the anti-lookahead checklist), cross-checked line by line.

## Honesty commitment (per the user's explicit instruction)

No parameter in Phase 1 was tuned to make a demonstration backtest look better — defaults are
the STRATEGY_SPEC.md values chosen from the spec's own preferences (e.g., "preferred entry:
retest + confirmation") or standard technical-analysis conventions (RSI 14, 5-bar fractal),
before any backtest was run. If a real-data backtest is included in the final report, its result
is reported as-is, including if it is unprofitable, low-sample-size, or otherwise inconclusive —
Phase 1's job is to prove the machinery is correct and lookahead-free, not to find a profitable
parameter set.
