# Test Report

**Execution date:** 2026-08-08
**Environment:** Debian GNU/Linux 13 (trixie), Linux 6.12.95+deb13-amd64, x86_64
**Node.js version:** v24.18.0
**npm version:** 11.16.0
**Test tool:** Node.js built-in test runner (`node --test`)

## Why the built-in test runner

No extra dependency needed (`node --test` ships with Node ≥18, stable since Node 20), zero
install friction, built-in `assert`/`mock` modules cover everything this project needs
(assertions, spies/stubs for network-dependent code). Consistent with the project's broader
"avoid unnecessary dependencies and native-build friction" theme established in Phase 1
(rejecting `node-talib`) and Phase 3 (`node:sqlite` over `better-sqlite3`). Jest/Vitest were
considered but add a dependency for no capability this project actually needs at its current
size.

## How to run

```bash
npm test
```

Every integration/security test that touches the database uses an in-memory SQLite instance
(`DATABASE_PATH=:memory:`, wired via `tests/fixtures/test-server.js`), and `node --test` runs
each test *file* in its own process — so tests never touch `data/trading-bot.sqlite` and don't
leak state between files. This per-file process isolation is also what lets several
env-var-frozen-at-boot scenarios (`ENABLE_LIVE_TRADING`, `ENABLE_FUTURES_AUTO_TRADING`,
per-exchange `.env` credentials) each get their own dedicated file rather than fighting over a
single shared `config` object. Tests that would otherwise depend on live network calls (exchange
market data, live order placement, CoinGecko, KuCoin/Nobitex REST calls) use `node:test`'s
built-in `mock.method()` to stub the relevant service function, per the "Real Trading with mocked
testing" requirement — the automated suite runs fully offline and deterministically.

## Results

| Metric | Value |
|---|---|
| Total tests | 290 |
| Passed | 290 |
| Failed | 0 |
| Test files | 43 |
| Duration | ~52s |

