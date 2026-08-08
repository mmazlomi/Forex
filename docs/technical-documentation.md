# Technical Documentation

## 1. Objective

A browser-based trading platform combining technical and fundamental analysis to generate
BUY/SELL/HOLD/NO_DATA signals, with three execution modes — **Backtest**, **Demo (paper)
Trading**, and **Real (live) Trading** — built entirely in Node.js/Express (backend) and Vanilla
JS/HTML/CSS (frontend), no TypeScript, no frontend framework.

## 2. Scope

**In scope (implemented):** asset watchlist management with an exchange/watchlist picker UI;
10 technical indicators; stock fundamentals (Finnhub) and crypto fundamentals (CoinGecko); a
transparent, documented scoring engine; a 10-step risk-validation pipeline; historical
backtesting with no-look-ahead simulation, fees, and slippage; Demo trading with simulated
fills; Real trading gated behind multiple explicit safety checks; AI Auto-Trading (Demo-only,
scheduler-driven, reuses the manual signal/order pipeline verbatim — see architecture.md §12);
per-mode risk settings; emergency stop (global/demo/real); structured logging with secret
masking; a full REST API; a tabbed Vanilla JS dashboard with a full trading chart (candles,
volume, SMA/EMA/Bollinger overlays, synced RSI sub-chart).

**Out of scope (v1):** short-selling/margin/futures (spot long-only); multi-exchange order
routing for a single trade; WebSocket/streaming price feeds (REST polling only); a public
multi-tenant deployment (single-user, single-process design); a database migration system
(schema changes during development were handled by editing `schema.js` directly — see
Limitations).

## 3. Limitations (stated plainly)

- **No real exchange sandbox was exercised end-to-end.** ccxt's `setSandboxMode(true)` is wired
  up and a startup capability probe (`GET /api/system-status` → `demoSandbox`) tells you whether
  the configured exchange declares a sandbox URL, but no automated test places an order against
  an actual testnet.
- **No browser-based UI test was run.** The frontend was verified via syntax checks, static
  analysis (no unsafe `innerHTML`), manual tracing of every API-response shape against the
  frontend code, and live exercising of the underlying APIs — but nobody has clicked through it
  in an actual browser yet. See `docs/test-report.md` for the full statement. This includes the
  chart: every `LightweightCharts` API call used (`addHistogramSeries`, `createPriceLine`,
  `LineStyle.Dashed/Dotted`, `priceScale(id)`) was cross-checked against the actual installed
  package's type definitions and confirmed to exist with matching signatures — real evidence,
  not a guess — but rendering/interaction (does the RSI sub-chart actually stay in sync when you
  scroll, do the toggle checkboxes visibly show/hide series) has not been eyeballed in a browser.
- **No coverage tooling** is configured; test coverage is described qualitatively (`docs/test-report.md`), not as a percentage.
- **Single fundamentals provider per asset class** (Finnhub for stocks, CoinGecko for crypto) —
  the mandatory single `FUNDAMENTAL_API_KEY` env var didn't leave room for the multi-provider
  fallback chain considered in Phase 1/2.
- **No DB migration system.** Schema changes during development were applied by editing
  `schema.js` and deleting the (gitignored, regenerable) dev database file. Fine for a
  pre-release hobby project; a real migration tool (or at least a version-stamped migration
  runner) should be added before this ever holds data anyone cares about keeping across schema
  changes.
- **In-memory rate limiter** is per-process — correct for the single-instance scope this targets,
  not for a horizontally-scaled deployment.

## 4. Architecture

See [architecture.md](./architecture.md) for the full breakdown (stack, directory layout,
request flow, database isolation strategy, and every deviation from the original Phase 1/2 plan
with the reason). Summary of the request path:

```
Browser → Express routes → middleware (rate limit, mode validation) → controllers
  → services (market-data, technical-analysis, fundamental-analysis, signals, risk, portfolio,
    orders, backtesting, exchanges, logging)
  → database repositories (parameterized queries) / external APIs (ccxt, Finnhub, CoinGecko)
```

## 5. Database and mode separation

