# Phase 2 — Requirements, Architecture, Database & API Design

Builds on [phase1-technology-selection.md](./phase1-technology-selection.md). Stack: Node.js + Express (plain JS), `technicalindicators`, `ccxt`, TradingView Lightweight Charts, Finnhub+FMP (stocks)/CoinGecko+CoinMarketCap (crypto), `better-sqlite3`.

---

## 1. Functional Requirements

### 1.1 Asset Management
- CRUD on a watchlist: `symbol`, `exchange`, `market` (`spot`/`futures` — futures out of scope for v1 trading, spot only for real orders), default `timeframe`.
- Validate symbol exists on the exchange via `ccxt.loadMarkets()` before adding.
- Timeframes: `1m 5m 15m 1h 4h 1d 1w`, restricted to what the exchange actually supports (checked against `exchange.timeframes`).
- Live snapshot per asset: last price, 24h change %, 24h volume, market open/closed (for stocks) or always-open (crypto), data freshness (`age_ms` since last candle), validation error if the feed is unavailable.

### 1.2 Technical Analysis
Indicators (via `technicalindicators`): SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Stochastic Oscillator, ADX, Support/Resistance (pivot-based swing high/low detection), Volume Analysis (volume SMA + relative volume).
- Each indicator function takes normalized OHLCV candles and a config (period, etc.), returns `{ value, status: 'ok'|'insufficient_history'|'invalid_data' }`.
- Minimum candle count enforced per indicator (e.g., MACD needs ≥ `slowPeriod + signalPeriod`); below minimum → `NO_DATA`, never a partial/misleading value.
- Candle validation: monotonic timestamps, no gaps beyond `1.5×timeframe`, `high ≥ max(open,close)`, `low ≤ min(open,close)`, all OHLCV finite numbers. Invalid candles are dropped and logged, not silently used.

> **Phase 4 update:** the mandatory `.env.example` (spec §12) defines a single `FUNDAMENTAL_API_KEY`,
> which doesn't leave room for the FMP/CoinMarketCap secondary providers floated in Phase 1/2. Implemented
> instead: **Finnhub** for stocks (uses `FUNDAMENTAL_API_KEY` as the Finnhub token; if unset, every stock
> field returns `unavailable` rather than making a doomed request) and **CoinGecko's public/keyless
> endpoint** for crypto (works without any key on the free tier; `FUNDAMENTAL_API_KEY` is opportunistically
> sent as a CoinGecko demo-plan key via the `x-cg-demo-api-key` header if the user happens to have a
> CoinGecko key there instead of a Finnhub one). FMP/CoinMarketCap remain documented fallback options for a
> future multi-key configuration but are not wired up in v1.

### 1.3 Fundamental Analysis
- **Stocks** (Finnhub primary, FMP secondary): Revenue, Net Income, EPS, P/E, Debt Ratio, Cash Flow, Market Cap, Revenue Growth (YoY), News (latest N headlines), overall status (`healthy`/`neutral`/`weak`/`unavailable`, computed from a documented rule set, not invented).
- **Crypto** (CoinGecko primary, CoinMarketCap secondary): Market Cap, FDV, Circulating Supply, Total Supply, 24h Volume, Liquidity (approximated from order-book depth or exchange volume — documented as an approximation), Exchange Listings count, Events, News, market-health status.
- Every field carries `{ value, source, fetchedAt, unavailableReason? }`. If a provider doesn't return a field, or both providers fail, the field is `"unavailable"` — never fabricated, never defaulted to 0/null presented as real data.
- Stock-only fields on a crypto asset (P/E, Debt Ratio, etc.) explicitly rendered as "not applicable to crypto assets", not "unavailable".
- Cached in `fundamentals_cache` with a per-field-group TTL (e.g., 15 min for market data, 24h for statements) to respect free-tier rate limits (documented per-provider limits from Phase 1).