```
ℹ tests 290
ℹ suites 0
ℹ pass 290
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## Coverage by area

### Unit tests — technical analysis & scoring

| File | What it covers |
|---|---|
| `tests/unit/technical-analysis.test.js` | SMA/RSI/MACD/Bollinger/ATR/Ichimoku/Support-Resistance/Volume correctness, `insufficient_history` gating per indicator, empty-input safety, and an Ichimoku-specific regression: the cloud must read `displacement` (26) bars back rather than the naive "latest computed spanA/spanB" |
| `tests/unit/scoring-engine.test.js` | Final Score formula, BUY/SELL/HOLD/NO_DATA status logic, the "never fabricate — refuse when fundamentals unavailable and weight > 0" rule, HOLD downgrade when ATR is unavailable to size a stop-loss, and that the Ichimoku cloud position actually moves `technicalScore` (price above vs. below the cloud) |
| `tests/unit/signals-combine.test.js` | Multi-strategy majority-vote combination: 2-of-3/2-of-2/3-of-3 agreement, 1-1 and 1-1-1 ties resolving to HOLD with null entry/stop/take (never trades on ambiguity), representative fields taken from the agreeing strategy with the strongest `|finalScore|`, all-NO_DATA propagating as NO_DATA rather than a manufactured HOLD |
| `tests/unit/candle-validator.test.js` | Every rejection rule (non-finite, high/low bounds, negative volume, non-monotonic/duplicate timestamps) and gap-detection-as-warning |

### Unit tests — risk & position sizing

| File | What it covers |
|---|---|
| `tests/unit/risk.test.js` | Position-sizing formulas; all steps of the risk-validation pipeline (emergency stop, live-trading gate, data quality/staleness, invalid stop-loss, risk/reward minimum, order-size clamping to `maxOrderValue`, exchange minimum, max positions, max daily loss, max exposure, insufficient balance, duplicate order, caller-supplied `qtyOverride` sizing/rejection); a float-precision regression where a genuinely-1.5 risk/reward ratio computed as `1.4999999999999791` was wrongly rejected (mirrors a real GRAM/USDT signal) |
| `tests/unit/futures-risk.test.js` | Leverage's effect on `validateTrade`: omitted leverage is byte-for-byte identical to spot behavior; leverage reduces `requiredMargin` (notional `orderValue` unchanged) and lets trades pass that would fail unleveraged; the max-order-value and exposure clamps stay notional-based and leverage-independent; `marginUsed` (not notional exposure) is what offsets balance for existing positions; the insufficient-balance message only mentions margin/leverage when `leverage > 1` |
| `tests/unit/liquidation-estimate.test.js` | Long liquidation sits below entry / short liquidation sits above entry; higher leverage narrows the distance to liquidation; `isStopLossSafeFromLiquidation` requires the stop strictly on the safe side for both long and short, and passes through as safe when no liquidation price is available |

### Unit tests — exchange adapters & market data

| File | What it covers |
|---|---|
| `tests/unit/nobitex-exchange.test.js` | Hand-written Nobitex REST adapter (no ccxt support exists): live `/market/stats`-derived market list including multiplier-prefixed tokens (`1M_BTT`) and closed-market `active:false`; Rial↔Toman conversion (÷10) on tickers, OHLCV, orders, and balances; `mark`-price fallback when `latest` is `"0"`; `last: null` (never fabricated `0`) when both are unavailable; market vs. limit order flows incl. partial-fill rejection and status-vocabulary mapping (Active/Done/Canceled → open/closed/canceled); auth-token requirement enforced before any network call |
| `tests/unit/kucoin-futures-capability.test.js` | Asserts the installed ccxt `kucoinfutures` class actually has the capabilities the app depends on (swap/future support, `fetchPositions`, `setLeverage`, `setMarginMode`, `createOrder`, `fetchBalance`) — a dependency-assumption check, not app code, after Bybit proved unreachable in production |
| `tests/unit/historical-data-market-routing.test.js` | `fetchHistoricalRange`'s `market` param routes to `getPublicExchange` (spot, default/explicit) vs. `getPublicFuturesExchange` (`market: 'futures'`), added to support futures backtesting via the strategy selector |
| `tests/unit/symbol-list-service.test.js` | `getSymbolsForExchange` ranking: preferred quotes (USDT/USD/USDC) rank above other quotes; digit-leading symbols (Nobitex-style multiplier tokens) sort after letter-leading ones but quote-priority still wins first; inactive/closed and non-spot markets are excluded |
| `tests/unit/charts-tv-mapping.test.js` | Pure logic extracted from browser-only `public/js/charts.js`: `hasTradingViewMapping` is true for the curated ccxt exchange list, false for Nobitex (no reliable per-symbol TradingView coverage, chart falls back rather than risking a blank widget), true for stocks regardless of exchange; `mapToTradingViewSymbol`/`mapTimeframeToTvInterval` correctness |
| `tests/unit/coingecko-id-resolution.test.js` | `resolveCoinId` picks the exact-ticker match with the best market-cap rank, returns `null` (never fabricates) with no match, and caches; regression test for a real bug where the app guessed a CoinGecko id by lowercasing the ticker instead of resolving the actual slug (`bitcoin`, not `btc`), which silently made every crypto fundamental field show "unavailable" |

### Unit tests — scheduler trigger logic

| File | What it covers |
|---|---|
| `tests/unit/pending-orders-watcher.test.js` | `checkFillCondition`'s pure trigger-direction logic for limit buy/sell, stop-market buy/sell, and stop-limit orders, including exact boundary prices, fill-price-vs-trigger-price distinctions, and an unrecognized order type failing closed (never fills) |
| `tests/unit/position-risk-watcher.test.js` | `checkSpotTrigger`/`checkFuturesTrigger`'s pure trigger-direction logic: spot long-only stop-loss/take-profit boundaries, futures long same-direction-as-spot, futures short with inverted stop-loss/take-profit (the direction most likely to be gotten backwards), and stop-loss winning the tie-break if both conditions somehow hold at once |

### Unit tests — config & security primitives

| File | What it covers |
|---|---|
| `tests/unit/config.test.js` | PORT parsing/defaulting/non-numeric rejection; `ENABLE_LIVE_TRADING=true` with no `.env` real credentials no longer fails at boot (credentials can now come from the database, checked per-request instead — see `real-trading-enabled.test.js`); `ENABLE_LIVE_TRADING` defaults false; out-of-bounds risk-setting rejection |
| `tests/unit/secret-encryption.test.js` | `encryptSecret`/`decryptSecret` round-trips a normal value and an empty-string value; rejects malformed input (wrong colon-part count) and a tampered ciphertext (GCM auth-tag mismatch); regression test for a bug where a legitimately-encrypted empty secret (e.g. Nobitex's unused `apiSecret`) was rejected as malformed because the decrypt path checked part truthiness instead of part count, breaking `GET /api/real-exchange-credentials` for secret-less exchanges |

### Integration tests — database & multi-user isolation

| File | What it covers |
|---|---|
| `tests/integration/database.test.js` | Schema creation (all tables, incl. futures/real-audit/backtest tables), parameterized-query round-trips, a `CHECK` constraint on `signals.status`, per-user risk-settings isolation, per-scope (global/demo/real) per-user emergency-stop independence with global override, spot and futures `strategy_mode`/`selected_strategy_ids_json` behavior (defaults to manual, demo/real futures opt in independently, switching back to manual preserves the prior selection), SQL-metacharacter symbol storage |
| `tests/integration/cross-user-isolation.test.js` | Full HTTP-level proof that two real accounts sharing one server/DB never leak: one user's orders/positions never appear in another's list or portfolio; a user cannot cancel another user's pending order (`ORDER_NOT_FOUND`, not a leak); idempotency keys do not dedupe across users |
| `tests/integration/assets-routes.test.js` | `PUT /api/assets/:symbol/timeframe` updates `default_timeframe`, validates against `SUPPORTED_TIMEFRAMES`, requires the `exchange` query param, and 404s on an unknown asset |

### Integration tests — spot order lifecycle (demo)

| File | What it covers |
|---|---|
| `tests/integration/orders-isolation.test.js` | Demo/Real data isolation (an order in one mode never appears in the other's history/portfolio, real balance never fabricated/defaulted), invalid `mode` rejection, explicit `qty` accepted under the risk ceiling and rejected (not silently clamped) over it, emergency-stop blocking + reset restoring order flow |
| `tests/integration/pending-orders.test.js` | Limit/stop-market/stop-limit lifecycle end to end: an order stays `pending` until the watcher confirms the price crossed it, fills at the correct price, opens exactly one position; `MISSING_LIMIT_PRICE`/`MISSING_TRIGGER_PRICE` rejected before persisting; cancel works on pending orders and is rejected (409) on filled ones; a standalone (non-OCO) pending sell works as a take-profit-only exit |
| `tests/integration/oco-orders.test.js` | OCO (One-Cancels-the-Other) exit pairs: two linked pending orders share one `oco_group_id`; the take-profit leg filling cancels the sibling stop-loss leg and closes the position (and vice versa); OCO with no open position to protect is rejected with `NO_OPEN_POSITION_FOR_OCO` |
| `tests/integration/portfolio-pnl.test.js` | `getPnlSummary` is all-zero for a fresh portfolio, aggregates realized P&L and win rate across multiple closed positions, and is tracked independently between demo and real; `getOpenPositionsWithUnrealizedPnl` computes live unrealized P&L, fails gracefully (`null`, not a throw) when the price lookup fails, and returns `null` P&L for pre-migration rows with no stored `exchange` |
| `tests/integration/signals.test.js` | Regression test for a real production bug: `generateSignal`'s NO_DATA path called `emergencyStopRepository.isActive(mode)` without the required `userId`, throwing "cannot be bound to SQLite parameter 1" on every manual "Generate Signal" click and every scheduled auto-trader cycle — undetected by other tests because they all mock `generateSignal` entirely; also confirms an active emergency stop never lets a BUY/SELL signal escape |
| `tests/integration/fundamentals-unavailable.test.js` | Stock fundamentals return `unavailable`/`not_applicable`, never fabricated, when no API key is configured; an invalid `assetType` is rejected with `VALIDATION_ERROR`, not silently defaulted |

### Integration tests — auto-trading & strategy selection

| File | What it covers |
|---|---|
| `tests/integration/auto-trader.test.js` | Spot demo auto-trader cycle: no-op with nothing enabled; opens a Demo BUY on signal; never opens a second position while one is already open; closes on a SELL signal; never places a Real order regardless of signal; one asset's signal-generation throw doesn't block others in the same cycle; `strategy_mode="auto"` with ≥2 selected strategies uses `generateCombinedSignal` (majority vote), falling back to single-strategy `generateSignal` when no selection exists yet or the asset is `manual`-mode |
| `tests/integration/strategy-selector.test.js` | `rankStrategiesForAsset` groups a synthetic backtest leaderboard by strategy (best threshold pair per strategy), filters by minimum trade count, and takes the top-N by win rate; `runCycle` never persists a selection when fewer than 2 strategies qualify (no "majority of 1"); only touches `auto`-mode assets, leaving `manual` ones untouched, across spot/demo-futures/real-futures independently; a per-asset `optimizeStrategy` failure is caught and skipped without blocking the rest of the cycle |

### Integration tests — futures trading

| File | What it covers |
|---|---|
| `tests/integration/futures-orders.test.js` | Demo futures order safety checks: `MISSING_RISK_PARAMS` without stop/take; `STOP_LOSS_BEYOND_LIQUIDATION` when the stop sits past the estimated liquidation price; `LEVERAGE_TOO_HIGH` above the configured max; a well-formed `open_long` fills, records leverage and an estimated liquidation price, and reports `marginUsed` strictly less than notional exposure; one-way mode rejects a second `open_long` while one is open (`POSITION_ALREADY_OPEN`); `close` realizes P&L and frees the symbol; `close` with nothing open is rejected, not a silent no-op; `open_short` profits when price falls |
| `tests/integration/futures-routes.test.js` | Full HTTP CRUD for the futures watchlist: demo/real entries for the same symbol are fully independent (leverage, auto-trade toggle, timeframe each scoped to one list only); non-KuCoin exchanges rejected; order placement opens a position and shows up in the futures portfolio without leaking into the spot portfolio; a second `open_long` is rejected (one-way mode); real orders blocked by `LIVE_TRADING_DISABLED` when the flag is off; `DELETE` removes only the specified mode's entry; risk-settings default `max_leverage` is 10 |
| `tests/integration/futures-auto-trader.test.js` | Real futures auto-trader: `realAutoTradeGloballyAllowed` is a pure server-wide check independent of any credential lookup; demo fires even with an empty real watchlist; leverage is clamped to `FUTURES_AUTO_TRADE_MAX_LEVERAGE` for real but not demo; a real order requires both the symbol on the real watchlist *and* passing gates, `source=auto`, no unlock-confirmation prompt; a real-list asset is skipped without even generating a signal for a user with no usable KuCoin credentials; two users in the same cycle — one configured, one not — trade/skip fully independently; per-asset throw doesn't crash the cycle; auto-mode strategy selection (majority vote) works the same as spot |
| `tests/integration/futures-auto-trader-flag-off.test.js` | `ENABLE_FUTURES_AUTO_TRADING=false` independently blocks real futures auto-trading even with every other gate (live trading, credentials, watchlist membership) on — the real watchlist isn't even fetched. Runs in its own process since `config` is frozen at boot |
| `tests/integration/futures-auto-trader-live-trading-off.test.js` | `ENABLE_LIVE_TRADING=false` independently blocks real futures auto-trading with every other gate on. Own process, same freeze-at-boot constraint |
| `tests/integration/futures-real-orders.test.js` | `placeRealFuturesOrder` gates block before any exchange call (`REAL_TRADING_NOT_UNLOCKED`); a well-formed `open_long` calls `createOrder` once with `marginMode`/`leverage` in params (no separate `setLeverage`/`setMarginMode` calls), then `fetchPositions` for the real liquidation price; an exchange failure (e.g. leverage rejected) is rejected cleanly with zero side effects; `close` sends `reduceOnly: true`; `marginCurrencyFor` correctly parses ccxt's `BASE/QUOTE:SETTLE` symbol format rather than naively splitting on `/` |

### Integration tests — real trading & credentials

| File | What it covers |
|---|---|
| `tests/integration/real-trading-enabled.test.js` | Real order requires typed UI confirmation even with live trading enabled; a confirmed order calls the (mocked) exchange and logs an audit entry; an exchange failure rejects cleanly with no fallback to demo |
| `tests/integration/real-credentials.test.js` | Unrecognized exchange id and missing key/secret rejected on `PUT`; full lifecycle: `MISSING_REAL_CREDENTIALS` when nothing is configured → saving via `PUT` never round-trips the raw key/secret in the response (masked) and unblocks a real order → `DELETE` clears database-stored credentials back to "not configured" with no `.env` fallback in this test env |
| `tests/integration/real-balance-sync.test.js` | Balance sync is a read-only action independent of `ENABLE_LIVE_TRADING`; `MISSING_REAL_CREDENTIALS`/`VALIDATION_ERROR` before anything is configured; a successful sync returns the quote-scoped balance plus a full multi-currency `walletBalances` breakdown (sorted descending, zero balances excluded) that persists across a later independent `GET`; a failed exchange call surfaces as `EXCHANGE_UNAVAILABLE` and leaves the previously-stored balance untouched |
| `tests/integration/real-pending-orders.test.js` | A real `stop_market` order is rejected with `ORDER_TYPE_UNSUPPORTED_ON_EXCHANGE` before any exchange call when the exchange's ccxt `.has` capability map says it isn't supported (mirrors Binance's real gap); a real limit order is placed `pending` with the exchange order id, then filled once the watcher confirms via `fetchOrder`; cancelling a real pending order calls the exchange's `cancelOrder` |

### Integration tests — position-risk watcher (cross-cutting)

| File | What it covers |
|---|---|
| `tests/integration/position-risk-watcher.test.js` | Automated stop-loss/take-profit closing across all four combinations (spot/futures × demo/real): spot demo closes at-or-through stop-loss and take-profit, stays open in between, and defers to an existing pending OCO exit rather than double-closing; spot real closes on the real exchange via a mocked `createOrder` call; futures demo long/short close correctly with the short's inverted stop/take directions; futures real closes with `reduceOnly: true`; `runCycle` never throws with zero open positions in any mode; `getStatus` reports `running` and `intervalMs` |

### Security tests

| File | What it covers |
|---|---|
| `tests/security/mask-secrets.test.js` | `maskString` redacts long values while keeping a recognizable prefix, fully masks short strings; `maskObject` redacts secret-shaped keys (`apiKey`, `apiSecret`) and recurses into nested objects while leaving non-secret fields untouched; `maskKnownSecrets` redacts every exact occurrence of a configured secret and ignores empty/short (<4 char) values so it can't over-mask; the "don't over-mask readable reason codes" regression |
| `tests/security/rate-limiting.test.js` | General limiter allow/block behavior at the configured threshold, per-IP isolation, and the stricter order-placement limit (20/min) via a real 25-request HTTP loop against a live test server |
| `tests/security/sql-injection.test.js` | SQL-metacharacter-laden input (`'; DROP TABLE ...; --`) in query params (`mode`, `symbol`) and POST body fields (`symbol`) is bound as data, never executed, verified against both a validation-layer path and a direct-repository path, with the `signals`/`assets` tables confirmed intact and queryable afterward |
| `tests/security/xss-safe-rendering.test.js` | Static-analysis check that no frontend `.innerHTML` assignment in `public/js/*.js` carries dynamic/interpolated content (only static empty-string clears allowed); `dashboard.js` renders via `document.createElement`/`.textContent`; `order-confirmation.js`'s confirmation dialog never templates raw HTML strings into `innerHTML` |