17 tables. Money-bearing data (`orders`, `positions`, `portfolio`) is split into physically
separate `demo_*`/`real_*` tables rather than a shared table with a mode filter, so a missing
`WHERE` clause cannot leak Real data into a Demo view — see
[architecture.md §4](./architecture.md#4-database) for the full rationale and table list.
Credentials are never persisted — `process.env` only.

## 6. APIs

Full reference: [api-documentation.md](./api-documentation.md). 38 endpoints total: the 20 from
the original spec, plus `GET /api/candles` and `GET /api/indicator-series` (charting needs raw
OHLCV and historical indicator series, which no other endpoint exposed), `GET /api/backtest` /
`GET /api/backtest/:runId` (listing/inspecting past runs), `GET /api/exchanges` /
`GET /api/exchanges/symbols` (exchange and symbol pickers), `PUT /api/assets/:symbol/auto-trade`
(AI Auto-Trading toggle), the strategy engine + optimizer additions: `GET /api/strategies`,
`PUT /api/assets/:symbol/strategy`, `POST /api/backtest/optimize` (see
[architecture.md §13](./architecture.md#13-strategy-engine--hyperopt-lite-optimizer-freqtrade-inspired-redesign)),
the auth additions: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`,
`GET /api/auth/me` (see [architecture.md §14](./architecture.md#14-user-accounts) — every other
endpoint now requires a logged-in session), the real-exchange-credentials additions:
`GET`/`PUT`/`DELETE /api/real-exchange-credentials` (see
[architecture.md §15](./architecture.md#15-real-exchange-credentials-via-the-ui)), and
`POST /api/portfolio/real/sync-balance` (see
[architecture.md §17](./architecture.md#17-real-balance-sync-on-demand-not-automatic)).
Every endpoint uses the standardized `{success, data, message, timestamp}` envelope and a
machine-readable `errorCode` on failure.

## 7. Technical indicators

SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Stochastic Oscillator, ADX, Ichimoku Cloud (via the
`technicalindicators` npm package), plus two hand-written modules the package doesn't cover:
Support/Resistance (pivot-based swing-high/low detection with a configurable lookback) and
Volume Analysis (volume SMA + relative volume). Every indicator independently reports
`{ value, status }`, where `status` is `"ok"` or `"insufficient_history"` — one indicator's
missing history never blocks another's (e.g. MACD needing 35 candles doesn't prevent RSI, which
needs only 15, from returning a value). Implementation: `src/services/technical-analysis/`.

Ichimoku is the one indicator here needing a correction beyond raw history length: the
`technicalindicators` package computes Senkou Span A/B at every bar but doesn't displace them —
on a real Ichimoku chart those spans are plotted `displacement` (26) bars ahead of where they're
calculated, so "the cloud actually overhead right now" is the spanA/spanB pair computed 26 bars
ago, not the most recently computed pair (`ichimoku.js` reads `values[values.length - 1 -
displacement]` explicitly for this reason). Needs `spanPeriod + displacement` = 78 candles before
reporting `"ok"`, more than any other indicator here.

## 8. Fundamental analysis

Stocks via Finnhub (`FUNDAMENTAL_API_KEY` as the token): Revenue/Net Income/Cash Flow require a
paid Finnhub tier and are marked `unavailable` on the free tier; EPS, P/E, Debt Ratio, Market
Cap, Revenue Growth, and News are available free. Crypto via CoinGecko's public/keyless
endpoint: Market Cap, FDV, Circulating/Total Supply, 24h Volume, and a health status derived
from 24h price change; Liquidity, Exchange Listings, Events, and News are marked `unavailable`
(CoinGecko's free tier doesn't expose them directly). Every field carries `{value, source,
fetchedAtUtc}` or an explicit `unavailable`/`not_applicable` marker — **never a fabricated or
defaulted value**. Cached 15 minutes per symbol+assetType (`fundamentals_cache` table).
Implementation: `src/services/fundamental-analysis/`.

## 9. Signals and scoring

```
Final Score = (Technical Score × Technical Weight) + (Fundamental Score × Fundamental Weight)
```

Defaults: Technical Weight 0.6, Fundamental Weight 0.4 (both configurable per call via
`scoringConfig`). Technical Score is a weighted average of per-indicator sub-scores in `[-1,+1]`,
each with a human-readable reason (e.g. `"RSI 25.0 < 30 → oversold (bullish)"`) —
`src/services/signals/technical-scorer.js`. Fundamental Score derives from the normalized
health-status field — `src/services/signals/fundamental-scorer.js`. Status thresholds: `≥0.3`
BUY, `≤-0.3` SELL, else HOLD; forced `NO_DATA` when no indicator has enough history, or when
fundamentals are unavailable and their weight is `>0` (the "never fabricate" rule — this is
tested explicitly, see `tests/unit/scoring-engine.test.js`). A would-be BUY/SELL downgrades to
HOLD (not NO_DATA) if ATR is unavailable to size a stop-loss. Entry/stop/take-profit are
constructed from ATR × a configurable multiplier, sized to exactly meet the configured minimum
risk/reward ratio. Full detail: `src/services/signals/scoring-engine.js`.

Per-indicator weights, the technical/fundamental balance, buy/sell thresholds, and the ATR
multiplier can all be bundled into a named, swappable **strategy** instead of set ad hoc per call
— `src/services/signals/strategies.js` ships 5 built-ins (`balanced`, `trend-following`,
`mean-reversion`, `momentum`, `fundamentals-driven`). See
[architecture.md §13](./architecture.md#13-strategy-engine--hyperopt-lite-optimizer-freqtrade-inspired-redesign).

## 10. Risk management

`src/services/risk/`: `position-sizing.js` (pure formulas) and `validate-trade.js` (the 10-step
pipeline, also pure — no DB/network access, fully unit-testable).

```
Maximum Risk Amount = Portfolio Balance × Maximum Risk Percentage
Position Size = Maximum Risk Amount / |Entry Price − Stop-Loss Price|
```

The 10 checks, in order (first failure wins, each returns a specific `reasonCode`): emergency
stop, live-trading gate (real mode), data quality/freshness, risk/reward minimum, order-size
bounds (max and exchange minimum), max open positions, max daily loss, max portfolio exposure,
sufficient balance, duplicate order. All 10 branches are covered in `tests/unit/risk.test.js`.

Position sizing is automatic by default (the formula above), but both order forms have an
optional **Amount** field (`qty` end to end: `dashboard.js` → `POST /api/orders/{demo,real}` →
`validateTrade`'s `qtyOverride`) for trading a specific amount instead. An override is still
bounded by the same Maximum Risk Amount an automatic size is built to never exceed — supplying an
amount that would risk more than that (given the order's stop distance) is rejected as
`RISK_AMOUNT_TOO_LARGE`, naming the largest amount that would've been accepted, rather than
silently clamping it down. This is what a trader wants when the auto-sized position would land
above `maxOrderValue` on a tight stop (a `$100` risk on a stop just `$0.50` away from entry auto-
sizes into a large position) — Amount lets them trade less than the max instead of being stuck
between "reject" and "raise `maxOrderValue`."

## 11. Backtesting

`src/services/backtesting/`: `historical-data.js` (paginated ccxt fetch with retry/backoff,
cached), `backtest-engine.js` (the simulation loop), `metrics.js` (drawdown, win rate, profit
factor, etc.). No look-ahead by construction — a signal is decided using `candles[0..i]` only,
filled at candle `i+1`'s open. Fees and slippage applied symmetrically on entry/exit (a real bug
where they weren't — see `docs/phase2-requirements-architecture.md §7a` — inflated $10,000 to
$24 billion before being caught and fixed). Never places an exchange order under any code path.
Fundamental weight is always forced to 0 for backtests (no look-ahead-free historical
fundamentals feed exists). `src/services/backtesting/optimizer.js` adds a grid-search parameter
optimizer ("hyperopt-lite") on top of the same engine — see
[architecture.md §13](./architecture.md#13-strategy-engine--hyperopt-lite-optimizer-freqtrade-inspired-redesign).
Always returns `"Past performance does not guarantee future results."`.

## 12. Demo trading

`src/services/orders/demo-orders.js`. Default mode. Virtual balance seeded from
`INITIAL_DEMO_BALANCE`. Buy opens a position sized by the same risk pipeline as Real; Sell closes
an existing open position at the current live price (long-only spot in v1). Simulated fills only
— no code path in this file calls any exchange order-placement endpoint.

## 13. Real trading guardrails

`src/services/orders/real-orders.js`. Gated behind, in order: `ENABLE_LIVE_TRADING=true`, valid
`REAL_*` credentials, a UI-supplied `confirmationText === "CONFIRM"`, no active emergency stop,
fresh/valid market data, the full risk pipeline, then (only then) a live balance fetch and order
placement via ccxt, with every request/response pair written to `real_audit_log`. No fallback to
Demo on any failure. Structurally separate file from `demo-orders.js` — see
[architecture.md §5](./architecture.md#5-demoreal-isolation--the-five-enforcement-mechanisms)
for the five independent enforcement mechanisms.

## 14. Error handling

Every route handler is wrapped (`src/middleware/async-handler.js`) so a thrown/rejected error
reaches Express's error handler in `server.js`, which logs a masked message and returns a
generic `500 INTERNAL_ERROR` — stack traces and secrets never reach an API response. Business-
rule rejections (risk checks, validation) return their specific `errorCode` and a human message
instead of a generic 500.

## 15. Logging

`src/services/logging/logger.js`: structured `{level, category, message, meta, mode}` entries,
written to both console and the `logs` table. Every message and meta object passes through
`src/utils/mask-secrets.js`, which redacts exact occurrences of the real, currently-configured
secret values (API keys/secrets) — not a blind "mask anything long" heuristic, which was tried
first and regressed readability by also masking harmless reason codes like
`LIVE_TRADING_DISABLED` (caught and fixed in Phase 5).

## 16. Security

- Parameterized queries everywhere (`node:sqlite` prepared statements) — no string-concatenated
  SQL; verified with SQL-metacharacter-laden inputs in `tests/security/sql-injection.test.js`.
- Credentials: `.env` only, never persisted to the database, masked in every log/error path.
- Rate limiting: 300 req/min general, 20 req/min on order placement, both per-IP.
- XSS: frontend renders exclusively via `textContent`/`createElement`, never `innerHTML` with
  dynamic content — statically verified in `tests/security/xss-safe-rendering.test.js`.
- Timeouts + bounded retry with exponential backoff on every outbound HTTP call
  (`src/utils/retry.js`, `REQUEST_TIMEOUT_MS`/`MAX_API_RETRIES`).

## 17. Environment variables

See `.env.example` for the authoritative list and defaults; `config/config.js` validates all of
them at boot and fails fast with a specific message on an invalid combination (e.g.
`ENABLE_LIVE_TRADING=true` without real credentials).

## 18. Deployment / port configuration

Single Node process, `npm start`. `PORT` env var (default 3450); on `EADDRINUSE` the process
prints instructions and exits rather than silently failing (it suggests `config.port + 100` as
a likely-free alternative):

```bash
PORT=3550 npm start                    # Linux/macOS
$env:PORT=3550; npm start              # Windows PowerShell
```

No separate build step — static frontend files are served directly by Express from `public/`.

## 19. Troubleshooting

See [user-guide.md §Troubleshooting](./user-guide.md#troubleshooting) for the user-facing table.
Developer-level: check `GET /api/logs` and `GET /api/system-status` first; both are safe to
share/screenshot since secrets are masked before storage.

## 20. Future work

- Verify `setSandboxMode(true)` against a real exchange testnet end-to-end (the capability probe
  exists; a live connectivity test doesn't).
- Add a proper DB migration system before any real schema evolution post-release.
- Add browser-based UI tests (Playwright/Puppeteer) once available in the target environment.
- Per-field fundamentals TTLs (currently one 15-minute TTL for all fields) — market data changes
  faster than annual financial statements.
- FMP/CoinMarketCap as secondary fundamentals providers, if a multi-key configuration is ever
  wanted.
- Coverage tooling (`c8` or similar) for a quantitative coverage number.
- A shared-store rate limiter if this is ever run as more than one process.
