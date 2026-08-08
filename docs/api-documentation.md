# API Documentation

Base URL: `http://localhost:<PORT>/api` (default `PORT=3450`).

## Authentication

Every endpoint under `/api/*` requires a logged-in session **except** `GET /api/health` and
`/api/auth/*` themselves. Auth is a session cookie (`session_token`, `HttpOnly`, `SameSite=Lax`,
30-day expiry) set by `POST /api/auth/signup` or `POST /api/auth/login` — browser `fetch` calls
need `credentials: 'same-origin'` (or `include`) for it to be sent; `public/js/api.js` already
does this. See [Auth endpoints](#auth-endpoints) below and
[architecture.md §14](./architecture.md#14-user-accounts) for what does/doesn't get scoped by
account (short version: everything is per-user — Watchlist, Demo/Real portfolios, orders, risk
settings, and exchange credentials — except the global emergency-stop scope, which any logged-in
user may trigger instance-wide).

## Response envelope

Every endpoint returns this shape:

```json
{
  "success": true,
  "data": {},
  "message": "optional",
  "timestamp": "2026-08-02T00:00:00.000Z"
}
```

On failure:

```json
{
  "success": false,
  "data": null,
  "message": "human-readable explanation",
  "errorCode": "MACHINE_READABLE_CODE",
  "timestamp": "2026-08-02T00:00:00.000Z"
}
```

## Error codes → HTTP status

| errorCode | HTTP status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` / `INVALID_MODE` | 400 | Bad request input |
| `UNAUTHENTICATED` | 401 | No valid session — log in via `/api/auth/login` or `/api/auth/signup` |
| `INVALID_CREDENTIALS` | 401 | Wrong username or password (deliberately the same message/code for "no such user" and "wrong password" — avoids leaking which one) |
| `ASSET_NOT_FOUND` / `NOT_FOUND` | 404 | Resource doesn't exist |
| `DUPLICATE_ORDER` | 409 | Same order submitted again inside the debounce window |
| `USERNAME_TAKEN` | 409 | Signup with a username that's already registered |
| `LIVE_TRADING_DISABLED` / `MISSING_REAL_CREDENTIALS` / `REAL_TRADING_NOT_UNLOCKED` / `EMERGENCY_STOP_ACTIVE` | 403 | Blocked by a safety gate |
| `RISK_CHECK_FAILED` (and the specific risk `reasonCode`s below) / `STALE_DATA` / `INSUFFICIENT_DATA` | 422 | Passed validation shape but failed a business rule |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error (message is always generic; details go to the server log, masked) |

Order-rejection `errorCode`s (from the risk pipeline, `src/services/risk/validate-trade.js`):
`EMERGENCY_STOP_ACTIVE`, `LIVE_TRADING_DISABLED`, `INSUFFICIENT_DATA`, `STALE_DATA`,
`INVALID_STOP_LOSS`, `RISK_REWARD_TOO_LOW`, `ORDER_VALUE_TOO_LARGE`, `ORDER_VALUE_TOO_SMALL`,
`MAX_OPEN_POSITIONS_REACHED`, `MAX_DAILY_LOSS_REACHED`, `MAX_EXPOSURE_EXCEEDED`,
`INSUFFICIENT_BALANCE`, `DUPLICATE_ORDER`, plus order-flow-specific codes `MISSING_RISK_PARAMS`,
`INVALID_SIDE`, `NO_OPEN_POSITION_TO_CLOSE`, `INVALID_PRICE`, `MISSING_REAL_CREDENTIALS`,
`REAL_TRADING_NOT_UNLOCKED`, `EXCHANGE_UNAVAILABLE`, `EXCHANGE_ORDER_FAILED`.

## Endpoints

### `GET /api/health`
No params, no auth required. Returns `{ status, nodeEnv, tradingMode, liveTradingEnabled }`.

### Auth endpoints

Unauthenticated (see [Authentication](#authentication) above); every other endpoint on this page
requires the session cookie these set.

#### `POST /api/auth/signup`
Body: `{ username, password }`. `username` is normalized to lowercase, 3-32 chars
(`[a-z0-9_-]`), must be unused. `password` minimum 8 characters — no other complexity
requirement, and there is no email/password-reset flow (no email infrastructure exists in this
project). Creates the account, starts a session (sets the cookie), returns `{ id, username }`.
Rate-limited to 5 requests/minute/IP. If this is the very first account ever created, it also
silently claims any watchlist entries that existed before accounts were introduced (see
[architecture.md §14](./architecture.md#14-user-accounts)).

#### `POST /api/auth/login`
Body: `{ username, password }`. Wrong username and wrong password both return the same
`INVALID_CREDENTIALS` message (no username-enumeration signal). Starts a session on success.
Rate-limited to 10 requests/minute/IP.

#### `POST /api/auth/logout`
No body. Deletes the current session server-side and clears the cookie.

#### `GET /api/auth/me`
No params. Always `200`, never `401` — returns `{ authenticated: false }` or `{ authenticated:
true, id, username }`. This is what the frontend polls once on load to decide whether to show the
login gate or the dashboard.

### `GET /api/assets`
Returns the logged-in user's watchlist only (array of asset rows) — see
[architecture.md §14](./architecture.md#14-user-accounts).

### `POST /api/assets`
Body: `{ symbol, exchange, market?, assetType: "crypto"|"stock", defaultTimeframe? }`.
Validates the symbol exists on the exchange via a live `ccxt.loadMarkets()` call before adding.

### `DELETE /api/assets/:symbol?exchange=`
Removes an asset. `exchange` is a required query param (symbol alone isn't unique across exchanges).

### `PUT /api/assets/:symbol/auto-trade?exchange=`
Body: `{ enabled: boolean }`. Toggles AI Auto-Trading for a watchlist asset — see
[AI Auto-Trading](#ai-auto-trading) below. `exchange` query param required, same as DELETE.

### `PUT /api/assets/:symbol/strategy?exchange=`
Body: `{ strategyId }` — must be one of the ids from `GET /api/strategies` (unknown ids fall back
to `"balanced"`). Sets which named strategy this watchlist asset uses for both manual
"Generate Signal" clicks (when no explicit `strategyId` is passed to `/api/signals/analyze`) and
AI Auto-Trading. `exchange` query param required, same as DELETE.

### `GET /api/strategies`
*Addition, backing the Freqtrade-style strategy engine.* No params. Returns the built-in named
strategies: `[{ id, name, description }]` — see [Strategy engine](#strategy-engine) below.

### `GET /api/exchanges`
*Addition beyond the original spec, for the exchange picker.* Returns a curated list of 16
crypto exchanges (binance, bybit, okx, kucoin, kraken, coinbase, bitget, gate, mexc, htx,
bitfinex, bitstamp, gemini, cryptocom, coinex, nobitex): `[{ id, name, hasSandbox }]`. Any ccxt
exchange id can still be used directly via `POST /api/assets` even if it's not in this curated
list. `nobitex` is not a ccxt exchange — it's a hand-written adapter (see
[architecture.md §16](./architecture.md#16-nobitex--a-hand-written-exchange-adapter-not-ccxt))
with real limitations ccxt exchanges don't have: no automated login (paste a Token from your
Nobitex account instead of an API key/secret pair), market orders only, and no weekly candle
resolution.

### `GET /api/market-data?symbol&exchange`
Live ticker snapshot: `{ price, changePercent24h, volume24h, marketOpen, dataFreshnessMs, asOfUtc }`,
or `{ status: "unavailable", error }` if the exchange call fails.

### `GET /api/candles?symbol&exchange&timeframe&limit`
*Not in the original 20-endpoint list — added because the UI spec requires a price chart and no
other endpoint exposes raw OHLCV.* Returns cached (auto-refreshing) candle rows, oldest first.
`limit` defaults to 200, capped at 1000.

### `GET /api/indicators?symbol&exchange&timeframe`
Returns `{ symbol, exchange, timeframe, indicators }` where `indicators` has one entry per
indicator (`sma, ema, rsi, macd, bollingerBands, atr, stochastic, adx, supportResistance,
volumeAnalysis`), each `{ value, status }` — `status` is `"ok"` or `"insufficient_history"`.

### `GET /api/indicator-series?symbol&exchange&timeframe`
*Addition, for the full trading chart's indicator overlays.* Returns `{ symbol, exchange,
timeframe, series }` where `series` has full historical point arrays (`[{time, value}]`, `time`
in Unix seconds matching Lightweight Charts' expected format) for `sma`, `ema`, `rsi`,
`bollingerUpper`, `bollingerMiddle`, `bollingerLower` — as opposed to `/api/indicators`, which
only returns each indicator's latest value for the TA panel.

### `GET /api/fundamentals?symbol&assetType&providerId`
`assetType` is required (`crypto`|`stock`). `providerId` is the CoinGecko coin slug for crypto
(e.g. `bitcoin`) — omit for stocks. Returns per-field `{ value, source, fetchedAtUtc }` or
`{ value: "unavailable", unavailableReason }` or `{ value: "not_applicable", reason }` for
fields that don't apply to the asset type. Never fabricated.

### `GET /api/signals?symbol&mode&limit&offset`
Signal history, newest first. `mode` filters by `source_mode` (`demo`|`real`|`backtest`) if given.

### `POST /api/signals/analyze`
Body: `{ symbol, exchange, assetType, timeframe?, providerId?, mode?, strategyId? }`. Runs the
full technical+fundamental pipeline, persists the result, and returns the full signal record
(`status` is always exactly one of `BUY`/`SELL`/`HOLD`/`NO_DATA`), plus `strategyId`/`strategyName`
identifying which named strategy produced it. `strategyId` defaults to `"balanced"` if omitted —
see [Strategy engine](#strategy-engine).

### `GET /api/portfolio?mode=demo|real`
`mode` is required. Returns `{ balance, openPositions, exposureValue, exposurePercent,
availableBalance, dailyLossSoFar, updatedAtUtc, pnl }`. Each entry in `openPositions` includes a
live-priced `currentPrice`/`unrealizedPnl` (`null` if the live price lookup fails — never
fabricated). `pnl` is `{ totalRealizedPnl, winCount, lossCount, winRatePercent, unrealizedPnl,
netPnl }`, aggregated across all closed/open positions for that mode. For `mode=real`, `balance`
is a **stored snapshot**, not fetched live on every call — see the endpoint below.

### `POST /api/portfolio/real/sync-balance`
*Addition — fixes a real gap: Real `balance` previously only ever updated as a side effect of
actually placing an order (`real-orders.js`), so there was no way to just check it after entering
credentials.* Body: `{ symbol, exchange }` — used only to pick which quote-currency wallet to
read (this app's `real_portfolio.balance` is a single number scoped to one currency, not a
multi-asset total). Calls the configured Real exchange's `fetchBalance()` (read-only, no order
placed) and stores the result. Unlike placing an order, this does **not** require
`ENABLE_LIVE_TRADING=true` — viewing a balance isn't trading. Requires Real credentials to be
configured (`MISSING_REAL_CREDENTIALS` if not). Returns the updated portfolio snapshot (same
shape as `GET /api/portfolio?mode=real`).

### `GET /api/orders?mode=demo|real&limit&offset`
Order history for that mode only — physically impossible to leak the other mode's orders (§4 of architecture.md).

### `POST /api/orders/demo`
Body: `{ symbol, exchange, side: "buy"|"sell", stopLoss?, takeProfit?, idempotencyKey?, signalId? }`.
`stopLoss`/`takeProfit` are required for `"buy"` (opening); `"sell"` closes an existing open
position for that symbol (v1 is long-only spot — no shorting) and ignores stop/take. Never calls
a real exchange endpoint under any code path. Returns the order record (HTTP 201 if filled,
matching error status if rejected — see the error-code table above).

### `POST /api/orders/real`
Same body shape plus `confirmationText` (must be the literal string `"CONFIRM"`, matching the UI
dialog). Requires, in order: `ENABLE_LIVE_TRADING=true` (still `.env`-only, see
[architecture.md §15](./architecture.md#15-real-exchange-credentials-via-the-ui)), valid Real
exchange credentials (now resolved from the database if set via the endpoints below, else from
`.env`'s `REAL_EXCHANGE_NAME`/`REAL_API_KEY`/`REAL_API_SECRET`), `confirmationText === "CONFIRM"`,
no active emergency stop, then the full risk pipeline — before any network call reaches the
exchange. A failed check never falls back to a demo fill.

### `GET /api/real-exchange-credentials`
*Addition — lets Real Trading credentials be managed from the UI instead of only `.env`.* No
params. Returns `{ configured, source, exchangeName, apiKeyPreview }` — `source` is
`"database"|"env"|"none"`; `apiKeyPreview` is a masked preview (e.g. `"abcd****************wxyz"`)
or `null`. Never returns the actual key or secret — write-only from the API's perspective, same
convention as GitHub/most secret managers.

### `PUT /api/real-exchange-credentials`
Body: `{ exchangeName, apiKey, apiSecret }`. `exchangeName` must be a recognized exchange id
(ccxt, or the `nobitex` custom adapter). `apiKey` is always required; `apiSecret` is required
*unless* the exchange doesn't use one (currently only `nobitex`, which authenticates with a
single Token carried in `apiKey` — see
[architecture.md §16](./architecture.md#16-nobitex--a-hand-written-exchange-adapter-not-ccxt)).
Stores `apiKey`/`apiSecret` **encrypted** in the database (AES-256-GCM, key in a separate local
file — see architecture.md §15) and makes them take precedence over any `.env`-configured Real
credentials for this account from that point on. Private to the account that set it — no other
user can see or use them.

### `DELETE /api/real-exchange-credentials`
No body. Deletes this account's database-stored credentials; Real Trading for this account then
falls back to `.env`'s `REAL_EXCHANGE_NAME`/`REAL_API_KEY`/`REAL_API_SECRET` — but only if this is
the one legacy account that fallback applies to (see `LEGACY_DATA_OWNER_USERNAME` in
`src/database/schema.js`) — or becomes unconfigured (`MISSING_REAL_CREDENTIALS` on the next real
order) otherwise.

### `POST /api/backtest`
Body: `{ symbol, exchange, timeframe?, start, end, initialCapital?, feePercent?, slippagePercent?, strategyId?, scoringConfig? }`
(`start`/`end` are ISO date strings). `strategyId` selects a named strategy's indicator weights
and buy/sell thresholds (default `"balanced"`); `scoringConfig` is an optional object that
overrides individual fields on top of the chosen strategy (e.g. `{ buyThreshold, sellThreshold }`
— this is how the optimizer's "Apply" leaderboard action feeds a tuned pair of thresholds back
into a specific backtest run). `fundamentalWeight` is always forced to `0` for backtests
regardless of what the strategy or `scoringConfig` specify — see
[Strategy engine](#strategy-engine). Runs synchronously (long ranges take longer — it's fetching
real historical data). Returns `{ runId, metrics, trades, equityCurve, warnings, disclaimer }`.
`disclaimer` is always `"Past performance does not guarantee future results."`.

### `POST /api/backtest/optimize`
*Addition — "hyperopt-lite" grid-search over strategies and thresholds.* Body: `{ symbol,
exchange, timeframe?, start, end, initialCapital?, feePercent?, slippagePercent?, strategyIds?,
thresholdGrid?, rankBy? }`. `strategyIds` defaults to all 5 built-in strategies; `thresholdGrid`
defaults to `[{buyThreshold:0.2,sellThreshold:-0.2}, {0.3,-0.3}, {0.4,-0.4}]`; `rankBy` defaults to
`"totalPnlPercent"` (any numeric field from a backtest's `metrics`). Historical candles are
fetched **once** and every strategy/threshold combination is simulated in-memory against that
same candle set — not re-fetched per combination — which keeps a 15-combination run to roughly
the cost of a single backtest's network fetch. Capped at 60 combinations per request (a plain
thrown error, surfaced as `INTERNAL_ERROR`/500, if the `strategyIds` × `thresholdGrid` cross
product exceeds that — narrow either list to stay under it). Returns `{ combinationsRun,
leaderboard, disclaimer }`, where `leaderboard` is sorted
descending by `rankBy` and each entry is `{ strategyId, strategyName, buyThreshold, sellThreshold,
metrics }`. This is a simple parameter grid search, not true Bayesian hyperopt (no `scikit-optimize`
dependency), and — like any parameter search — risks overfitting to the tested date range; the
response always carries a disclaimer to that effect, and the UI surfaces it verbatim.

### `GET /api/backtest?limit`
*Addition beyond the original spec, for the same reason as `/api/candles` — the UI needs to list
past runs.* Returns recent backtest run summaries.

### `GET /api/backtest/:runId`
*Addition, same rationale.* Returns one run's full detail: `{ ...run, metrics, trades, equityCurve }`.

## Strategy engine

Freqtrade-inspired pluggable strategies (`src/services/signals/strategies.js`) — a strategy is a
named bundle of per-indicator weights, technical/fundamental balance, buy/sell score thresholds,
and an ATR stop-loss multiplier, swappable without touching the underlying indicator-direction
logic in `technical-scorer.js`. Built-ins: `balanced` (default), `trend-following`,
`mean-reversion`, `momentum`, `fundamentals-driven` — see `GET /api/strategies` for each one's
description. A strategy id can be supplied per-call (`analyzeSignal`, `runBacktest`,
`optimizeStrategy`) or persisted per watchlist asset via `PUT /api/assets/:symbol/strategy`, in
which case AI Auto-Trading also picks it up automatically (`auto-trader.js` reads each asset's
stored `strategy_id` on every tick). Unknown ids silently fall back to `balanced` rather than
erroring.

### `GET /api/risk-settings?mode=demo|real`
Returns the current risk settings for that mode (seeded from `.env` defaults on first read).

### `PUT /api/risk-settings?mode=demo|real`
Body: any subset of `{ maxRiskPerTradePercent, maxDailyLossPercent, maxOpenPositions,
maxOrderValue, minRiskRewardRatio, maxPortfolioExposurePercent }`. Each field is bounds-checked
(e.g. `maxRiskPerTradePercent` must be in `(0, 10]`) before being merged into the existing settings.

### `POST /api/emergency-stop`
Body: `{ scope: "global"|"demo"|"real", reason? }`. Activating `"global"` blocks all trading in
every mode regardless of the other scopes' state.

### `POST /api/emergency-stop/reset`
Body: `{ scope: "global"|"demo"|"real", confirm: true }` — `confirm` must be exactly `true` or
the request is rejected; this is a deliberate extra step before re-enabling trading.

### `GET /api/logs?level&mode&limit&offset`
Recent log entries (secrets already masked before they were stored, so this is safe to return
as-is). Filterable by `level` and `mode`.

### `GET /api/system-status`
Returns `{ nodeEnv, tradingMode, liveTradingEnabled, demoExchangeConfigured,
realExchangeConfigured, demoSandbox, emergencyStop: { global, demo, real }, autoTrader: { running,
intervalMs, mode, enabledAssetCount } }` — a one-call health overview for the System & Logs
dashboard tab. `autoTrader.mode` is always `"demo"`.

## AI Auto-Trading

Not a separate endpoint group — it's a background scheduler (`src/services/scheduler/auto-trader.js`)
that reuses `POST /api/signals/analyze`'s pipeline and `POST /api/orders/demo` verbatim, on a
timer (`AUTO_TRADE_INTERVAL_MS`, default 5 minutes, minimum 30 seconds). Enable it per asset via
`PUT /api/assets/:symbol/auto-trade`. On each tick, for every asset with it enabled: generates a
signal; if `BUY` and no position is already open, places a Demo buy sized/validated by the same
risk pipeline as a manual order; if `SELL` and a position is open, closes it. **Hard-coded to
Demo mode only — there is no configuration, flag, or code path that lets it place a Real order.**
Failures on one asset don't stop the cycle for others. All activity is visible via
`GET /api/orders?mode=demo` and `GET /api/logs?mode=demo` (category `auto-trader`).

## Rate limits

- General `/api/*` traffic: 300 requests/minute per IP.
- `/api/orders/demo` and `/api/orders/real`: 20 requests/minute per IP (stricter — order
  placement is the highest-stakes endpoint).

Both are in-memory, per-process (`src/middleware/rate-limiter.js`) — adequate for the
single-instance hobby-project scope this targets; a multi-instance deployment would need a
shared store instead.