## Issues found and fixed

Three bugs were caught by writing and running tests during the project's original phase (not by
inspection) and fixed before that suite went green:

1. **Portfolio balance silently discarded on the first real order.** `portfolioRepository.setBalance()`
   was `UPDATE`-only, which no-ops on a table with no row yet. `real-orders.js` calls it to sync
   the live exchange balance *before* the portfolio row is guaranteed to exist — the sync would
   silently do nothing, and the following `ensureInitialized()` call would then create a fresh
   row with balance `0`, discarding the real balance. Fixed by making `setBalance` an upsert.
   Caught by `real-trading-enabled.test.js`.
2. **Duplicate-order guard matched rejected orders.** `findRecentSimilarOrder` matched any order
   (including ones that were rejected, never executed) within the debounce window, so retrying an
   order shortly after a rejection (e.g. right after clearing an emergency stop) was incorrectly
   blocked as a "duplicate." Fixed by excluding `status = 'rejected'` rows from the match. Caught
   by `orders-isolation.test.js`.
3. **`exchange-client-factory` functions were destructured at `require`-time** in five call sites
   (`real-orders.js`, `market-data-service.js`, `historical-data.js`, `assets-controller.js`,
   `system-controller.js`), which silently defeated `node:test`'s `mock.method()` — the mock
   replaces the property on the module object, but destructuring had already captured the
   original function reference. Refactored all five to namespace-style calls
   (`exchangeClientFactory.getPublicExchange(...)`) so the modules are actually mockable; this
   surfaced while writing the tests, before any assertion ran against real behavior.

