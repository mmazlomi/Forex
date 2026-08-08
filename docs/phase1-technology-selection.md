# Phase 1 Research Report — Node.js/Vanilla-JS Trading Bot (Backtest / Demo / Live)

Research date: 2026-08-02. Constraints for the final project: **Node.js + plain JavaScript backend only (no TypeScript files shipped/authored by us)**, **Vanilla JS/HTML/CSS frontend only (no frameworks)**.

---

## 1. Comparison Table

| Library / Service | Purpose | Language | Maintenance status (as of 2026-08-02) | License | Verdict |
|---|---|---|---|---|---|
| [Haehnchen/crypto-trading-bot](https://github.com/Haehnchen/crypto-trading-bot) | Reference crypto trading bot (multi-exchange via ccxt, web UI, strategies) | TypeScript (moving deeper into TS — latest commit today is "Update to typescript 7") | Active — last commit **2026-08-02** (today), 3.5k★, 110 open issues, README says "Not production ready" | MIT | **Reference/inspiration only.** Do not depend on or vendor it — it's TS-first and explicitly not production-ready. Useful for architecture ideas (strategy folder pattern, notification hooks). |
| [bennycode/trading-signals](https://github.com/bennycode/trading-signals) | TA indicator + streaming trading-bot framework | TypeScript, compiled to ESM/CJS `dist/` (npm package ships plain JS, usable from Node without TS tooling) | Active — latest npm version **8.0.0** (registry confirmed), ~975★, "battle-tested" claim | MIT | Usable from plain JS (import compiled `dist/index.js`), streaming/decimal-precision design is attractive, but source authoring is TS-centric and the "full framework" (broker integration, Telegram bot) is more opinionated than needed — we'd only want the indicator primitives. |
| [EODHistoricalData/EODHD-APIs-Node-Financial-Library](https://github.com/EODHistoricalData/EODHD-APIs-Node-Financial-Library) | Official Node/TS client for EODHD financial data API | TypeScript (client lib) wrapping a REST API | Active — last commit **2026-07-28** | MIT | Wraps a paid-first API (free tier is very limited — see §8). Fine as an optional stocks fundamentals source if budget allows; not required for MVP. |
| [oransel/node-talib](https://github.com/oransel/node-talib) | Native binding to TA-Lib C library (100+ indicators incl. candlestick patterns) | C++ addon + JS/TS wrapper, requires **node-gyp** native compilation on install (no prebuilt binaries) | Active — last commit **2026-06-29**, latest npm `talib` package v2.0.4 published 2026-06-29, **requires Node.js ≥ 24** | LGPL-3.0-or-later | **Rejected for MVP.** Native compile step = install friction (needs build-essential/Xcode/VS Build Tools on every target machine), LGPL license adds copyleft complexity, and it forces Node ≥24. Indicator coverage is not worth the portability cost when `technicalindicators` covers our needs in pure JS. |
| [technicalindicators (anandanand84)](https://www.npmjs.com/package/technicalindicators) | Pure-JS technical indicator library | Written in TypeScript but **ships plain compiled JS** for Node/browser/webpack; usable via `require()`/`import` with zero TS in our codebase | Registry metadata is inconsistent (see limitations); GitHub shows 2.5k★, 316 commits, 76 open issues — actively used though not high commit velocity | MIT | **Selected.** No native compilation, no runtime TS dependency, covers SMA/EMA/WMA/RSI/MACD/BollingerBands/ATR/Stochastic/StochRSI/ADX/CCI/Williams%R/OBV/MFI/VWAP/Ichimoku/PSAR + 35+ candlestick patterns. Best fit for "backend must be plain JS." |
| [ccxt](https://github.com/ccxt/ccxt) | Unified exchange API (spot/futures trading, market data) for 100+ exchanges | Multi-language; core is transpiled from TS but **npm `ccxt` package is consumable as plain JS** (`require('ccxt')`), works in Node 18+ | Extremely active — latest npm version **4.5.66 published 2 days before research date**, 98k+ commits | MIT | **Selected** for exchange integration. |
| [Chart.js](https://www.chartjs.org) / [chartjs/Chart.js](https://github.com/chartjs/Chart.js) | General-purpose canvas charting | Plain JS (UMD/ESM builds), usable via `<script>` tag, no build step required | Active, 67.6k★, 4,585 commits, 498 open issues | MIT | Good general charts (equity curve, indicator overlays) but candlestick/OHLC needs the **chartjs-chart-financial** plugin, whose latest npm release (0.2.1) is **~2 years stale** as of 2026 — a maintenance red flag for the one feature (candlesticks) a trading dashboard needs most. |
| [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) | Purpose-built financial charting (candlestick/OHLC/line/area, volume, indicators) | Plain JS, UMD build via CDN (`lightweight-charts.standalone.production.js`) creates `window.LightweightCharts` — no build step | Active, 16.8k★, 3,136 commits, has an "AI Agent Skill" for docs (signals ongoing investment) | Apache-2.0 (requires visible "TradingView" attribution/link on the chart or page) | **Selected** for financial charts; use Chart.js only for supplementary generic charts (equity curve, P&L histogram) if desired. |
| EODHD (stocks fundamentals) | Stocks/ETF/fundamentals + EOD/intraday data, 150k+ tickers/70+ exchanges | REST API | Actively sold/updated product | Commercial (MIT for the *client lib*, data itself is proprietary/licensed) | Free tier is only **20 calls/day**, personal use only — too thin for iterative dev/demo use; consider only as a paid upgrade path. |
| Alpha Vantage (stocks fundamentals) | Stocks fundamentals + EOD/intraday | REST API | Ongoing | Free tier ToS restricts redistribution | Free tier: **25 requests/day, 5/minute** — very thin, effectively unusable for a live-refreshing dashboard beyond light manual testing. |
| Financial Modeling Prep (FMP) | Stocks fundamentals + statements | REST API | Ongoing | Free tier ToS restricts commercial redistribution | Free tier: **250 requests/day**, 500MB/30-day bandwidth cap, 5 years of annual statements — most usable free stocks option for a hobby project. |
| Finnhub | Stocks quotes/fundamentals/news, WebSocket streaming | REST + WS API | Ongoing | Free tier ToS restricts redistribution | Free tier: **60 calls/minute** (best per-minute free allowance found), informally reported ~300 calls/day soft ceiling, WS streaming up to 50 symbols — **best fit for stocks** given generous per-minute rate. |
| CoinGecko API | Crypto market data + fundamentals (market cap, FDV, supply, volume, listings) | REST API | Ongoing, actively promoted | Free "Demo" plan ToS: non-commercial/attribution required, no redistribution as a standalone API | **Demo (registered, free) plan: 100 calls/min, 10,000 calls/month.** Unregistered "Public" plan: 5–15 calls/min, no key needed. **Selected** as primary crypto fundamentals/market-data source. |
| CoinMarketCap API | Crypto market data + fundamentals | REST API | Ongoing | Free "Basic" plan ToS: **no redistribution/resale as a standalone API or data product** | Free tier: 15,000 credits/month, 50 req/min. Viable secondary/fallback crypto source; redistribution restriction matters if we ever expose raw CMC data through our own public API — for an internal dashboard this is fine. |
| better-sqlite3 / node:sqlite | Local single-process relational storage | better-sqlite3: native addon (node-gyp); node:sqlite: built into Node 22.5+, still labeled experimental until Node 26 | better-sqlite3 battle-tested for years; node:sqlite stabilizing, "fully stabilized" reported at Node v26 | better-sqlite3: MIT | See §"DB choice" below — both reasonable; recommend better-sqlite3 for maturity, keep node:sqlite as a future zero-dependency swap. |

---

## 2. Pros and Cons per Item

### Haehnchen/crypto-trading-bot
- **Pros:** Real-world multi-exchange bot architecture (ccxt-based), strategy-folder pattern, notification integrations (Slack/Telegram/email), Docker packaging, MIT license, very actively committed (commit on the exact research date).
- **Cons:** Written in and moving further into TypeScript; explicitly says "not production ready"; uses `sqlite3` (callback-style) not `better-sqlite3`; too heavyweight/opinionated to depend on directly given our "no TypeScript" constraint. Use only as an architectural reference, never as a dependency.

### bennycode/trading-signals
- **Pros:** MIT, ships compiled JS in the npm package (importable with zero TypeScript in our repo), decimal-precision arithmetic (avoids float drift in indicator math), "streaming" (incremental update) design suits live/demo trading loops well, actively released (v8.0.0).
- **Cons:** Documentation and idiomatic usage examples are TS-first, indicator list less exhaustively documented/candlestick-pattern support weaker than `technicalindicators`, and the repo has grown into a full "trading bot framework" (broker/Telegram integration) that's more than we need — risk of pulling in unnecessary surface area.

### EODHD-APIs-Node-Financial-Library
- **Pros:** Official, actively maintained (commit within the last week of research), broad coverage (150k+ tickers, 70+ exchanges, stocks+ETF+forex+crypto fundamentals, technical indicators, calendars, insider transactions), MIT-licensed client code.
- **Cons:** Underlying EODHD data API free tier is only 20 calls/day/personal-use — unsuitable for anything beyond a smoke test; meaningful use requires a paid plan ($19.99–$99.99/mo).

### oransel/node-talib
- **Pros:** Comprehensive TA-Lib coverage (100+ indicators + candlestick pattern recognition), actively updated (June 2026), performant native C++ core.
- **Cons:** Mandatory native compilation on every install (node-gyp + platform build tools — Xcode/build-essential/VS Build Tools), no prebuilt binaries, requires Node.js ≥24 (constrains our runtime choice), LGPL-3.0 license (copyleft considerations, more legal overhead than MIT for a redistributable project), documented friction with newer Visual Studio/node-gyp version mismatches. Install friction directly conflicts with the goal of a simple, portable, plain-JS hobby project.

### technicalindicators
- **Pros:** MIT, pure JS output usable directly from Node without any TypeScript toolchain, broad indicator set matching (and exceeding) the requested list (SMA/EMA/RSI/MACD/BollingerBands/ATR/Stochastic/ADX all present) plus 35+ candlestick patterns, no native compilation, works identically in Node and browser.
- **Cons:** Slower commit cadence than trading-signals/ccxt (316 commits total, no confirmed 2026 release date found — flagged as a limitation below), 76 open issues suggest some rough edges/edge-case bugs to watch for, weekly-download/publish-date figures returned by search were unreliable/contradictory (see Limitations) so exact freshness could not be independently confirmed.

### ccxt
- **Pros:** Extremely active (release 2 days before research date), 100+ exchanges unified under one API, MIT license, native Node 18+ support without TypeScript, built-in rate limiter (`enableRateLimit`), unified order placement (`createOrder`, `cancelOrder`, `fetchBalance`, etc.), `exchange.setSandboxMode(true)` gives a one-line switch to exchange testnets for many (not all) exchanges.
- **Cons:** Sandbox/testnet quality varies per exchange — some exchanges have no real testnet and only support "test order" endpoints (`createOrder` with a test flag) rather than a full parallel environment; testnet endpoints have historically changed/broken (e.g., Binance Spot Testnet, Bybit, Deribit issues found in GitHub issue tracker) requiring resilience/fallback handling; huge library surface (100+ exchange modules) increases bundle/install size.

### Chart.js
- **Pros:** MIT, plain-JS UMD build usable via `<script>` tag with zero bundler, huge ecosystem, flexible for generic charts (equity curve, drawdown, indicator line overlays, histograms).
- **Cons:** No native candlestick/OHLC chart type — requires `chartjs-chart-financial`, whose last npm release is ~2 years old as of 2026 (stagnant), a real risk for a dashboard whose core visual is the candlestick chart.

### TradingView Lightweight Charts
- **Pros:** Purpose-built for financial/candlestick charts, extremely small bundle ("one of the smallest and fastest financial HTML5 charts"), plain `<script>` CDN usage with a `window.LightweightCharts` global (fits our no-framework/no-build constraint perfectly), actively maintained (3,136 commits, ongoing docs investment), free under Apache-2.0.
- **Cons:** Apache-2.0 requires a visible TradingView attribution/link on the chart or page — must be honored in the UI; feature set is narrower than Chart.js for non-financial chart types (would still want Chart.js or plain `<canvas>` for e.g. a simple bar/pie summary widget if needed).

### Fundamental data providers (stocks)
- **EODHD:** best breadth, worst free tier (20/day).
- **Alpha Vantage:** worst free tier (25/day, 5/min) — essentially unusable beyond manual spot checks.
- **FMP:** best free-tier practicality for stocks (250/day, 500MB/30-day bandwidth), 5 years of annual statements on free tier.
- **Finnhub:** best free per-minute allowance (60/min) plus WebSocket streaming — best fit for near-real-time quote/news polling in a demo dashboard, though a soft daily ceiling (~300/day, unofficially observed) may apply.

### Fundamental data providers (crypto)
- **CoinGecko:** registered "Demo" (free) plan gives 100 calls/min & 10,000 calls/month — generous enough for a hobby dashboard; unregistered public access exists but is much more limited (5–15/min). ToS forbids redistributing as a standalone API/product but is fine for internal dashboard consumption.
- **CoinMarketCap:** 15,000 credits/month & 50 req/min free — solid secondary source; stricter ToS around redistribution/resale, requires visible attribution.

### SQLite (better-sqlite3 vs node:sqlite)
- **Pros (both):** Zero external DB server, file-based, trivial backup (copy the file), perfect fit for a single-process hobby/demo trading bot needing mode-separated tables (`backtest_*`, `demo_*`, `real_*` or a `mode` column with indices).
- **better-sqlite3 cons:** native addon → node-gyp compile on install (some friction, though prebuilt binaries are typically available via `prebuild-install` for common platforms, reducing real-world pain versus node-talib).
- **node:sqlite cons:** still experimental until Node 26 LTS; more verbose API; less battle-tested; ties the project to a specific newer Node version.
- **Verdict:** Reasonable choice either way for this project's scale; not a decision that needs a deep dive (per task scope). Recommend **better-sqlite3** now for maturity/synchronous simplicity, with `node:sqlite` as a documented future zero-dependency migration once it's fully stable on the target Node LTS.

---

## 3. Security & Maintenance Findings

- **Native-compilation risk (node-talib):** Building a C++ addon on install is the single biggest maintenance/security liability among researched libraries — it pulls in build toolchains, increases attack surface (arbitrary native code execution during `npm install`), and breaks silently across Node/OS/compiler upgrades (the package's own docs flag current Visual Studio/node-gyp incompatibilities). Avoiding it removes an entire class of "works on my machine" bugs.
- **Stale plugin risk (chartjs-chart-financial):** A ~2-year-old release for the exact plugin needed to render candlesticks is a real signal to avoid Chart.js for the primary chart and use Lightweight Charts instead.
- **ccxt testnet fragility:** GitHub issues show recurring breakage of specific exchanges' sandbox/testnet endpoints (Binance, Bybit, OKX, Deribit) as exchanges change infrastructure — our Demo-mode design should not hard-assume `setSandboxMode(true)` works uniformly; it should validate connectivity at startup and surface a clear error/fallback per exchange.
- **Third-party API ToS risk (CoinMarketCap, EODHD, Alpha Vantage, FMP, Finnhub):** All free tiers restrict redistribution/resale of raw data as a standalone product. For an internal single-user trading dashboard (not resold data), this is not a blocker, but it rules out ever exposing a public "data proxy" API from this project without a paid/commercial license.
- **Rate-limit exhaustion risk:** Alpha Vantage (25/day) and EODHD free tier (20/day) are so low they will be exhausted by normal development/testing within minutes — plan for aggressive local caching (SQLite) of fundamentals data regardless of provider chosen.
- **Unverifiable metadata:** Search-engine-cached npm data for `technicalindicators` returned contradictory info (a clearly stale "3.1.0, 6 years ago" snippet alongside registry JSON showing MIT/3.1.0 with no timestamp) — treated as unreliable; see Limitations.

---

## 4. Licensing Findings

| Component | License | Redistribution/commercial notes |
|---|---|---|
| crypto-trading-bot (reference only) | MIT | Fine to read/learn from; not used as a dependency |
| trading-signals | MIT | No restriction |
| EODHD Node library | MIT (client code) | Underlying **data** is a licensed commercial product, separate from the code license |
| node-talib | **LGPL-3.0-or-later** | Copyleft: modifications to the library itself must stay open, though dynamic linking/use from an application is generally permitted — still more legal overhead than MIT/Apache alternatives; contributed to rejection |
| technicalindicators | MIT | No restriction |
| ccxt | MIT | No restriction |
| Chart.js | MIT | No restriction |
| chartjs-chart-financial | MIT (per npm) but stale | No restriction, but freshness concern stands |
| TradingView Lightweight Charts | **Apache-2.0** | Must display visible attribution/link to TradingView per their branding requirement |
| EODHD data / Alpha Vantage / FMP / Finnhub / CoinGecko / CoinMarketCap | Proprietary data under provider ToS | All free tiers forbid reselling/redistributing raw data as a standalone API/product; attribution required for CoinMarketCap; fine for internal use in our own dashboard |
| better-sqlite3 | MIT | No restriction |

**Overall:** the selected stack (technicalindicators, ccxt, Lightweight Charts, better-sqlite3) is 100% MIT/Apache-2.0 with only the Lightweight Charts attribution requirement to honor in the UI footer/chart.

---

## 5. Final Technology Selection

| Decision | Choice | Reasoning |
|---|---|---|
| **Backend runtime/framework** | Node.js (LTS, e.g. 22.x) + Express (plain JS) | Express is the de facto minimal, dependency-light, plain-JS-compatible HTTP framework; no TypeScript needed; huge ecosystem/documentation; fits a small-team hobby project better than heavier frameworks (Nest is TS-first, Fastify is fine too but Express has the lowest learning-curve/most examples for this scope). |
| **TA indicator library** | **`technicalindicators`** over `trading-signals` and `node-talib` | (1) Ships plain compiled JS — zero TypeScript touches our codebase, satisfying the hard constraint. (2) No native compilation — install friction and portability are non-negotiable for a hobby/demo project meant to run easily on any machine. (3) Covers every indicator explicitly requested (SMA/EMA/RSI/MACD/BollingerBands/ATR/Stochastic/ADX) plus candlestick pattern recognition, which `trading-signals` documents less thoroughly. (4) MIT vs node-talib's LGPL-3.0 — simpler licensing. `trading-signals` remains a good fallback if we later need arbitrary-precision decimal math or streaming/incremental indicator updates for a live tick-by-tick engine; `node-talib` is rejected outright due to native-build friction + Node≥24 requirement + LGPL. |
| **Exchange integration** | **ccxt**, plain JS usage (`require('ccxt')`), `setSandboxMode(true)` for exchanges that support it, native `enableRateLimit` | Only realistic choice for unified multi-exchange support; MIT; actively maintained; must design Demo mode to gracefully detect/handle exchanges with poor or broken testnet support (verify connectivity, fall back to a simulated paper-trading engine using real market data + ccxt price feeds when no testnet exists). |
| **Charting library** | **TradingView Lightweight Charts** for the main candlestick/OHLC dashboard chart; optionally plain Chart.js (MIT, no plugin needed) for secondary generic charts (equity curve, P&L histogram) if desired | Chart.js's financial-chart plugin is stale; Lightweight Charts is purpose-built, tiny, plain-`<script>`-tag friendly, and actively maintained — the correct default for a trading dashboard. Must add TradingView attribution per Apache-2.0 branding terms. |
| **Fundamental data — stocks** | **Finnhub** as primary (60 req/min free, WS streaming), **FMP** as secondary/statements source (250 req/day, deeper financial statements) | Finnhub's per-minute allowance best matches a live-refreshing dashboard; FMP fills in deeper fundamentals/statements Finnhub's free tier may not fully cover. Alpha Vantage and EODHD free tiers are too thin for anything beyond opportunistic manual checks; EODHD can be revisited if the project later justifies a paid plan. |
| **Fundamental data — crypto** | **CoinGecko** (Demo/free plan) as primary, **CoinMarketCap** free tier as secondary/fallback | CoinGecko's free Demo plan (100/min, 10k/month) is the most generous, well-documented, keyless-capable option; CoinMarketCap's free tier is a reasonable fallback with stricter redistribution terms that are irrelevant for internal-only use. |
| **Database** | **better-sqlite3**, single SQLite file, `mode` column (or per-mode tables) distinguishing `backtest` / `demo` / `real` data | Zero-server, file-based, synchronous API well-suited to a single-process Node app; mature and battle-tested versus the still-experimental `node:sqlite`. Revisit `node:sqlite` once it's stable on the chosen Node LTS to drop the native dependency entirely. |

---

## 6. Architecture Proposal (high-level)

```
                              ┌─────────────────────────────────────────┐
                              │             Vanilla JS/HTML/CSS UI        │
                              │  (served as static files by Express)     │
                              │  - Dashboard (Lightweight Charts)         │
                              │  - Mode switch: Backtest / Demo / Real    │
                              │  - Strategy config, order log, P&L view   │
                              └───────────────┬────────────────────────┬─┘
                                              │ REST (fetch)            │ WebSocket (live price/order updates)
                                              ▼                        ▼
                              ┌───────────────────────────────────────────┐
                              │            Express API Server (Node.js)     │
                              │  routes: /api/backtest  /api/demo  /api/real│
                              │          /api/market-data /api/fundamentals │
                              └───────────────┬──────────────┬─────────────┘
                                              │              │
                       ┌──────────────────────┼──────────────┼───────────────────────┐
                       ▼                      ▼              ▼                       ▼
             ┌─────────────────┐   ┌──────────────────┐  ┌─────────────────┐ ┌──────────────────┐
             │  Strategy /      │   │  Execution Engine  │  │ Market Data Feed │ │ Fundamentals Feed │
             │  Signal Engine   │   │  (mode-aware)       │  │ (ccxt, per-mode) │ │ (Finnhub/FMP,      │
             │  (technical-     │   │  - Backtest: sim    │  │                  │ │  CoinGecko/CMC)    │
             │  indicators)     │   │    fill @ candle    │  └────────┬─────────┘ └─────────┬──────────┘
             └────────┬─────────┘   │  - Demo: ccxt        │           │                     │
                      │             │    sandbox/testnet   │           │                     │
                      │             │    or simulated fill  │           │                     │
                      │             │  - Real: ccxt live    │           │                     │
                      │             │    + risk guardrails  │           │                     │
                      │             └──────────┬────────────┘           │                     │
                      │                        │                        │                     │
                      ▼                        ▼                        ▼                     ▼
             ┌─────────────────────────────────────────────────────────────────────────────────┐
             │                          better-sqlite3 (single file, mode-scoped tables)          │
             │  candles | signals | backtest_runs | backtest_trades | demo_orders | real_orders   │
             │  fundamentals_cache | exchange_credentials(encrypted, real-mode only) | config      │
             └─────────────────────────────────────────────────────────────────────────────────────┘
```

**Component notes:**
- **Strategy/Signal Engine** is mode-agnostic — it consumes OHLCV candles + `technicalindicators` outputs and emits buy/sell/hold signals, regardless of whether those candles came from historical DB rows (backtest), a testnet feed (demo), or a live feed (real).
- **Execution Engine** is the only component that changes behavior per mode (see §7) — it's the seam where Backtest/Demo/Real diverge.
- **Market Data Feed** wraps ccxt calls (`fetchOHLCV`, `watchTicker` if using ccxt.pro/WS, or REST polling) and normalizes to one internal candle shape used everywhere, including for stored backtest data.
- **Fundamentals Feed** wraps Finnhub/FMP (stocks) and CoinGecko/CoinMarketCap (crypto) behind one interface, with aggressive SQLite caching (`fundamentals_cache` table with TTL) to respect free-tier rate limits.

---

## 7. Backtest vs Demo vs Real — Explicit Distinctions

| Aspect | Backtest | Demo (paper/sandbox) | Real (live) |
|---|---|---|---|
| **Data source** | Historical OHLCV pulled once via ccxt/API and stored in SQLite (`candles` table); replayed candle-by-candle | Live/near-live market data via ccxt (either the exchange's real market-data endpoint, or its sandbox market data if the sandbox provides its own feed) | Live market data via ccxt against the real exchange endpoint |
| **Order execution** | Simulated fill logic in-process (e.g., fill at next candle open/close, apply configurable slippage & fee model) — **no network calls to any exchange** | Two sub-cases depending on exchange: (a) `exchange.setSandboxMode(true)` then real order calls hit the exchange's testnet, which fills with fake balances; (b) for exchanges with no real testnet, fall back to the same simulated-fill engine as Backtest but driven by live prices ("paper trading") | Real order calls (`createOrder`, etc.) against the exchange's production endpoint using real funds |
| **Credentials** | None required | Sandbox/testnet API key+secret (separate, clearly-labeled credential set in config/DB, never the same as live keys) | Live/production API key+secret, ideally with **trade-only, no-withdrawal** permissions; stored encrypted at rest, never logged |
| **Risk** | Zero financial risk; purely computational (CPU/time cost only) | Zero-to-low financial risk — sandbox funds are fake; if falling back to simulated-fill-on-live-prices, still zero real risk, but slippage assumptions can diverge from reality | Full financial risk — real capital; must gate behind explicit user confirmation, position-size limits, max-daily-loss circuit breakers, and a hard "kill switch" |
| **DB tables/scope** | `backtest_runs`, `backtest_trades` (each run tagged with a run ID, parameters, and date range for reproducibility) | `demo_orders`, `demo_positions` (isolated from real-mode tables so demo activity never contaminates real P&L reporting) | `real_orders`, `real_positions`, plus audit-log table capturing every order request/response for compliance/debugging |
| **UI treatment** | Clearly labeled "Backtest" tab; results shown as a completed report (equity curve, trade list, metrics) after the run finishes | Clearly labeled "Demo" with a persistent visual badge (e.g., yellow banner "SANDBOX — fake funds") to prevent confusion | Clearly labeled "Real" with a strong visual warning (e.g., red banner) and a confirmation step before enabling |
| **Rate-limit/API impact** | One-time historical fetch, then fully local — cheapest on external API quota | Ongoing polling of live/sandbox prices — moderate quota usage, same as real | Ongoing polling of live prices + order placement — must respect ccxt's built-in rate limiter strictly |

**Key design rule:** the same Strategy/Signal Engine code path must run unmodified in all three modes; only the Execution Engine and credential/config wiring differ. This is what makes backtest results a meaningful predictor of demo/real behavior.

---

## 8. All Source Links Used

- [Haehnchen/crypto-trading-bot](https://github.com/Haehnchen/crypto-trading-bot)
- [Haehnchen/crypto-trading-bot commits](https://github.com/Haehnchen/crypto-trading-bot/commits/master)
- [bennycode/trading-signals](https://github.com/bennycode/trading-signals)
- [trading-signals on npm](https://www.npmjs.com/package/trading-signals/v/1.8.0)
- [trading-signals npm registry](https://registry.npmjs.org/trading-signals)
- [EODHistoricalData/EODHD-APIs-Node-Financial-Library](https://github.com/EODHistoricalData/EODHD-APIs-Node-Financial-Library)
- [EODHD Node lib commits](https://github.com/EODHistoricalData/EODHD-APIs-Node-Financial-Library/commits/main)
- [oransel/node-talib](https://github.com/oransel/node-talib)
- [node-talib commits](https://github.com/oransel/node-talib/commits/master)
- [talib npm registry](https://registry.npmjs.org/talib)
- [technicalindicators (anandanand84) on GitHub](https://github.com/anandanand84/technicalindicators)
- [technicalindicators on npm](https://www.npmjs.com/package/technicalindicators)
- [technicalindicators npm registry](https://registry.npmjs.org/technicalindicators)
- [ccxt/ccxt](https://github.com/ccxt/ccxt)
- [ccxt on npm (versions)](https://www.npmjs.com/package/ccxt?activeTab=versions)
- [ccxt manual (sandbox/testnet)](https://github.com/ccxt/ccxt/wiki/manual)
- [ccxt Exchange.setSandboxMode PR #2797](https://github.com/ccxt/ccxt/pull/2797)
- [ccxt Binance testnet issue #27266](https://github.com/ccxt/ccxt/issues/27266)
- [ccxt Bybit sandbox issue #25545](https://github.com/ccxt/ccxt/issues/25545)
- [ccxt Deribit sandbox issue #5186](https://github.com/ccxt/ccxt/issues/5186)
- [ccxt OKX testnet issue #8532](https://github.com/ccxt/ccxt/issues/8532)
- [Chart.js](https://www.chartjs.org)
- [chartjs/Chart.js](https://github.com/chartjs/Chart.js)
- [chartjs/chartjs-chart-financial](https://github.com/chartjs/chartjs-chart-financial)
- [chartjs-chart-financial on npm](https://www.npmjs.com/package/chartjs-chart-financial)
- [TradingView/lightweight-charts](https://github.com/tradingview/lightweight-charts)
- [EODHD pricing/rate limits](https://apis.io/plans/eod-historical/eod-historical-plans-pricing/), [EODHD rate limits](https://apis.io/rate-limits/eodhd/eodhd-rate-limits/), [EODHD site](https://eodhd.com/)
- [Alpha Vantage 2026 guide](https://alphalog.ai/blog/alphavantage-api-complete-guide), [Alpha Vantage review](https://tradingtoolshub.com/review/alpha-vantage/)
- [FMP pricing plans](https://site.financialmodelingprep.com/pricing-plans), [FMP docs](https://site.financialmodelingprep.com/developer/docs)
- [Finnhub review/limits summary](https://www.freeapisforyou.in/api/finnhub), [Finnhub API comparison](https://qveris.ai/guides/stock-api-free-comparison/)
- [CoinGecko API pricing](https://www.coingecko.com/en/api/pricing), [CoinGecko rate limit support article](https://support.coingecko.com/hc/en-us/articles/4538771776153-What-is-the-rate-limit-for-CoinGecko-API-public-plan)
- [CoinMarketCap API pricing](https://coinmarketcap.com/api/pricing/), [CoinMarketCap commercial ToS](https://pro.coinmarketcap.com/user-agreement-commercial/), [CoinMarketCap personal ToS](https://pro.coinmarketcap.com/user-agreement-personal/)
- [better-sqlite3 on npm](https://www.npmjs.com/package/better-sqlite3)
- [SQLite driver benchmark: better-sqlite3 vs node:sqlite](https://sqg.dev/blog/sqlite-driver-benchmark/)
- [Node.js built-in SQLite guide](https://jangwook.net/en/blog/en/node-sqlite-builtin-practical-guide-2026/)

---

## 9. Limitations (sources not fully accessible or verified)

- **npmjs.com package pages returned HTTP 403** to direct WebFetch (`https://www.npmjs.com/package/technicalindicators`) — worked around by querying the raw npm registry JSON (`registry.npmjs.org/...`) and web search, but this means download-count figures and some "last published" dates could not be independently confirmed from the primary npm UI. Search-engine-cached snippets for `technicalindicators` gave a clearly stale/contradictory result ("v3.1.0, published 6 years ago") that conflicts with it being an actively-referenced, currently-recommended library — **treat any specific `technicalindicators` publish-date/download-count figure in this report as unverified**; the license (MIT) and indicator coverage (from the GitHub README) are more reliably confirmed.
- **chartjs.org homepage** returned a `socket hang up` error on WebFetch; version/roadmap details for Chart.js core came from the GitHub repo page and general knowledge instead. Recommend a manual check of chartjs.org before final implementation if precise current version number matters.
- **GitHub star/issue/commit counts** reflect a snapshot from page scraping (via WebFetch's HTML→markdown conversion) rather than the GitHub API, so exact figures (e.g., "110 open issues," "76 open issues") may drift by the time implementation starts — re-verify immediately before Phase 2 if these numbers matter to a go/no-go decision.
- **node-talib license**: GitHub README text explicitly states LGPL-3.0-or-later and the npm registry confirms `"license":"LGPL-3.0-or-later"` — treated as confirmed, but note historical TA-Lib-adjacent packages have sometimes carried mixed/ambiguous licensing across the underlying C library vs the Node binding; not independently verified against the actual `LICENSE` file text in this pass.
- **Finnhub's ~300 calls/day soft daily cap** is sourced from a single blog's informal observation ("recent testing from April 2026"), not Finnhub's own official documentation — could not independently confirm an official daily cap exists; the official/documented limit found was the 60 calls/minute figure.
- **EODHD, Alpha Vantage, FMP, Finnhub, CoinGecko, CoinMarketCap pricing pages** were accessed via web search summaries rather than direct WebFetch of the live pricing page for each (to conserve calls) — figures should be spot-checked against the live pricing pages immediately before implementation, since free-tier terms change frequently in this industry.
- **ccxt sandbox coverage per exchange** (which of Binance/Kraken/Bybit/etc. have good sandbox support in 2026) could not be fully enumerated — evidence gathered (GitHub issues) shows sandbox support is exchange-specific and has broken/changed over time for Binance, Bybit, OKX, and Deribit; a definitive "which exchanges have good testnet support today" list would require either querying `ccxt.Exchange.prototype.urls.test` per exchange programmatically or checking ccxt's own exchange-capability docs at implementation time — **recommend doing this as a concrete Phase 2/3 step** (e.g., a small script that iterates `ccxt.exchanges` and checks for a `test` URL) rather than relying on this research pass.
