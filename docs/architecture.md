# Architecture

This is the up-to-date architecture reference, reflecting what was actually built (Phases 3–7).
For the research and design rationale behind these choices, see
[phase1-technology-selection.md](./phase1-technology-selection.md) and
[phase2-requirements-architecture.md](./phase2-requirements-architecture.md) — this document
supersedes their specifics where the two disagree (a handful of things changed during
implementation; each is called out below with why).

## 1. Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 22 (developed/tested on 24.18.0) |
| Web framework | Express (plain JS, CommonJS) |
| Database | `node:sqlite` (`DatabaseSync`) — **not** `better-sqlite3** as originally planned; see §6 |
| Exchange integration | `ccxt` |
| Technical indicators | `technicalindicators` (+ two hand-written modules for Support/Resistance and Volume Analysis, which the library doesn't cover) |
| Fundamentals | Finnhub (stocks) + CoinGecko (crypto) — **not** the 4-provider set originally planned; see §7 |
| Charting | TradingView Lightweight Charts (CDN `<script>` tag) |
| Frontend | Vanilla JS/HTML/CSS, no build step, no framework |
| Tests | Node's built-in test runner (`node --test`) |

No TypeScript anywhere. No native compilation required for any dependency actually used.

## 2. Directory layout (as built)

```
trading-bot/
├── server.js                    Express bootstrap, PORT/EADDRINUSE handling
├── config/config.js             env loading + fail-fast validation
├── src/
│   ├── routes/                  thin HTTP layer, one file per resource + index.js mount
│   ├── controllers/             request orchestration, calls services, formats responses
│   ├── middleware/               async-handler, rate-limiter, validate-mode
│   ├── services/
│   │   ├── market-data/          ccxt wrapper, candle validation, caching
│   │   ├── technical-analysis/   one module per indicator + an aggregator
│   │   ├── fundamental-analysis/ provider adapters + normalizing cache-through layer
│   │   ├── signals/              technical/fundamental scorers + scoring engine + orchestrator
│   │   ├── risk/                 position sizing + the 10-step validation pipeline (pure functions)
│   │   ├── portfolio/            balance/position bookkeeping (mode-parameterized)
│   │   ├── orders/               demo-orders.js and real-orders.js — no shared execution code
│   │   ├── exchanges/            ccxt client factory (public/demo/real, spot-only)
│   │   ├── backtesting/          historical data fetch, replay engine, metrics
│   │   └── logging/              structured logger with secret masking
│   ├── database/
│   │   ├── schema.js             all CREATE TABLE statements
│   │   ├── connection.js         DatabaseSync wrapper, :memory: support for tests
│   │   └── repositories/         one file per table/table-group, parameterized queries only
│   └── utils/                    mask-secrets, retry (backoff), http-response envelope helpers
├── public/                      static frontend (index.html, css/, js/)
├── tests/{unit,integration,security,fixtures}/
├── docs/                        this document set
└── data/                        trading-bot.sqlite (gitignored, created on first boot)
```

`src/api/` and `src/models/` from the original skeleton proposal were removed — they stayed
empty through Phases 4–7 (`controllers/` covers what `api/` would have, and plain objects /
repository return values covered what `models/` would have) and keeping empty scaffold
directories around would just be clutter.

## 3. Request flow

```
Browser (public/js/*.js)
   │ fetch()
   ▼
Express routes (src/routes) ──▶ middleware (rate limit, mode validation)
   │
   ▼
Controllers (src/controllers) ── formats the {success,data,message,timestamp} envelope
   │
   ▼
Services (src/services/*) ── all business logic; no service imports a controller or route
   │
   ├──▶ src/database/repositories/* ── parameterized queries only
   └──▶ ccxt / Finnhub / CoinGecko ── wrapped with retry+backoff (src/utils/retry.js)
```

Dependency direction is strictly one-way: routes → controllers → services → repositories/external
APIs. No service reaches back up into a controller or route.

## 4. Database

17 tables (`src/database/schema.js`), applied via `CREATE TABLE IF NOT EXISTS` on every boot
(`connection.js`). **Isolation strategy: separate physical tables per mode** for anything
money-bearing (`demo_orders`/`real_orders`, `demo_positions`/`real_positions`,
`demo_portfolio`/`real_portfolio`) rather than a shared table with a `mode` filter column — a
missing `WHERE` clause structurally cannot leak Real data into a Demo query, because the tables
are different tables. Table selection for these is centralized in
`src/database/repositories/mode-tables.js`, which validates `mode` against the `'demo'|'real'`
enum before ever using it to pick a table name — the only place a mode string influences SQL
text, and it can't be anything other than those two literal values.

Non-monetary shared data (`assets`, `candles`, `fundamentals_cache`, `signals`, `logs`) uses one
table each; `signals` and `logs` carry a `mode`/`source_mode` column for filtering, since a
signal is an analysis artifact, not money at risk.

**No credentials table.** Real/demo exchange API keys live only in `process.env`, read once at
process start by `config/config.js`, and are never written to SQLite, logged, or returned in an
API response (`src/utils/mask-secrets.js` + `src/services/logging/logger.js` mask any configured
secret value that happens to appear in a log message or error).

Full DDL: `src/database/schema.js`. Table-by-table field descriptions: originally documented in
[phase2-requirements-architecture.md §4](./phase2-requirements-architecture.md#4-database-schema-sqlite-via-nodesqlite);
two columns were added during implementation (`demo_positions`/`real_positions.exit_price`,
`.closed_at_utc`, `.realized_pnl`; `demo_orders`/`real_orders.realized_pnl`;
`backtest_trades.exit_reason`) to support P&L accounting and backtest trade auditing that the
original schema draft hadn't fully accounted for.

## 5. Demo/Real isolation — the five enforcement mechanisms

1. **Database**: physically separate tables (§4).
2. **Services**: `src/services/orders/demo-orders.js` and `real-orders.js` are separate files
   with no shared execution function — they only share the pure, DB-free `validate-trade.js`
   module (mode is just a parameter it uses to pick which config to read, never a branch on
   execution behavior) and the `portfolio-service.js` bookkeeping functions (also mode-parameterized
   data access, not execution decisions).
3. **Middleware/guard**: `real-orders.js` checks `config.enableLiveTrading` fresh on every call
   (not cached at boot) before doing anything else — including before the first network call.
4. **No fallback rule**: every failure path in `real-orders.js` returns a rejection via
   `persistRejected()`; there is no code path that calls `demo-orders.js` as a substitute.
5. **UI**: the Real tab starts fully hidden behind a session-only typed-phrase unlock, plus a
   separate typed `CONFIRM` requirement on every individual real order — see
   [user-guide.md](./user-guide.md#real-trading-safety).

## 6. Deviation: `node:sqlite` instead of `better-sqlite3`

Phase 1/2 recommended `better-sqlite3`. During Phase 3, `npm install` failed to build it — no
prebuilt binary for the dev platform, and the node-gyp fallback couldn't reach `nodejs.org` to
compile from source (network-restricted dev sandbox). Node 22.5+ ships `node:sqlite`
(`DatabaseSync`) built in, needing no native compilation. Switched over; verified all 17 tables
create correctly and the API (`.exec()`, `.prepare().run()/get()/all()`) is close enough to
`better-sqlite3`'s to be a near drop-in.

**One real behavioral difference this surfaced**: `node:sqlite`'s bound statements throw
`Unknown named parameter` on an object with a key not referenced in the SQL — `better-sqlite3`
silently ignores extras. Every repository insert binds an object whose keys are an exact match
(a subset is fine if defaults are merged in first). This caught a real gap (`backtest_trades`
initially had no column for `exitReason`) during Phase 5.

## 7. Deviation: single fundamentals provider per asset class

The mandatory `.env.example` (project spec) defines one `FUNDAMENTAL_API_KEY`, which doesn't
leave room for the FMP/CoinMarketCap secondary providers floated in Phase 1/2. Implemented:
**Finnhub** for stocks (uses `FUNDAMENTAL_API_KEY` as the Finnhub token; every field returns
`"unavailable"` if unset, never fabricated) and **CoinGecko's public/keyless endpoint** for
crypto (works without any key on the free tier). See
[phase2-requirements-architecture.md §1.3](./phase2-requirements-architecture.md#13-fundamental-analysis).

## 8. Deviation: `GET /api/candles` added

The original 20-endpoint list has no way to fetch raw OHLCV data, but the UI spec requires a
price chart, which needs exactly that. Added as a minimal, documented addition
(`src/controllers/market-controller.js#getCandles`, `GET /api/candles?symbol&exchange&timeframe&limit`).

## 9. Signal generation pipeline

```
candles (market-data-service, validated) 
   → indicators (technical-analysis, each reports its own status)
   → technicalScore (technical-scorer.js, weighted sub-scores with reasons)
fundamentals (fundamental-analysis, cached 15min)
   → fundamentalScore (fundamental-scorer.js, health-status-derived)
   → Final Score = technicalScore × technicalWeight(0.6) + fundamentalScore × fundamentalWeight(0.4)
   → status: BUY (≥0.3) / SELL (≤-0.3) / HOLD / NO_DATA
   → entry/stopLoss/takeProfit constructed from ATR, only if status is BUY/SELL and ATR is available
   → emergency-stop override: BUY/SELL forced to... nothing changes for HOLD; BUY/SELL only
     proceeds if the relevant scope's emergency stop is inactive (src/services/signals/index.js)
```

Full formulas and the "never fabricate" rule: [phase2-requirements-architecture.md §1.4](./phase2-requirements-architecture.md#14-signal-generation--scoring).

## 10. Backtesting

No look-ahead by construction: a signal is decided using `candles[0..i]` and filled at candle
`i+1`'s open (see `src/services/backtesting/backtest-engine.js`). Fees and slippage are applied
symmetrically on entry and exit — this specific symmetry was the subject of a real bug (Phase 5):
the first implementation debited only the fee on entry while crediting the full exit value on
close, which is not the same operation reversed and self-multiplied a $10,000 backtest into $24
billion over 24 trades. Fixed by debiting `orderValue + fee` on entry to match `exitValue - fee`
on exit. Re-verified against live KuCoin history afterward (a realistic -3.56% over 30 days).

## 11. What's next

See `docs/technical-documentation.md` §"Future Work" for a consolidated list (real-testnet
capability verification, per-field fundamentals TTLs, a proper DB migration system, coverage
tooling, browser-based UI tests).

## 12. AI Auto-Trading (post-launch addition)

`src/services/scheduler/auto-trader.js` — a `setInterval` loop (`AUTO_TRADE_INTERVAL_MS`, default
5 min, minimum 30s, an addition beyond the original `.env.example`) started only from `server.js`'s
real boot path (not from `createApp()`, so test servers never run it). Each tick calls
`assetsRepository.listAutoTradeEnabled()` (`assets.auto_trade_enabled`, a new column) and, per
asset, `signalsService.generateSignal()` → `demo-orders.placeDemoOrder()` — the *exact* same
functions a manual Demo order goes through, not a parallel implementation. This is the load-bearing
safety property: the module has no code path that touches `real-orders.js`, `MODE` is a
module-level `const` set to `'demo'` (not a parameter, not configurable), and every risk/emergency-stop
check a manual order gets, an auto-trade gets too, for free, by construction. Verified in
`tests/integration/auto-trader.test.js` (BUY/SELL mechanics, no double-entry while positioned,
resilience to one asset's failure, and an explicit "never touches `real_orders`" assertion).

Also added in this pass: `GET /api/exchanges` (curated ccxt list for the exchange picker),
`GET /api/indicator-series` (full historical SMA/EMA/RSI/Bollinger series, time-aligned to candle
timestamps via `technical-analysis/series.js`, for the chart's overlay toggles — distinct from
`computeAllIndicators()`, which only needs the latest value), and a fix to `assets-controller.js`
that had been requiring `ccxt.loadMarkets()` validation for *all* assets including `assetType:
"stock"`, which could never pass since ccxt has no stock exchanges — stock assets now skip that
check (their fundamentals still work via Finnhub; charts/candles/signals for stocks remain
unsupported, per §8 of technical-documentation.md).

## 13. Strategy engine + hyperopt-lite optimizer (Freqtrade-inspired redesign)

`src/services/signals/strategies.js` introduces named, swappable strategy configs — a bundle of
per-indicator weights, technical/fundamental balance, buy/sell score thresholds, and an ATR
stop-loss multiplier — without touching the indicator-direction logic itself
(`technical-scorer.js` was refactored so every `score*` function takes an explicit `weight`
parameter instead of a hardcoded one; `computeTechnicalScore()` merges `DEFAULT_WEIGHTS` with
whatever a strategy overrides). Five built-ins ship (`balanced`, `trend-following`,
`mean-reversion`, `momentum`, `fundamentals-driven`); a `strategy_id` column persists a choice per
watchlist asset (`assets` table) and is threaded through `signals`/`backtest_runs` for
provenance. `generateSignal()`, `runBacktest()`, and `optimizeStrategy()` all resolve
`strategyId → getStrategy() → merged config`, with explicit `scoringConfig` overrides (if any)
winning over the strategy's own defaults. Auto-trading reads each asset's stored `strategy_id` on
every tick, so a per-asset strategy choice governs Demo Auto-Trading automatically, with no
separate configuration surface.

`src/services/backtesting/optimizer.js` — a deliberately simple grid-search "hyperopt-lite" over
the same backtest engine (real Freqtrade hyperopt uses Bayesian search via `scikit-optimize`; this
avoids that dependency entirely). This required splitting `backtest-engine.js`'s previously
monolithic `runBacktest()` into three composable pieces: `fetchCandlesForBacktest()` (network +
DB, unchanged fetch logic), `simulateStrategy()` (the existing pure, synchronous, no-look-ahead
replay loop, now callable standalone), and `buildScoringConfig()` (strategy + override merging,
forcing `fundamentalWeight: 0`/`technicalWeight: 1` for any backtest context, with a warning if the
chosen strategy normally weighs fundamentals — inert during backtests since there's no
look-ahead-free historical fundamentals feed). The optimizer fetches candles **once** via
`fetchCandlesForBacktest()` and calls `simulateStrategy()` in-memory for every strategy ×
threshold combination in the grid (capped at 60 combinations), which keeps a 15-combination run to
roughly the cost of one backtest's network fetch — verified live at ~27s for 15 combinations
against KuCoin. Results are ranked by a caller-chosen metric (`totalPnlPercent` by default) and
returned with an explicit overfitting-risk disclaimer.

Frontend: a **Strategy** dropdown in the header (synced to/persisted against the loaded asset's
saved `strategy_id` when it's on the watchlist) and a separate one on the Backtest tab, both
populated from `GET /api/strategies`; a **Run Optimizer** button and leaderboard table on the
Backtest tab, with a per-row **Apply** action that loads a result's strategy + thresholds into the
backtest form's next submission via `scoringConfig`. Also added: a status bar
(`public/index.html` `#status-bar`, sticky below the risk warning, visible on every tab) showing
mode balance, net P&L, open-position count, and emergency-stop state — refreshed on a fixed
15-second timer plus immediately after mode switches, order placement, and emergency-stop
actions, independent of `initTabs()`'s per-tab refresh logic. A light "trading-terminal" visual
pass (`public/css/styles.css`) tightened card/grid spacing and switched numeric displays
(`.stat-list dd`, `.data-table`) to a monospace font stack, purely cosmetic — no markup semantics
changed.

All of the above verified against the live server with real KuCoin data (not fixtures) both at
the HTTP layer (`curl`) and by loading the actual production `public/js/dashboard.js` into a
hand-built Node DOM mock and dispatching real click/change events — the same technique used
earlier in the project to isolate the Confirm Order dialog CSS bug — to confirm the new strategy
selector, optimizer leaderboard, "Apply" action, and status bar all wire up correctly end-to-end,
not just at the API layer.

## 14. User accounts

Standard username/password sign-up, added post-launch. Two deliberate scope decisions (confirmed
with the project owner before implementation, since both are hard to walk back cheaply):

1. **Login is mandatory for the whole app** — every `/api/*` route requires a valid session
   except `GET /api/health` and `/api/auth/*` themselves (`server.js`: `app.use('/api/auth',
   authRoutes)` is mounted *before* `app.use('/api', requireAuth)`, so the auth endpoints
   short-circuit ahead of the gate). The frontend (`public/js/auth.js`) blocks the dashboard
   behind a full-screen login/signup gate until `GET /api/auth/me` confirms a session.
2. **Every account's trading data is fully isolated.** Watchlists, Demo/Real portfolios, orders,
   positions, risk settings, and real exchange credentials are all scoped by `user_id` — no two
   accounts ever see or affect each other's balance, positions, order history, or API keys. The
   one deliberate exception is the **global** emergency stop scope, an instance-wide panic button
   any logged-in user may trigger, which halts trading for every account regardless of who
   triggered it (`demo`/`real` scoped stops remain per-user; `emergency-stop-repository.js` checks
   the global override first, then falls back to the triggering user's own scoped state). This was
   originally a single-shared-account design ("one shared trading bot, multiple logins") and was
   later migrated to genuine per-user isolation,
   including the AI auto-traders — see the per-user isolation migration notes below and in
   `src/database/schema.js`. The AI auto-traders themselves remain single shared background
   *processes* (one scheduler, not one instance per user): `assets-repository.js#listAutoTradeEnabled()`
   and `futures-assets-repository.js#listAutoTradeEnabled()` are deliberately unscoped by `user_id`
   so each cycle can see every account's enabled watchlist rows in one query, then act on each
   using that row's own `user_id` — this is what lets one user's missing/invalid real credentials
   skip only their own assets without affecting any other user's trading (see
   `futures-auto-trader.js`'s per-cycle credentials cache).

**Mechanics**: `src/services/auth/password.js` hashes with Node's built-in `crypto.scryptSync`
(`salt:hash` hex, `crypto.timingSafeEqual` for comparison) — no bcrypt/argon2 dependency, avoiding
the exact native-compilation risk that ruled out `better-sqlite3` in §6. Sessions are random
64-hex-char tokens (`crypto.randomBytes(32)`) stored in a `sessions` table (not in-memory) so
logins survive a service restart, with a 30-day TTL checked on every request
(`src/middleware/require-auth.js`). The session cookie is hand-serialized
(`src/utils/cookies.js`, `HttpOnly; SameSite=Lax; Path=/`) rather than pulling in
`cookie-parser` — one more dependency avoided, consistent with this project's existing minimalism
(§1, §5). `Secure` is added to the cookie only when the request is actually HTTPS
(`req.secure` or `X-Forwarded-Proto: https`) — **the current nginx deployment is plain HTTP**, so
today the session cookie travels unencrypted; putting TLS in front of nginx would close this and
is recommended if this is ever reachable beyond a trusted local network. `/api/auth/login` and
`/api/auth/signup` each get their own stricter rate limiter (10/min and 5/min per IP,
respectively) via the existing `createRateLimiter` factory, on top of the general 300/min limit.

**Migration**: `assets` originally had no `user_id` column and a global `UNIQUE(symbol,
exchange)` constraint. SQLite can't alter an existing UNIQUE constraint via `ALTER TABLE`, so
`src/database/schema.js#migrateAssetsUserId()` does the standard SQLite rebuild-and-copy dance
(rename → recreate with `UNIQUE(user_id, symbol, exchange)` → copy rows with `user_id = NULL` →
drop the old table), wrapped in a transaction, run once, guarded by a `PRAGMA table_info` check
so it's a no-op on every subsequent boot and a no-op entirely on a fresh database (which is
created with the final schema directly). Verified against a copy of the actual production
database before deploying. The `UNIQUE(user_id, ...)` (not just `UNIQUE(symbol, exchange)`)
change matters beyond cleanliness: without it, two different accounts could never both watch the
same symbol on the same exchange — which, for the single most likely first asset anyone adds
(BTC/USDT), would have broken immediately for a second account.

Pre-existing watchlist rows have no owner after migration (`user_id IS NULL`) — nobody had an
account yet when they were created. Whoever signs up for the **very first account** on a given
deployment automatically claims all of them (`auth-controller.js#signup`, guarded by
`usersRepository.countUsers() === 0`, calling `assetsRepository.claimOrphanedAssets(user.id)`),
so the original single-user watchlist isn't silently orphaned the moment accounts exist. This
also means whoever signs up first after this feature is deployed inherits that data — on a
deployment reachable by more than just its owner, the owner should sign up immediately after
deploying this change.

## 15. Real exchange credentials via the UI

Real Trading originally required `REAL_EXCHANGE_NAME`/`REAL_API_KEY`/`REAL_API_SECRET` in `.env`,
edited by hand and requiring a restart — §4's stated design was explicitly "no credentials
table... never written to SQLite." This section documents a deliberate reversal of that specific
principle, added because editing server files isn't realistic for every deployment, with the
reversal offset by encryption at rest rather than left as a plain regression.

**Storage**: a new singleton-row table `real_exchange_credentials` (same pattern as
`demo_portfolio`/`real_portfolio`), holding `exchange_name` in plaintext and `api_key`/`api_secret`
each encrypted (AES-256-GCM, `src/services/security/secret-encryption.js`). The encryption key is
a random 32 bytes generated on first use and written to `data/credential-encryption.key`
(matches the existing `*.key` `.gitignore` pattern, mode `0600`, deliberately a *separate* file
from the database itself — a leak of the SQLite file alone doesn't also leak the key). This is
defense in depth, not a complete solution: anyone with full filesystem access to the server gets
both files regardless, same as they'd get `.env` today.

**Resolution/precedence**: `src/services/exchanges/real-credentials-resolver.js#resolveRealCredentials()`
checks the database first, falls back to `.env`'s `REAL_EXCHANGE_NAME`/`REAL_API_KEY`/`REAL_API_SECRET`
if nothing is stored, called fresh on every use (never cached) — both `exchange-client-factory.js#getRealExchange()`
and `real-orders.js`'s credential-completeness check (`MISSING_REAL_CREDENTIALS`) were changed to
call this instead of reading `config.realExchange` directly. Saving credentials via the UI takes
effect immediately, no restart — the one piece of Real Trading configuration that doesn't require
touching the server. `ENABLE_LIVE_TRADING` deliberately stayed `.env`-only and restart-required —
that's the master kill-switch, not exchange plumbing, and keeping it a deliberate server-operator
action (not UI-togglable) is intentional, unrelated to where the *credentials* live.

**Boot-time validation change**: `config.js` previously refused to boot at all if
`ENABLE_LIVE_TRADING=true` was set without complete `.env` Real credentials. That check has been
removed — the database isn't connected yet at config-load time, so it can no longer assert
credentials are absent; completeness is instead checked at the point of the resolver call, on
every real-order attempt, which already covers both sources (see
`tests/integration/real-credentials.test.js` for the "fails safe" coverage this replaces —
`tests/unit/config.test.js`'s equivalent case was updated to assert the new behavior: it now
boots successfully and defers the check).

**Never round-tripped**: `GET /api/real-exchange-credentials` returns only a masked preview
(`abcd****************wxyz`) and whether something is configured — never the actual key/secret,
write-only from the API's perspective like most secret managers. Private per account (§14) — each
user stores and sees only their own Real credentials, one set per user. The `.env`
`REAL_EXCHANGE_NAME`/`REAL_API_KEY`/`REAL_API_SECRET` fallback applies only to the one legacy
account whose data predates per-user isolation (see `LEGACY_DATA_OWNER_USERNAME` in
`src/database/schema.js`); every other account with no DB-stored credentials sees "not configured,"
never that fallback.

**CoinEx added** to the curated exchange list (`CURATED_EXCHANGE_IDS`, now 15 entries) and the
TradingView symbol-prefix map — same shape as every other curated exchange, no special handling.

**Digit-grouping bug fixed**: the Fundamental Analysis table was rendering numeric fields (Market
Cap, FDV, Supply, Volume — routinely 10+ digit values) via a plain `String(field.value)`, bypassing
the `fmt()` helper every other number in the app goes through. Large fundamental values displayed
with no thousand separators at all (e.g. `1279683100314` instead of `1,279,683,100,314`). Fixed
in `loadFundamentals()` (`public/js/dashboard.js`) to route numeric values through `fmt()`,
leaving non-numeric statuses (`"unavailable"`/`"not_applicable"`) and object-shaped fields
untouched.

## 16. Nobitex — a hand-written exchange adapter (not ccxt)

Every exchange in this app up to this point has been "add the id to a list" because ccxt already
implements it. Nobitex isn't a ccxt exchange at all (checked ccxt 4.5.70's full `ccxt.exchanges`
list — no match, no close alias), so supporting it meant writing a real adapter against
Nobitex's own REST API (`src/services/exchanges/custom-exchanges/nobitex-exchange.js`), shaped to
satisfy exactly the subset of the ccxt interface this app actually calls: `loadMarkets()`/
`markets`, `fetchTicker()`, `fetchOHLCV()`, `fetchBalance()`, `createOrder()`, `id`/`name`/`urls`.
`src/services/exchanges/custom-exchange-registry.js` maps `'nobitex' → NobitexExchange`, and
`exchange-client-factory.js#resolveExchangeClass()` checks that registry before falling through
to `ccxt[id]` — every other call site (`assets-controller.js`, `market-data-service.js`,
`real-orders.js`, etc.) resolves exchanges through that one function already, so nothing else
needed to change to make Nobitex usable everywhere a ccxt exchange is. `exchanges-controller.js`
and `real-credentials-controller.js` each have one additional registry check (exchange picker
listing; credential-exchange-id validation).

**Sourcing**: every endpoint shape below is taken directly from Nobitex's official docs
(https://github.com/nobitex/docs-api, fetched and read in full — not guessed, not inferred from
a client library). There's no dedicated "list all markets" endpoint, but `GET /market/stats`
called with no `srcCurrency`/`dstCurrency` filter returns live stats for every market Nobitex
currently offers, keyed by `"base-quote"` (~495 markets at last check) — `loadMarkets()` uses this
as the live market list. This adapter originally shipped with a hand-typed static list instead
(reproduced from the docs' `source/includes/_symbols.md`), but that drifted out of sync with
Nobitex's real, changing market list: it still listed `EOS` and `TON`, both fully delisted from
Nobitex, and listed `MATIC`, `RNDR`, and `SHIB` under names Nobitex no longer uses (renamed to
`POL`, `RENDER`, and `1K_SHIB` respectively) — every one of those silently failed with Nobitex's
`InvalidCurrency` error the moment a user picked them. Deriving the list live eliminates this
whole bug class rather than requiring the static list to be hand-updated every time Nobitex
delists or renames something. Each market's `active` flag is set from that same response's
`isClosed` field (a real, per-market Nobitex signal, not fabricated), so `symbol-list-service.js`
(which filters suggestions on `active !== false`) stops suggesting markets with no live order
book.

**Auth model — genuinely different from every other exchange here**: Nobitex authenticates with
a single bearer-style **Token** (`Authorization: Token <token>`), not an API-key/secret pair.
Nobitex's own documentation actively discourages automating the login flow that issues one
(requires CAPTCHA handling, 2FA/TOTP headers, and — critically — an Iran-based IP or it 429s);
their stated recommendation for most users is to copy a token directly from the account's
Profile → API settings page. This adapter implements **only that path** — it never sends a
username/password anywhere, and deliberately does not implement `POST /auth/login`. The
consequence: the app's "API Key" field carries the Nobitex Token, "API Secret" is unused
(`NobitexExchange.NO_SECRET_NEEDED = true`, checked by `real-credentials-controller.js` to skip
requiring one), and **the token expires** — 4 hours by default, up to 30 days if the user chose
"remember me" when generating it — unlike every other exchange's permanent API key, so it will
need periodic refreshing from the Real Trading tab. The frontend shows this explicitly
(`updateRealCredentialsExchangeHint()` in `dashboard.js`) when Nobitex is selected.

**Symbol/currency naming gotcha, and the Rial-vs-Toman unit bug**: Nobitex market symbols use an
`IRT` (Toman) suffix (`BTCIRT`), but the underlying currency-code parameter used by
`/market/stats`, `/market/orders/add`, and the wallet endpoints is `rls` (Rial, 1 Toman = 10
Rial) — confirmed by Nobitex's own request examples, not assumed. `nobitexCurrencyCode()` maps
the app-facing `IRT` quote to `rls` for every API call that needs a currency code rather than a
market symbol. Critically, **the values themselves are also denominated in Rial, not Toman** —
this adapter originally passed `rls`-currency numbers straight through unconverted under the
`IRT` label (`fetchTicker`, `fetchOHLCV`, `fetchBalance`), which meant every "IRT" price and
balance shown anywhere in the app was actually 10x the real Toman amount. Caught from a live user
report: their real Nobitex wallet balance (verified in their own Nobitex account) was 1728.55
Toman; this adapter's raw `RLS` wallet read was `17285.5083` — exactly 10x, not a rounding
coincidence. `RIALS_PER_TOMAN = 10` now converts every Rial-denominated value crossing the
adapter boundary: divided when reading a price/balance from Nobitex (`fetchTicker`, `fetchOHLCV`,
`fetchBalance`'s `IRT` alias), multiplied back when `createOrder` sends a price band to Nobitex's
own API. Volumes (base-asset units) and `dayChange` (a percentage, not a currency amount) are
never scaled — only absolute Rial/Toman prices are. `fetchBalance()` aliases the raw `RLS` wallet
to `IRT` (converted) so `real-orders.js`'s `balance.free[quoteCurrency]` lookup (which uses the
app's own symbol naming) finds it; the raw `RLS` key is also still returned unconverted, for
anything that wants Nobitex's own native unit.

**Wallet balances span multiple currencies at once**: unlike the ccxt exchanges here (where the
Real Portfolio realistically only ever holds one quote currency), Nobitex users commonly hold
several currencies simultaneously (IRT, USDT, BTC, ...). `portfolio.balance` stays a single
number scoped to whichever currency matches the asset currently loaded (needed as-is by
`real-orders.js`'s position-sizing math), but `POST /api/portfolio/real/sync-balance` additionally
returns every non-zero currency from that same `fetchBalance()` call as `walletBalances` (not
persisted — on-demand only, like the scoped balance already was), rendered as a "Wallet Balances"
list under the Real Portfolio card so a user isn't stuck re-syncing once per currency to see
where their funds actually are.

**Closed/illiquid markets and the `mark` fallback**: `/market/stats` reports `latest: "0"` for a
market with no recent trade (typically alongside `isClosed: true`), but Nobitex separately
maintains a `mark` field — a live reference/index price — even for such markets. `fetchTicker()`
uses `latest` when it's a real (>0) trade price, falls back to `mark` when `latest` is `"0"` but
`mark` isn't, and only reports `last: null` when both are unavailable — never a fabricated `0`,
which would otherwise look to a user exactly like a real (and alarming) price of zero.

**Timeframes**: Nobitex publishes minute/hour/day candle resolutions but no weekly one at all.
Rather than approximate a `"1w"` by aggregating 7 daily candles (extra complexity, extra
surface for a subtly-wrong aggregation bug), `"1w"` is simply absent from this adapter's
`timeframes` map — `market-data-service.js#assertTimeframeSupported()` already rejects any
timeframe missing from an exchange's `timeframes` object, so a `"1w"` request for Nobitex fails
the same documented way an actually-unsupported ccxt timeframe would, not silently wrong data.

**Market orders always carry a price band**: Nobitex's own docs strongly recommend sending
`price` even on a `execution:"market"` order — it bounds the fill to within ~1% of that price,
protecting against an unexpectedly bad fill during a volatility spike — and warn that omitting it
lets the order fill at "however far the market moves." `createOrder()` always includes a price:
the caller's if given, otherwise fetched fresh via `fetchTicker()` immediately before submitting.

**No partial-fill handling (by design, matching the rest of the app)**: `real-orders.js` has no
concept of a partially-filled order anywhere — `createOrder()` resolving is treated as "fully
filled." Nobitex's order-submission response isn't a reliable fill confirmation on its own (its
own stop/OCO examples come back `"Active"`/`"Inactive"` immediately after submission), so this
adapter follows up with `POST /market/orders/status` and throws if the final status isn't
`"Done"`, rather than ever recording a partial fill as a complete one.

**Order types**: `market` and `limit` are implemented (`execution:"market"`/`"limit"` on
`/market/orders/add`; a limit order's price is required, never fetched as a fallback the way a
market order's protective band is). `fetchOrder`/`cancelOrder` map Nobitex's own status
vocabulary (`Active`/`Inactive`/`Done`/`Canceled`, from `/market/orders/status` and
`/market/orders/update-status` respectively) to ccxt's `open`/`open`/`closed`/`canceled`, used by
`pending-orders-watcher.js` to poll a pending limit order the same way it polls every ccxt
exchange. Nobitex's own docs (`_market_trade.md`) do document `execution:"stop_market"`/
`"stop_limit"` (with a `stopPrice` param) and OCO linkage via `update-status`'s own notes —
confirmed real, not unknown — but the Phase 1 order-types design deliberately scoped Nobitex to
limit-only; requesting anything else is rejected clearly
(`ORDER_TYPE_UNIMPLEMENTED_FOR_EXCHANGE` in `real-orders.js`), never guessed at.

**What this adapter deliberately does *not* do**: automate login (see auth model above); support
Stop/Stop-Limit/OCO orders (see above — documented and real on Nobitex's side, just not
implemented here yet); provide live per-market active/inactive flags or precision/lot-size
metadata (no such endpoint exists; Nobitex rounds amount/price server-side per its own documented
banker's-rounding rule, so this adapter doesn't need to replicate that).

**TradingView chart support — tried, reverted**: `charts.js`'s `EXCHANGE_TV_PREFIX` map has no
`nobitex` entry, after a real back-and-forth worth recording. This app originally assumed
TradingView had no Nobitex data at all (its symbol-search API, `symbol-search.tradingview.com`,
returns 403 from this project's dev sandbox, so it couldn't be checked directly) and shipped a
custom fallback chart instead (`createCandlestickChart` in `charts.js`, real OHLCV from
`/api/candles`, LightweightCharts — still used for any exchange with no TradingView listing).
That looked wrong when two independent TradingView-hosted chart snapshots turned up under the
exact symbol `NOBITEX:USDTIRT` (tradingview.com/x/PkOz8SRB/, tradingview.com/x/GNRwYEbR/), so
`nobitex: 'NOBITEX'` was added and the widget briefly became the default for Nobitex. A real user
then reported Nobitex symbols not showing in the actual chart. The likely explanation: that
`USDTIRT` snapshot is plausibly a tracked USD/Rial reference rate (useful for macro/FX purposes),
not evidence of full Nobitex market coverage — TradingView almost certainly doesn't track the
individual crypto pairs (`BTC/IRT`, `ETH/IRT`, etc.) a trader would actually chart. The basic
embed widget (`TradingView.widget({...})` via `tv.js`) is an opaque cross-origin iframe with no
callback for "this symbol failed to resolve" — unlike their self-hosted Charting Library, which
takes a custom datafeed and exposes real callbacks, but is a much larger integration this app
doesn't use — so there was no reliable way to detect a per-symbol failure and fall back
automatically. Rather than gamble on partial, unverifiable coverage and risk a blank
"invalid symbol" widget, `nobitex` was removed from the map again — Nobitex always gets the
fallback chart, which is real data every time. `allow_symbol_change: true` remains the user's
manual escape hatch for any *other* exchange's mapping turning out wrong.

**A real bug this surfaced and fixed**: `secret-encryption.js#decryptSecret()` originally
checked each `iv:authTag:ciphertext` part's *truthiness* rather than the split's part *count* —
an empty-string secret (exactly Nobitex's unused `apiSecret` placeholder) legitimately encrypts
to an empty-but-valid ciphertext segment, which is falsy in JS, so it was incorrectly rejected as
"malformed," breaking `GET /api/real-exchange-credentials` for any exchange not needing a secret.
Fixed to check `parts.length !== 3` instead. Caught during live verification against Nobitex's
real API before this shipped — see `tests/unit/secret-encryption.test.js`'s regression test.

Verified against Nobitex's real, live public API during development (not just mocked unit
tests): live ticker (`BTC/USDT` @ $63,749), live OHLCV candles, and the full indicator pipeline
all confirmed working end-to-end. The authenticated paths (balance, order placement) are covered
by `tests/unit/nobitex-exchange.test.js` with fetch mocked to Nobitex's documented response
shapes — verifying those live would require a funded Nobitex account and Token, which this
project doesn't have.

## 17. Real balance: sync on demand, not automatic

A real gap this exposed live: `real_portfolio.balance` only ever updated as a side effect of
`real-orders.js` actually placing an order (it calls `client.fetchBalance()` mid-pipeline, past
the `ENABLE_LIVE_TRADING`/credentials/unlock gates, purely to size the trade). There was no way
to just *view* your live balance — a user who entered a valid Nobitex Token saw an empty $0
portfolio indefinitely, because nothing had ever attempted an order yet to trigger a sync.

`POST /api/portfolio/real/sync-balance` (`portfolio-controller.js#syncRealBalance`) fixes this: a
read-only `fetchBalance()` call, gated only by credentials being configured — deliberately **not**
gated by `ENABLE_LIVE_TRADING`, since checking a balance places no order and risks nothing,
unlike every other Real-mode action in this app. Takes `{symbol, exchange}` in the body purely to
know which quote-currency wallet to read (same "`balance` is one number, scoped to one currency"
limitation `real-orders.js` already has — there's no multi-asset portfolio total anywhere in this
app). The frontend calls it two ways: automatically (quietly — failures don't show an error toast,
since the currently-loaded header asset may not match the exchange just configured) right after
saving credentials, and via an explicit **Refresh Balance** button on the Real Portfolio card for
ongoing use, since the stored balance is a snapshot that can go stale as the account trades or
moves funds outside this app.

## 18. Futures trading (Phase 2, KuCoin-only)

A fully separate, parallel system from everything above — its own tables (`demo_futures_*`/
`real_futures_*`/`futures_risk_settings`), services, routes, and UI tab — not an
extension of Spot's. The reason: futures ccxt symbols use `BASE/QUOTE:SETTLE` (e.g.
`BTC/USDT:USDT`), a different shape from Spot's `BASE/QUOTE` that would silently break every
`symbol.split('/')[1]`-style quote-currency parse already scattered through the Spot code paths,
and futures introduces genuinely new concepts (leverage, margin, liquidation price, long/short
direction) the existing schema/risk engine have no representation for. Market orders only
(open/close), no partial closes, one-way position mode (one net position per symbol), isolated
margin only — each an explicit, named scope boundary, not an oversight.

**Exchange choice: KuCoin, not Bybit.** Originally built against Bybit (its ccxt class
unifies spot+futures under one `defaultType` flag), but this app's actual production host turned
out unable to reach `api.bybit.com` at all — confirmed live, both `403 Forbidden` (a CloudFront
geo/IP block) and connection timeouts from the real deployed server, not just a dev sandbox. Since
every futures price lookup and order call happens server-side, this made the whole feature
non-functional in production regardless of client network. Re-verified reachability from the same
host across several ccxt-supported futures exchanges and switched to KuCoin, which responded
correctly. Re-confirmed via a live `loadMarkets()` call from the production host (678 real futures
markets returned) that KuCoin's futures symbol format is the same `BASE/QUOTE:SETTLE` shape, so
most of the original design survived — but ccxt models KuCoin's futures API as a **separate
class** (`kucoinfutures`, not `kucoin` with a `defaultType` option), so `exchange-client-factory.js`
has a dedicated `resolveFuturesExchangeClass()` mapping the same user-facing/credential exchange
name (`'kucoin'`, used everywhere else in the app already) to that distinct class. Every futures
function hard-rejects any exchange id other than `'kucoin'`.

**Risk engine**: `validate-trade.js` gained two optional parameters, both defaulting to values
that make every existing (spot) call byte-for-byte unaffected: `leverage` (default 1) — only
affects the sufficient-balance check, `requiredMargin = orderValue / leverage`, since a leveraged
order only needs its margin on hand, not the full notional; and `marginUsed` (defaults to
`currentExposureValue`) — the sufficient-balance check needs the margin *already committed* by
open positions, not their notional, while the separate exposure-percent check correctly keeps
using notional (total market exposure relative to capital is the standard, leverage-aware
definition of "exposure"). `computePositionSize` needed no changes — risk per unit of the
underlying is leverage-independent.

**Liquidation safety** (`orders/liquidation-estimate.js`): a stop-loss beyond the liquidation
price provides no real protection (liquidation happens first). For Demo, liquidation is estimated
with the standard isolated-margin formula and a conservative flat maintenance-margin-rate
assumption, explicitly labeled as an approximation — pre-open, this rejects the order
(`STOP_LOSS_BEYOND_LIQUIDATION`). For Real, KuCoin's own `fetchPositions()` is queried immediately
after the position opens for its *actual* `liquidationPrice` (ccxt's unified `Position` type,
confirmed present in KuCoin's raw response and `parsePosition()` mapping) — by then the order has
already filled, so an unsafe stop is logged as a warning, not pre-blocked against a formula that
might not match KuCoin's real tiered margin model.

**Order services** (`futures-demo-orders.js`/`futures-real-orders.js`): body shape uses `action`
(`open_long`/`open_short`/`close`) instead of Spot's `side`, since a plain buy/sell is ambiguous
once both long and short exist. `futures-real-orders.js` mirrors `real-orders.js`'s gate order
exactly. Leverage/margin-mode setting is **not** a separate pre-call here (unlike the original
Bybit design) — confirmed by reading ccxt's `createContractOrderRequest()` source directly, KuCoin
sets both as part of the order itself: `createOrder(symbol, 'market', side, amount, undefined,
{marginMode: 'isolated', leverage})`. KuCoin's own `setLeverage()` method is CROSS-margin-only (it
calls the literal "ChangeCrossUserLeverage" endpoint and throws given any other marginMode), so
calling it here would be actively wrong for this app's isolated-margin default, not just
redundant. Closing sends `reduceOnly: true`. A dedicated `marginCurrencyFor(symbol)` helper
(splits on `:`, not `/`) exists specifically to avoid the `BASE/QUOTE:SETTLE` quote-parsing bug
described above.

**Watchlists are fully independent per mode, not a shared list with two flags.** The original
design had one `futures_assets` table per symbol with two booleans (`auto_trade_enabled` for Demo,
`real_auto_trade_enabled` for Real) — the user explicitly asked for Demo and Real to be genuinely
separate watchlists instead, able to hold different symbols entirely, mirroring the demo_X/real_X
convention every other Phase 2 table already uses. Split into `demo_futures_assets` and
`real_futures_assets` (each with a single `auto_trade_enabled` column, since which table a row
lives in already expresses Demo vs Real), resolved via `mode-tables.js`'s
`futuresAssetsTable(mode)`. `futures-assets-repository.js`'s functions all take `mode` as their
first parameter; `setRealAutoTrade()` was removed entirely — "enabling real auto-trade" is now
just `setAutoTrade('real', ...)`, since the table itself supplies the Real-ness. A one-time
migration (`migrateFuturesAssetsSplit` in `schema.js`) copies every pre-existing row into
`demo_futures_assets` (Demo was always the safe, on-by-default half) and, if a row also had
`real_auto_trade_enabled` set, additionally inserts it into `real_futures_assets` — verified
against a copy of the live database, which had 3 real rows, before it ever touched production.

**AI futures auto-trader** (`futures-auto-trader.js`): unlike Spot's auto-trader (hard-coded
Demo-only), the user explicitly chose to allow this one to place real, leveraged, unattended
trades — the highest-risk capability in the app. `runCycle()` iterates the Demo and Real
watchlists as two fully independent lists (`listAutoTradeEnabled('demo')` /
`listAutoTradeEnabled('real')`) — a symbol can be on one, the other, both, or neither, each with
its own leverage/strategy. The Real list is only even *fetched* when
`realAutoTradeGloballyAllowed()` — a pure, asset-less check of the account-level gates — passes:
the server-wide `ENABLE_FUTURES_AUTO_TRADING` env flag (restart-only, never a UI toggle — same
deliberately high-friction pattern as `ENABLE_LIVE_TRADING`), `ENABLE_LIVE_TRADING` itself, and
resolved KuCoin credentials. Per-symbol consent is no longer a separate flag checked per asset —
it's expressed by the symbol simply existing on the real_futures_assets list with its own
`auto_trade_enabled=1`. Leverage is clamped down (never up) to `FUTURES_AUTO_TRADE_MAX_LEVERAGE`
(default 3, deliberately lower than what a human can manually select) for the Real list only —
Demo has no such cap. Every cycle also re-checks each open auto-opened position's distance to
liquidation and logs a warning under a threshold — a surfaced safety signal, not an auto-close
(auto-closing on a threshold is a further decision the user hasn't made).

**Frontend**: a new "Futures" tab (`public/js/futures.js`), zero shared code paths with
`dashboard.js` — own symbol picker (KuCoin only), own Demo/Real portfolio+position+order sections.
Two entirely separate watchlist tables (Demo Futures Watchlist near the top of the tab; Real
Futures Watchlist nested inside the existing Real-unlock-gated panel, only rendered once
`ModeSwitcher.isRealUnlocked()`), each with its own single Auto-Trade checkbox, its own "+ Add to
[Demo/Real] Watchlist" button, and — Demo only — its own "Enable Auto-Trade for All" bulk button;
deliberately no bulk button on the Real list, keeping that a conscious per-symbol decision. Reuses
`order-confirmation.js`'s dialog (extended with optional Leverage/liquidation rows) and
`mode-switcher.js`'s Real-unlock state via a new `onRealUnlock()` callback hook, rather than either
module needing to know about the other's DOM.

## 19. Position-level stop-loss/take-profit enforcement (bug fix, post-launch)

Every open position (Spot or Futures, Demo or Real) has always recorded a `stop_loss`/
`take_profit` at open time — both are mandatory inputs to open a position at all. But nothing ever
re-checked live price against those stored numbers: a position only closed when a later strategy
signal said SELL (both auto-traders re-evaluate and only act on the *current* signal, never the
position's own recorded levels — see §12 and the futures auto-trader section above), or when a
separately-and-manually-placed OCO/Limit/Stop-Market exit order happened to fill via
`pending-orders-watcher.js`. A plain Buy/`open_long`/`open_short` — including *every*
auto-trader-opened position, since neither auto-trader ever places a protective exit order after
opening one — could blow straight through its own stop-loss or take-profit with no reaction at
all. Futures had no protective-order mechanism to fall back on in the first place: `action` is
`open_long`/`open_short`/`close` only, no pending/OCO order type exists there at all (§18).

`src/services/scheduler/position-risk-watcher.js` closes this gap: a fourth scheduler (same
`setInterval`/`start`/`stop`/`runCycle`/`getStatus` shape as `auto-trader.js`/
`pending-orders-watcher.js`/`futures-auto-trader.js`, same `PENDING_ORDERS_POLL_INTERVAL_MS`
cadence, started unconditionally alongside the other three in `server.js`'s real boot path only).
Each cycle, for all four position sets (spot demo/real, futures demo/real), it re-fetches a live
price per open position and closes it (`placeDemoOrder`/`placeRealOrder` with `side: 'sell'`, or
`placeDemoFuturesOrder`/`placeRealFuturesOrder` with `action: 'close', source: 'auto'`) the moment
price crosses the position's own stored `stop_loss` or `take_profit` — side-aware for futures
(`checkFuturesTrigger`), since a short's stop/take-profit sit on the opposite side of price from a
long's. Real closes pass `unlockConfirmed: true` themselves (no human present per-trade, the same
convention `futures-auto-trader.js`'s `source: 'auto'` closes already use) and are gated only by
`ENABLE_LIVE_TRADING` + valid per-user credentials (checked inside `placeRealOrder`/
`placeRealFuturesOrder` themselves) — deliberately **not** gated behind `ENABLE_FUTURES_AUTO_TRADING`,
since that flag governs opening new unattended real positions, not honoring a risk parameter that
was mandatory to set on every position (including manually-opened ones) in the first place.

To avoid racing a Spot position's own already-working exit mechanism, `checkSpotPositions()` skips
any position that already has an outstanding pending sell order (OCO/Limit/Stop-Market/Stop-Limit)
for that symbol — that order is authoritative (for Real, an actual resting order on the exchange
itself) and this watcher only needs to cover the case where no such order exists. No such guard is
needed (or possible) on the Futures side, since no competing order type exists there. The
already-established "loser of a race finds no open position and no-ops" convention
(`finalizeDemoSellFill`/`finalizeRealSellFill`'s fallback, see §16's OCO race-condition note) means
even a same-cycle collision between this watcher and a strategy-driven SELL/close from an
auto-trader is harmless — whichever closes first wins, the other's attempt is rejected
(`NO_OPEN_POSITION_TO_CLOSE`) rather than double-closing or misapplying to a different position.
Note this is distinct from §18's liquidation-distance check, which remains a warning-only signal,
never an auto-close — this section is specifically about the stop-loss/take-profit levels a
position (or its opener) itself chose.

Verified in `tests/unit/position-risk-watcher.test.js` (pure trigger-direction logic, long and
short) and `tests/integration/position-risk-watcher.test.js` (all four position sets actually
closing on a crossed level, a position between its levels staying open, the pending-order skip
guard, and real-mode exchange calls).