Two additional bugs from **Phase 5** (found via manual live-data testing, not the automated suite,
but listed here for a complete picture) are documented in
`docs/phase2-requirements-architecture.md` §7a: a backtest cash-accounting bug that inflated
$10,000 to $24 billion, and an over-aggressive log-masking regex that redacted readable reason
codes.

As the suite grew to cover futures, real credentials, and the auto-trader, four more real bugs
were caught directly by regression tests (confirmed against the tests' own comments, not
reconstructed after the fact):

4. **`generateSignal` crashed on every call.** `emergencyStopRepository.isActive(scope, userId)`
   requires a `userId` to bind into its `WHERE user_id = ?` clause, but `generateSignal()`'s
   NO_DATA path called it as `isActive(mode)` with no `userId` at all — every manual "Generate
   Signal" click and every scheduled auto-trader cycle threw "Provided value cannot be bound to
   SQLite parameter 1." No existing test caught this because every other test mocks
   `generateSignal` entirely rather than exercising the real implementation. Caught by
   `signals.test.js`, which deliberately calls the unmocked function.
5. **Floating-point noise wrongly rejected a valid risk/reward ratio.** A genuinely-1.5
   risk/reward trade could compute as `1.4999999999999791` purely from binary float
   representation (same shape as a real GRAM/USDT signal), and the strict `>= minRiskRewardRatio`
   check rejected it as `RISK_REWARD_TOO_LOW`. Fixed with an epsilon tolerance at the boundary,
   while still genuinely rejecting ratios that are actually below the minimum. Caught/pinned by
   `risk.test.js`.