### 1.4 Signal Generation & Scoring
- Signal statuses: `BUY | SELL | HOLD | NO_DATA` only.
- `NO_DATA` is forced (overriding any computed score) when: insufficient candles, invalid/stale price, risk calculation fails, data older than `maxDataAgeMs` (configurable, default derived from timeframe), required fundamental fields unavailable *and* fundamental weight > 0, or emergency stop is active.
- Scoring formula (documented, configurable via risk-settings):
  ```
  Final Score = (Technical Score × Technical Weight) + (Fundamental Score × Fundamental Weight)
  ```
  Defaults: Technical Weight = 0.60, Fundamental Weight = 0.40. Both scores normalized to `[-1, +1]`. Thresholds (configurable): `Final Score ≥ buyThreshold (default 0.3)` → BUY candidate, `≤ sellThreshold (default -0.3)` → SELL candidate, else HOLD.
- Each indicator/fundamental contributes a signed sub-score and a human-readable reason string (e.g., `"RSI 28 < 30 → oversold (+0.4)"`); the signal's `reasons[]` and `technicalSummary`/`fundamentalSummary` are built from these contributions — fully traceable, never a black box.
- Signal record fields (per spec §4 "Signals"): `id (uuid)`, `symbol`, `exchange`, `timestampUtc`, `timeframe`, `price`, `technicalScore`, `fundamentalScore`, `finalScore`, `status`, `confidence (0-1, derived from data quality + score magnitude)`, `reasons[]`, `technicalSummary`, `fundamentalSummary`, `entry`, `stopLoss`, `takeProfit`, `riskRewardRatio`, `dataQuality ('good'|'degraded'|'insufficient')`, `warnings[]`, `strategyVersion`.
- A BUY/SELL signal only carries non-null `entry/stopLoss/takeProfit/riskRewardRatio` if the risk engine successfully computed them (§1.5); otherwise the signal is downgraded to `HOLD` with a warning, per the "reject trades when risk calculation is unavailable" rule.
- Signals are analysis artifacts, not trades — one `signals` table shared across modes (a signal isn't money-at-risk); it records which candle source (`backtest`/`live`) produced it for traceability, but does not need Demo/Real isolation.

### 1.5 Risk Management
- Config (defaults from `.env.example`, overridable per-mode via `risk_settings` table + `PUT /api/risk-settings`):
  `maxRiskPerTradePercent`, `maxDailyLossPercent`, `maxOpenPositions`, `maxOrderValue`, `minRiskRewardRatio`, `maxPortfolioExposurePercent`.
- Formulas (documented, per spec):
  ```
  Maximum Risk Amount = Portfolio Balance × Maximum Risk Percentage
  Position Size = Maximum Risk Amount / |Entry Price − Stop-Loss Price|
  ```
- Pre-trade validation pipeline (every check must pass, each with an explicit accept/reject reason returned to the caller):
  1. Emergency stop not active (for the target mode).
  2. Live trading enabled (Real mode only) — `ENABLE_LIVE_TRADING=true`.
  3. Data quality is `good`/`degraded`, not `insufficient`; data age within threshold.
  4. `riskRewardRatio ≥ minRiskRewardRatio`.
  5. Computed position size × price ≤ `maxOrderValue`, and ≥ exchange min order size.
  6. Open positions for the mode < `maxOpenPositions`.
  7. Realized+unrealized daily loss for the mode < `maxDailyLossPercent × balance`.
  8. Resulting portfolio exposure (sum of open position notional / balance) ≤ `maxPortfolioExposurePercent`.
  9. Sufficient available balance for the order.
  10. No duplicate order (same symbol+side+price+mode within a debounce window, or a client-supplied idempotency key already seen).
- Any failed check → order rejected with a specific machine-readable `reasonCode` and human message; no partial/best-effort execution.

### 1.6 Execution Modes
Covered in detail in Phase 1 §7 (Backtest vs Demo vs Real table) — restated as requirements:
- **Backtest**: historical candles only, in-process simulated fills (configurable fee %, slippage model), never calls exchange order endpoints. Outputs: trade list, P&L, max drawdown, win rate, profit factor, trade count, avg win/loss, equity curve, mandatory "Past performance does not guarantee future results" banner. Look-ahead prevention: the simulation only ever sees candles up to index *i* when deciding the action at *i*; indicators are computed on a rolling window, never on the full dataset in advance.
- **Demo**: default mode. Virtual balance (`INITIAL_DEMO_BALANCE`), simulated order fills against live/sandbox price feed. If the target exchange has a working `setSandboxMode(true)` testnet (verified per Phase 1 §9 recommendation, via a startup capability probe), demo orders may optionally be mirrored there; otherwise pure simulated-fill-on-live-price. Demo never calls production order endpoints under any code path.
- **Real**: disabled by default. Gate is the logical AND of: `ENABLE_LIVE_TRADING=true` in `.env`, valid Real credentials present, UI "unlock" flow completed (typed confirmation + re-entered acknowledgement, session-scoped), all risk checks pass. No silent fallback to Demo on any failure — a blocked Real order returns an explicit rejection, never a Demo-mode substitute execution.

---

## 2. Non-Functional Requirements (cross-cutting, from mandatory rules)
- All timestamps stored and returned as UTC ISO-8601 (`toISOString()`); documented in every API response and DB column name suffix `_utc` or `_at`.
- All secrets sourced from `process.env` only; a `maskSecret()` utility redacts credentials in every log line, error payload, and API response before it leaves the process.
- Parameterized queries only (`better-sqlite3` prepared statements) — no string-concatenated SQL.
- Structured JSON logging (`src/services/logging`) with levels from `LOG_LEVEL`; every log entry passes through the credential-masking step.
- Every external HTTP call (ccxt, fundamentals APIs) wrapped with a timeout (`REQUEST_TIMEOUT_MS`) and bounded retry (`MAX_API_RETRIES`, exponential backoff).
- Express-level rate limiting on all `/api/*` routes; stricter limits on `/api/orders/*`.

---

## 3. Architecture

```
server.js                         → boots Express, reads PORT, handles EADDRINUSE
config/config.js                  → loads/validates .env, exposes typed config object

src/routes/*                      → thin HTTP layer: validate input, call controller, format response
src/controllers/*                 → orchestrate services per request
src/middleware/                   → error handler, rate limiter, request logger, mode validator, real-trading unlock guard

src/services/market-data/         → ccxt wrapper: fetchOHLCV, ticker snapshot, capability probe (sandbox support), candle normalization/validation
src/services/technical-analysis/  → one module per indicator group + an aggregator that returns {value,status} per indicator
src/services/fundamental-analysis/→ provider adapters (finnhub.js, fmp.js, coingecko.js, coinmarketcap.js) behind one normalizing interface + cache-through logic
src/services/signals/             → scoring engine (technical+fundamental → final score → status), reason builder
src/services/risk/                → position sizing, the 10-step validation pipeline (§1.5), emergency-stop state
src/services/portfolio/           → balance/position bookkeeping, strictly parameterized by mode
src/services/orders/demo-orders.js → demo fill simulation, isolated from real-orders.js
src/services/orders/real-orders.js → real order placement via ccxt, guarded by risk pipeline + live-trading gate
src/services/exchanges/           → ccxt client factory (separate demo-credentialed vs real-credentialed instances, never shared)
src/services/backtesting/         → historical replay engine, metrics calculator
src/services/logging/             → structured logger + masking
src/services/scheduler/           → polling loop for live prices/fundamentals refresh (setInterval-based; WS optional later via ccxt.pro if licensed)

src/database/                     → schema.js (DDL), connection.js, repositories per table (parameterized queries only)

public/                           → static vanilla JS/HTML/CSS dashboard (Phase 6)
tests/                            → unit/integration/security/fixtures (Phase 7)
docs/                             → this doc set (Phase 8 finalizes)
data/                             → trading-bot.sqlite (gitignored)
```

**Dependency direction:** routes → controllers → services → database/exchanges. Services never import from routes/controllers. `demo-orders.js` and `real-orders.js` share no code beyond the pure-function risk/position-sizing module — enforced by keeping them as separate files with no cross-import, per the "strictly separate code paths" rule.

---

## 4. Database Schema (SQLite via `node:sqlite`)

> **Phase 3 update:** Phase 1/2 originally recommended `better-sqlite3`. During Phase 3 scaffolding, `npm install`
> failed to build it — no prebuilt binary was available for this platform/Node combination, and the node-gyp
> fallback couldn't reach `nodejs.org` to download headers (network access is restricted in this environment).
> Node 24 (in use here) ships `node:sqlite` (`DatabaseSync`) built in, requiring no native compilation and no
> network access. It was verified working (schema applies cleanly, all 17 tables created) and is a closer match
> to the "no native build friction" principle this project already applied to reject `node-talib` in Phase 1.
> The project now uses `node:sqlite` instead of `better-sqlite3`; the schema/API below is otherwise unchanged
> (`DatabaseSync` supports `.exec()` and `.prepare().run()/get()/all()` the same way `better-sqlite3` does).



Isolation strategy: **separate tables per mode** for anything involving money (orders/positions/portfolio), rather than a shared table with a `mode` filter column — this makes an unfiltered/forgotten-`WHERE` bug structurally impossible (you cannot accidentally read Real rows out of `demo_orders`). Non-monetary shared data (assets, candles, fundamentals cache, signals, logs) uses a single table, since isolation risk there is not a financial-safety issue; `signals` and `logs` still carry a `mode` column for filtering/display.

```sql
-- Reference / shared data
CREATE TABLE assets (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'spot',
  asset_type TEXT NOT NULL CHECK (asset_type IN ('crypto','stock')),
  default_timeframe TEXT NOT NULL DEFAULT '1h',
  added_at_utc TEXT NOT NULL,
  UNIQUE(symbol, exchange)
);

CREATE TABLE candles (
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts_utc INTEGER NOT NULL,           -- epoch ms, candle open time
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
  source TEXT NOT NULL,              -- 'live' | 'backtest-import'
  PRIMARY KEY (symbol, exchange, timeframe, ts_utc)
);

CREATE TABLE fundamentals_cache (
  symbol TEXT NOT NULL, asset_type TEXT NOT NULL, field_group TEXT NOT NULL,
  data_json TEXT NOT NULL,           -- normalized fields incl. per-field source+unavailable markers
  provider TEXT NOT NULL, fetched_at_utc TEXT NOT NULL, expires_at_utc TEXT NOT NULL,
  PRIMARY KEY (symbol, asset_type, field_group)
);

CREATE TABLE signals (
  id TEXT PRIMARY KEY,               -- uuid
  symbol TEXT NOT NULL, exchange TEXT NOT NULL, timeframe TEXT NOT NULL,
  ts_utc TEXT NOT NULL, price REAL,
  technical_score REAL, fundamental_score REAL, final_score REAL,
  status TEXT NOT NULL CHECK (status IN ('BUY','SELL','HOLD','NO_DATA')),
  confidence REAL, reasons_json TEXT, technical_summary_json TEXT, fundamental_summary_json TEXT,
  entry REAL, stop_loss REAL, take_profit REAL, risk_reward_ratio REAL,
  data_quality TEXT, warnings_json TEXT, strategy_version TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK (source_mode IN ('backtest','demo','real'))
);
CREATE INDEX idx_signals_symbol_ts ON signals(symbol, ts_utc);

-- Risk / control (mode-scoped rows, not mode-filtered tables — small config tables, low risk)
CREATE TABLE risk_settings (
  mode TEXT PRIMARY KEY CHECK (mode IN ('demo','real')),
  max_risk_per_trade_percent REAL NOT NULL,
  max_daily_loss_percent REAL NOT NULL,
  max_open_positions INTEGER NOT NULL,
  max_order_value REAL NOT NULL,
  min_risk_reward_ratio REAL NOT NULL,
  max_portfolio_exposure_percent REAL NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE emergency_stop (
  scope TEXT PRIMARY KEY CHECK (scope IN ('global','demo','real')),
  active INTEGER NOT NULL DEFAULT 0,
  reason TEXT, activated_at_utc TEXT, reset_at_utc TEXT
);

-- Demo (fully isolated tables)
CREATE TABLE demo_portfolio (id INTEGER PRIMARY KEY CHECK (id=1), balance REAL NOT NULL, updated_at_utc TEXT NOT NULL);
CREATE TABLE demo_positions (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL,
  entry_price REAL NOT NULL, stop_loss REAL, take_profit REAL, opened_at_utc TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE demo_orders (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL,
  price REAL NOT NULL, stop_loss REAL, take_profit REAL, status TEXT NOT NULL, reject_reason TEXT,
  idempotency_key TEXT, created_at_utc TEXT NOT NULL, filled_at_utc TEXT, signal_id TEXT REFERENCES signals(id));

-- Real (fully isolated tables, structurally identical, never shared code path)
CREATE TABLE real_portfolio (id INTEGER PRIMARY KEY CHECK (id=1), balance REAL NOT NULL, updated_at_utc TEXT NOT NULL);
CREATE TABLE real_positions (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL,
  entry_price REAL NOT NULL, stop_loss REAL, take_profit REAL, opened_at_utc TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE real_orders (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL,
  price REAL NOT NULL, stop_loss REAL, take_profit REAL, status TEXT NOT NULL, reject_reason TEXT,
  idempotency_key TEXT, exchange_order_id TEXT, created_at_utc TEXT NOT NULL, filled_at_utc TEXT, signal_id TEXT REFERENCES signals(id));
CREATE TABLE real_audit_log (id INTEGER PRIMARY KEY, order_id TEXT, request_json TEXT, response_json TEXT, created_at_utc TEXT NOT NULL);

-- Backtest (separate namespace entirely — never touches demo/real tables)
CREATE TABLE backtest_runs (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, exchange TEXT NOT NULL, timeframe TEXT NOT NULL,
  start_utc TEXT NOT NULL, end_utc TEXT NOT NULL, initial_capital REAL NOT NULL, fee_percent REAL NOT NULL,
  slippage_percent REAL NOT NULL, strategy_version TEXT NOT NULL, created_at_utc TEXT NOT NULL,
  metrics_json TEXT, status TEXT NOT NULL);
CREATE TABLE backtest_trades (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES backtest_runs(id),
  symbol TEXT NOT NULL, side TEXT NOT NULL, entry_price REAL NOT NULL, exit_price REAL, qty REAL NOT NULL,
  entered_at_utc TEXT NOT NULL, exited_at_utc TEXT, pnl REAL, signal_id TEXT REFERENCES signals(id));
CREATE TABLE backtest_equity_curve (run_id TEXT NOT NULL REFERENCES backtest_runs(id), ts_utc TEXT NOT NULL, equity REAL NOT NULL);

-- Logs
CREATE TABLE logs (id INTEGER PRIMARY KEY, level TEXT NOT NULL, mode TEXT, category TEXT,
  message TEXT NOT NULL, meta_json TEXT, created_at_utc TEXT NOT NULL);
```

No credentials table — real/demo exchange API keys live only in `process.env`, read once at startup into the exchange client factory, never persisted to SQLite, never included in any `SELECT *`/log/response.

---

## 5. API Design

Standard envelope for every endpoint:
```json
{"success": true, "data": {}, "message": "optional", "timestamp": "2026-08-02T00:00:00.000Z"}
```
Errors: `success: false`, `data: null`, `message`, plus `errorCode` (machine-readable, e.g. `VALIDATION_ERROR`, `LIVE_TRADING_DISABLED`, `RISK_CHECK_FAILED`, `EMERGENCY_STOP_ACTIVE`, `STALE_DATA`, `RATE_LIMITED`). HTTP status matches: 400 validation, 403 mode/guard rejection, 404 not found, 409 duplicate order, 422 risk rejection, 429 rate limit, 500 unexpected (never leaks stack traces or secrets).

| Method & Path | Purpose | Key params | Notes |
|---|---|---|---|
| `GET /api/health` | Liveness | — | no auth, used by ops/tests |
| `GET /api/assets` | List watchlist | — | |
| `POST /api/assets` | Add asset | `{symbol, exchange, market, timeframe}` | validates via `ccxt.loadMarkets()` |
| `DELETE /api/assets/:symbol` | Remove asset | — | |
| `GET /api/market-data` | Snapshot for a symbol | `?symbol&exchange` | price, change, volume, freshness |
| `GET /api/indicators` | Computed TA | `?symbol&exchange&timeframe` | per-indicator `{value,status}` |
| `GET /api/fundamentals` | Fundamental snapshot | `?symbol&assetType` | per-field `{value,source,fetchedAt}` or `"unavailable"` |
| `GET /api/signals` | Signal history | `?symbol&mode&limit&cursor` | paginated |
| `POST /api/signals/analyze` | Generate a signal now | `{symbol,exchange,timeframe}` | runs full pipeline, persists to `signals` |
| `GET /api/portfolio?mode=demo\|real` | Balance + positions | `mode` required, validated enum | |
| `GET /api/orders?mode=demo\|real` | Order history | `mode`, `limit`, `cursor` | |
| `POST /api/orders/demo` | Place demo order | `{symbol,side,qty|riskPercent,stopLoss,takeProfit,idempotencyKey}` | never touches real tables/exchange |
| `POST /api/orders/real` | Place real order | same shape + requires unlocked session | full guard chain (§1.5, §1.6) before any exchange call |
| `POST /api/backtest` | Run a backtest | `{symbol,exchange,timeframe,start,end,initialCapital,feePercent,slippagePercent,strategyParams}` | synchronous for small ranges; returns `runId` + metrics |
| `GET /api/risk-settings` | Read settings | `?mode` | |
| `PUT /api/risk-settings` | Update settings | `{mode, ...fields}` | validated bounds (e.g. `maxRiskPerTradePercent ≤ 5`) |
| `POST /api/emergency-stop` | Trip the stop | `{scope: global\|demo\|real, reason}` | blocks new orders immediately |
| `POST /api/emergency-stop/reset` | Clear the stop | `{scope}` | requires explicit confirmation body flag |
| `GET /api/logs` | Recent logs | `?level&mode&limit&cursor` | pre-masked before storage, so safe to return raw |
| `GET /api/system-status` | Service health | — | exchange connectivity, live-trading enabled?, emergency-stop states, DB status |

All list endpoints paginate via `limit`(default 50, max 200)+`cursor`. All mutating endpoints validate body shape with a schema validator (lightweight hand-rolled or a small dependency, decided in Phase 3) before touching services.

---

## 6. Demo/Real Isolation — Enforcement Summary
1. **DB**: physically separate tables (§4) — a query against `demo_*` cannot return `real_*` rows.
2. **Services**: `demo-orders.js` / `real-orders.js` are separate files, separate exchange-client instances from `services/exchanges/`, no shared execution function — only the pure risk-calculation module is shared (it takes mode as an explicit param used solely for which `risk_settings` row / emergency-stop scope to read, never for branching execution behavior).
3. **Middleware**: a `requireLiveTradingEnabled` guard runs before the `real-orders` controller and short-circuits with `403 LIVE_TRADING_DISABLED` if `ENABLE_LIVE_TRADING !== 'true'` — checked fresh from config on every request, not cached at boot, so flipping the env var (with restart) takes effect immediately and there is no code path that reaches the exchange client without passing this guard.
4. **UI**: Real panel is disabled/greyed out until an explicit unlock flow (type-to-confirm) completes for the browser session; every Real order additionally shows a confirmation dialog with full order details before submit (§Real Trading requirements).
5. **No fallback rule**: if any Real-path check fails, the API returns a rejection — there is no code path where a failed Real order silently calls the Demo order function instead.

---

## 7. Implementation Plan (Phases 3–8, concrete steps)

- **Phase 3**: `package.json` (express, better-sqlite3, ccxt, technicalindicators, dotenv, uuid — no TS deps), `.gitignore`, `.env.example` (as specified), `config/config.js` (loads+validates env, fails fast on invalid combos e.g. `ENABLE_LIVE_TRADING=true` with missing real creds), `server.js` (PORT handling incl. `EADDRINUSE` friendly message), minimal `README.md` stub, `src/database/schema.js` applying §4 DDL on boot if not present.
- **Phase 4**: `src/database/` repositories, `services/market-data` (ccxt wrapper + candle validation), `services/technical-analysis` (indicator modules), `services/fundamental-analysis` (provider adapters + cache), `services/signals` (scoring engine), `services/risk` (validation pipeline + position sizing), matching unit-testable pure functions where possible.
- **Phase 5**: `services/backtesting`, `services/orders/demo-orders.js`, `services/orders/real-orders.js` (with mocked ccxt in tests — no real network calls during dev), `services/portfolio`, all `src/routes` + `src/controllers`, emergency-stop + risk-settings persistence, rate-limiting middleware.
- **Phase 6**: `public/` dashboard — mode switcher, Lightweight Charts integration, panels per §8 of the original spec, `order-confirmation.js` dialog, safe DOM rendering (textContent/DOM APIs, no `innerHTML` with untrusted data).
- **Phase 7**: Jest (or Node test runner — decided at Phase 7 kickoff) unit/integration/security tests per §10 of the original spec; `docs/test-report.md`.
- **Phase 8**: `docs/technical-documentation.md`, `docs/user-guide.md`, `docs/api-documentation.md`, `docs/architecture.md` (formalizing this doc), final README, acceptance-criteria checklist, final report.

---

## 7a. Phase 5 findings worth keeping in mind

- **`node:sqlite`'s bound statements are stricter than `better-sqlite3`'s.** Passing an object with a
  key not referenced anywhere in the SQL text throws `Unknown named parameter`, where `better-sqlite3`
  silently ignores it. Every repository insert must bind an object whose keys are an exact match (a
  subset is fine if defaults are merged in first, e.g. `{ signalId: null, ...order }`, but never a
  superset). Caught via `backtest_trades` initially omitting `exit_reason`.
- **ccxt's `loadMarkets()` on some exchanges also loads unrelated market types** (e.g. KuCoin loads
  futures/swap contracts from a separate `api-futures.kucoin.com` subdomain by default, even when the
  app never trades futures). Since v1 is spot-only, `exchange-client-factory.js` now constructs every
  client with `options: { fetchMarkets: { types: ['spot'] } }`, which both avoids the wasted call and
  fixed a real 500 where that futures subdomain was unreachable in the dev sandbox.
- **Backtest cash accounting bug (fixed):** the simulation initially deducted only the trading *fee*
  from cash on entry, never the position's principal cost, while crediting the *full* exit value back
  on close — a self-multiplying bug that turned a $10,000 backtest into $24 billion after 24 trades.
  Fixed by debiting `orderValue + fee` on entry to match the credit of `exitValue - fee` on exit;
  re-verified against live KuCoin history afterward (a realistic -3.56% over 30 days).

## 8. Open Decisions Carried Into Phase 3
- Exact schema-validation approach for request bodies (hand-rolled vs. a minimal MIT-licensed validator) — will decide when writing `middleware/validation.js`.
- Which exchange(s) to default to in `.env.example`/README examples — will pick 1–2 with confirmed working `setSandboxMode` per the Phase 1 §9 recommendation (quick capability probe script) before finalizing Demo-mode docs.