6. **Legitimately-encrypted empty secrets were rejected as malformed.** `decryptSecret()` checked
   each colon-separated part's *truthiness* rather than its *count*, so an empty-string secret
   (e.g. Nobitex's unused `apiSecret` placeholder, which legitimately encrypts to `"iv:authTag:"`
   with nothing after the last colon) was rejected — breaking `GET /api/real-exchange-credentials`
   for any exchange that doesn't need a secret. Fixed to check part count instead. Caught by
   `secret-encryption.test.js`.
7. **CoinGecko fundamentals always showed "unavailable."** The app guessed a CoinGecko "coin id"
   by lowercasing the ticker (`BTC` → `"btc"`), but CoinGecko ids are slugs (`"bitcoin"`), not
   tickers, so every request 404'd and every crypto fundamental field silently showed
   `"unavailable"`. Fixed by resolving the id via CoinGecko's search endpoint and picking the
   exact-ticker match with the best market-cap rank. Caught/pinned by
   `coingecko-id-resolution.test.js`.

## What is not covered (honest limitations)

- **No browser-based frontend tests.** `xss-safe-rendering.test.js` and `charts-tv-mapping.test.js`
  are static-analysis/pure-logic checks (source-text pattern matching, or evaluating a pure
  function extracted from a browser-only file), not real DOM/interaction tests — no headless
  browser is available in the development sandbox. The dashboard was verified by: (a) `node
  --check` syntax validation on every JS file, (b) confirming the server serves every static asset
  with the correct content-type, (c) manually tracing every API response shape against the
  frontend code that consumes it, and (d) exercising the underlying APIs live. It has **not** been
  clicked through in an actual browser by an automated test — still recommended before considering
  the UI fully verified.
- **No test against a real exchange sandbox/testnet.** Every exchange interaction (KuCoin spot and
  futures, Nobitex, Binance) is mocked at the ccxt-client or `fetch` boundary;
  `kucoin-futures-capability.test.js` verifies the installed ccxt class's declared *capabilities*
  match what the app assumes, but no automated test exercises an actual testnet/sandbox connection
  end to end.
- **No load/concurrency testing.** The rate limiter and SQLite access patterns have not been
  tested under concurrent load; `node:sqlite`'s `DatabaseSync` is synchronous and single-connection,
  which is adequate for the single-user/hobby scope this project targets but unverified beyond that.
  The scheduler tests (auto-trader, futures auto-trader, position-risk-watcher, strategy-selector,
  pending-orders-watcher) all exercise a single `runCycle()` call directly, not the real
  `setInterval`-driven concurrent-tick behavior.
- **Backtest engine correctness is still not directly tested.** `historical-data-market-routing.test.js`
  covers the spot-vs-futures routing param added to `fetchHistoricalRange`, and
  `strategy-selector.test.js` covers the ranking/selection logic downstream of a backtest — but in
  both cases the actual backtest engine's own strategy-optimization step is mocked out entirely.
  The engine was manually verified against live KuCoin history in Phase 5 after fixing the
  cash-accounting bug, but there is still no automated test of the engine's own math — a
  reasonable next addition.
- **Coverage percentage** was not measured (no coverage tool configured); the tables above are a
  qualitative map of what's exercised, not a line/branch coverage number.

## Conclusion

290/290 automated tests pass across 43 files, up from the original 85/13 at the project's spot-only
MVP stage. The suite now exercises the full current scope — spot *and* futures trading, demo *and*
real order placement, encrypted database-stored exchange credentials alongside the legacy `.env`
fallback, per-user auto-traders with majority-vote multi-strategy selection, an automated
stop-loss/take-profit position-risk watcher across all four (spot/futures × demo/real)
combinations, and genuine per-user cross-isolation at the HTTP boundary — while still holding the
line on the areas the project's own mandatory rules call out as safety-critical: the
disabled-by-default live-trading gate (independently re-verified for both spot and futures, and
for both the `ENABLE_LIVE_TRADING` and `ENABLE_FUTURES_AUTO_TRADING` flags separately), the full
risk-validation pipeline (now leverage- and margin-aware), "never fabricate data" (fundamentals,
balances, liquidation math), SQL-injection resistance, credential masking and encryption, and rate
limiting. Along the way it did its job seven times over — finding and fixing real correctness bugs
(silently-discarded real balance, false-positive duplicate detection, a signal-generation crash on
every single call, floating-point-noise trade rejections, a broken credentials endpoint for
secret-less exchanges, and fundamentals silently failing for every crypto asset) before they could
reach a user. The gaps above (no real browser testing, no load testing, no backtest-engine-internals
test, no live exchange-sandbox test) are the honest next additions, not silently swept under the rug.
