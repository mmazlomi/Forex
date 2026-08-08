# User Guide

> **Risk warning:** This software is for educational and informational purposes only and is
> **not financial advice**. Trading carries a high level of risk. No profit is guaranteed. You
> are solely responsible for any trading decisions made using this software.

## Prerequisites

- Node.js ≥ 22 (tested on 24.x)
- npm
- A terminal and a web browser

## Installation

```bash
git clone <this repo>   # or just cd into the project directory you already have
cd trading-bot
npm install
```

If `npm install` fails, it's almost certainly network access to the npm registry, not this
project — every dependency here is plain JS with no native compilation step.

## Configuration (`.env`)

```bash
cp .env.example .env
```

Open `.env` and review it. The defaults are safe out of the box:

- `TRADING_MODE=demo`, `ENABLE_LIVE_TRADING=false` — Real Trading is off until you deliberately turn it on (see [Real Trading safety](#real-trading-safety) below).
- `DEMO_EXCHANGE_NAME` / `DEMO_API_KEY` / `DEMO_API_SECRET` — optional. Leave blank to use
  simulated fills against live public price data; fill in if you have testnet/sandbox
  credentials for an exchange with real sandbox support (check `GET /api/system-status` →
  `demoSandbox` after setting `DEMO_EXCHANGE_NAME`).
- `FUNDAMENTAL_API_KEY` — optional. If you have a [Finnhub](https://finnhub.io) API key, put it
  here to enable stock fundamentals (revenue, P/E, EPS, news, etc.). Crypto fundamentals
  (via CoinGecko) work without any key. Without a Finnhub key, stock fundamental fields show as
  `"unavailable"` — never fabricated.
- The `MAX_*`/`MIN_*` risk values are your starting risk settings; you can change them later
  from the dashboard's Risk Settings tab per mode (demo/real have independent settings).

**Never commit your `.env` file.** It's already in `.gitignore`. Never paste real API keys into
chat, screenshots, or bug reports — logs and API responses in this app already mask secret
values automatically, but that only helps if the key made it into `.env` and nowhere else.

## Starting the app

```bash
npm start
```

You should see:

```
Trading bot server listening on http://localhost:3450 (mode: demo, live trading: false)
```

Open that URL in your browser.

### If port 3450 is already in use

The app prints an explanation and exits — it will not silently pick a different port or crash
with a confusing stack trace:

```bash
# Linux/macOS
PORT=3550 npm start

# Windows PowerShell
$env:PORT=3550; npm start
```

Or set `PORT=3550` in `.env` and restart.

## Signing up / logging in

The app requires an account before showing the dashboard. On first load you'll see a Log In /
Sign Up screen — switch to the **Sign Up** tab, pick a username (3-32 characters: lowercase
letters, numbers, `_` or `-`) and a password (at least 8 characters), and submit. **There is no
email involved and no password-reset flow** — this app has no email-sending capability, so if you
forget your password, there's currently no self-service way to recover it (an administrator would
need to reset it directly in the database). Store your password somewhere safe.

**If you're upgrading a deployment that already had a watchlist before accounts existed**: the
very first account anyone signs up with automatically inherits that pre-existing watchlist, so
nothing is lost — but this also means whoever signs up *first* gets it. If this instance is
reachable by anyone other than you, sign up immediately after upgrading.

**What's actually private to your account vs. shared:** everything is private to your account —
Watchlist, Demo/Real portfolios, orders, positions, risk settings, and your own Real exchange API
credentials. No other user can see or affect your balance, positions, order history, or API keys.
The one deliberate exception is the **global** emergency stop, an instance-wide panic button that
any logged-in user can trigger to halt trading for everyone at once (your own Demo/Real emergency
stops, by contrast, only ever affect your own account). If you enable AI Auto-Trade on an asset in
your watchlist, it drives your own portfolio only — the background AI trader is a single shared
process that evaluates every account's enabled assets each cycle, but every trade it places is
scoped to whichever account's watchlist entry triggered it.

Use **Log Out** (top-right of the header, once logged in) to end your session on this device.

## Using the dashboard

### Status bar

A thin bar below the risk warning is always visible, on every tab: current mode's **Balance**,
**Net P&L**, **Open Positions** count, and a **Trading** indicator (🟢 Active, or 🔴 STOPPED with
the scope — `demo`, `real`, or `global` — if an emergency stop is active). It refreshes on its
own every 15 seconds, and immediately after switching Demo/Real mode, placing an order, or
triggering/resetting an emergency stop — so you always know your exposure and whether trading is
actually live without needing to be on the Demo/Real Trading tab.

### Loading an asset

Header controls: pick an **exchange** from the dropdown (a curated list of well-known crypto
exchanges), type a **symbol** (e.g. `BTC/USDT` — a datalist suggests common majors as you type),
pick **asset type** (crypto/stock) and **timeframe**, then click **Load**. This populates the
price chart, technical-analysis panel, and fundamentals panel for that asset.

Click **+ Add to Watchlist** to save the current exchange/symbol/type/timeframe combination —
saved assets then appear in the **Watchlist** dropdown for one-click reloading, and become
eligible for AI Auto-Trading (below). Stock assets skip exchange validation (ccxt only covers
crypto); crypto assets are validated against the exchange's real market list before being added.

### Full trading chart

The price chart is a real embedded TradingView Advanced Chart widget — drawing tools, its own
indicator/study library, chart type switcher, and replay mode are all built into the chart's own
toolbar (nothing to configure in this app). It shows TradingView's own market data for the mapped
symbol/exchange, independent of the Technical Analysis panel and Signal below it, which use this
app's own exchange data.

### Strategy selection

The **Strategy** dropdown in the header (next to Symbol/Timeframe) picks which named strategy
drives signal generation for the currently loaded asset — a Freqtrade-style pluggable config, not
a change to the underlying indicator math. Five built-ins ship out of the box:

- **Balanced** (default) — every indicator at standard weight, 60% technical / 40% fundamental.
- **Trend Following** — leans on EMA direction and ADX trend strength, mutes RSI/Stochastic
  (which tend to flash contrarian "overbought" during strong trends), wider stops.
- **Mean Reversion** — leans on RSI/Bollinger extremes to catch bounces, mutes EMA/ADX, tighter
  stops for shorter trades.
- **Momentum** — leans on MACD plus volume confirmation.
- **Fundamentals-Driven** — same technical emphasis as Balanced, but 65% fundamental / 35%
  technical.

Hover the dropdown for each strategy's full description. If the currently loaded asset is on your
**Watchlist**, changing this dropdown also saves it as that asset's strategy — so AI Auto-Trading
picks it up on its next tick too. If the asset isn't saved yet, the selection only affects the
next manual **Generate Signal** click. The Backtest tab has its own, independent strategy
dropdown (see below).

### AI Auto-Trading (Demo only)

Select a **watchlist** asset, then check **🤖 AI Auto-Trade (Demo)** in the header (only enabled
once the current asset is actually on your watchlist). This runs the same signal-generation and
risk pipeline as a manual Demo trade, automatically, on a timer (every 5 minutes by default,
configurable via `AUTO_TRADE_INTERVAL_MS` in `.env`, minimum 30 seconds): if a watched asset
signals `BUY` and you don't already have a position open, it places a Demo buy; if it signals
`SELL` and you do, it closes the position. **This is hard-coded to Demo mode only — there is no
setting anywhere that lets it place a Real order.** Watch its activity in the Demo Trading tab's
order history, or the System & Logs tab (filter by category `auto-trader`). Uncheck the toggle
(or leave `AUTO_TRADE_INTERVAL_MS` unset and never enable any asset) to keep it fully inert.

### Technical analysis

The Technical Analysis panel shows SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Stochastic, ADX,
Ichimoku Cloud, Support/Resistance, and Volume Analysis. Any indicator that doesn't yet have
enough candle history shows `NO_DATA (insufficient_history)` instead of a misleading value — this
is normal right after adding a new asset/timeframe combination; it resolves once enough candles
are cached (happens automatically as you use the app). Ichimoku needs the most history of any
indicator here (78 candles) since it reads the cloud as it stood 26 bars ago, the same way a real
Ichimoku chart plots it — expect it to stay `NO_DATA` longer than the others on a freshly added
asset.

### Fundamentals

Stock fields (Revenue, P/E, EPS, Debt Ratio, Cash Flow, Revenue Growth) require a Finnhub key
(see Configuration above) — without one, they show `unavailable`. Crypto fields (Market Cap,
FDV, Supply, Volume, etc.) work without a key. Fields that don't apply to the asset type (e.g.
P/E on a crypto asset) show `not_applicable`, not a blank or a zero.

### Generating a signal

Click **Generate Signal**. You'll get exactly one of `BUY`, `SELL`, `HOLD`, or `NO_DATA`, with a
full list of the specific reasons behind the score (e.g. "RSI 25.0 < 30 → oversold (bullish)").
`NO_DATA` means the system is deliberately refusing to guess — usually insufficient candle
history, or missing fundamental data when your configured fundamental weight is greater than
zero. It is never fabricated.

### Backtesting

Backtest tab: pick a **strategy**, start/end date, initial capital, fee %, and slippage % (uses
the currently loaded asset/exchange/timeframe), then **Run Backtest**. Longer date ranges take
longer — it's fetching real historical data from the exchange, not simulating it. Results always
include the mandatory disclaimer: *"Past performance does not guarantee future results."*
Backtests never place real or demo exchange orders — they're a pure historical simulation. Note:
backtests always run technical-analysis-only (fundamental weight is forced to 0), since there's no
look-ahead-free historical fundamentals feed — a strategy's fundamental weighting only affects
live/Demo/Real signals, not backtests.

### Strategy optimizer (hyperopt-lite)

Below the backtest form, **Run Optimizer** grid-searches every built-in strategy against a spread
of buy/sell score thresholds over the same date range, fetching historical candles once and
re-simulating in-memory for each combination (fast — a 15-combination run is roughly the cost of
one backtest's network fetch). The results table ranks combinations by net P&L %, and clicking
**Apply** on any row loads that combination's strategy and thresholds into the backtest form above
(click **Run Backtest** again to actually run it with them applied). This is a simple parameter
grid search, not true Bayesian hyperopt, and — like any parameter search — it risks overfitting to
the specific date range tested; always validate a promising result against a *different* date
range before trusting it for live use.

### Demo Trading

Demo is the default mode. You start with a virtual balance (`INITIAL_DEMO_BALANCE` in `.env`,
default 10,000). Go to the Demo Trading tab, fill in stop-loss/take-profit for a **Buy**, click
**Review Order** — you'll see a confirmation dialog with the exact price, stop, take-profit, and
side before anything happens. **Sell** closes an existing open position at the current price (v1
is long-only spot trading — no short-selling). Demo orders never touch a real exchange, under
any circumstance.

The stop-loss/take-profit you set on a Buy (or that the AI auto-trader sets for itself) are
enforced automatically in the background — a position closes on its own, without any further
action from you, the moment live price reaches either level (checked roughly every
`PENDING_ORDERS_POLL_INTERVAL_MS`, 30s by default). This applies to every open position, Spot and
Futures, Demo and Real, however it was opened.

### Portfolio & Profit/Loss

Each of the Demo Trading and Real Trading tabs has a **Profit & Loss** card: realized P&L
(all-time, from closed positions), unrealized P&L (live-priced from every currently open
position), net P&L (the sum), and win rate. The Open Positions table shows a live **Current**
price and per-position unrealized P&L alongside entry/stop/take-profit — colored green/red for
gain/loss. If a live price lookup fails for a position, its Current/P&L cells show `-` rather than
a stale or guessed number.

### Real Trading safety

Real Trading requires clearing **every** one of these, in order — missing any one blocks it:

1. `ENABLE_LIVE_TRADING=true` in `.env`, and the server restarted. This one deliberately stays a
   server-file edit, not a UI toggle — it's the master kill-switch.
2. An exchange, API key, and API secret configured — **either** in the Real Trading tab's
   **Exchange Credentials** card (saved encrypted, no restart needed, takes effect immediately)
   **or**, for the one legacy account this instance was migrated from, via
   `REAL_EXCHANGE_NAME`/`REAL_API_KEY`/`REAL_API_SECRET` in `.env`. Whichever is saved in the UI
   takes priority if both are set. Use API keys with **trade-only, no-withdrawal** permissions if
   your exchange supports scoping keys that way. Credentials are private to your own account —
   no other user can see or use them, and the `.env` fallback never applies to any account but
   that one legacy one. Once saved you can't view them again through the UI — only a masked
   preview (e.g. `abcd****wxyz`) to confirm it's the right one; there's a **Clear** button if you
   need to remove them.
   **Nobitex is different**: it isn't a ccxt exchange, and authenticates with a single **Token**
   instead of an API key/secret pair. Selecting it in the Exchange Credentials card shows a
   hint and disables the API Secret field — paste your Token (from your Nobitex account →
   Profile → API settings) into the **API Key** field instead. Unlike every other exchange here,
   that token **expires** (4 hours by default, up to 30 days) and will need periodic refreshing.
   Nobitex market orders only (no limit/stop/OCO), and no weekly candle timeframe.

   **Your Real balance won't just appear after saving credentials.** This app only fetches your
   live balance from the exchange when you place an order or explicitly ask it to — saving
   credentials tries once automatically, but if the asset loaded in the header isn't on the same
   exchange you just configured, that attempt silently does nothing. Use the **Refresh Balance**
   button on the Real Portfolio card (with the right exchange loaded in the header) any time —
   it's read-only and doesn't require `ENABLE_LIVE_TRADING=true`.
3. On the Real Trading tab: type `I UNDERSTAND THE RISK` exactly to unlock the tab for your
   current browser session (resets on page reload — you'll need to do this again next time).
4. On every individual order: a confirmation dialog shows the full order details, and you must
   type `CONFIRM` exactly before it submits.
5. The same 10-step risk pipeline that governs Demo orders (position sizing, max risk per trade,
   max daily loss, max open positions, minimum risk/reward ratio, max order value, portfolio
   exposure limit, balance check, stale-data check, duplicate-order check).

If any step fails, the order is rejected with a specific reason — it never silently executes as
a Demo order instead.

### Risk settings

Risk Settings tab, per mode (Demo and Real have independent settings): max risk per trade %,
max daily loss %, max open positions, max order value, minimum risk/reward ratio, max portfolio
exposure %. Changes take effect on the next order — already-open positions are unaffected.

### Emergency stop

Risk Settings tab → Emergency Stop section. **Stop ALL Trading** blocks both Demo and Real
immediately. **Stop Demo Only** / **Stop Real Only** blocks just that mode. Resetting requires
an explicit confirmation click — it's deliberately not a one-click undo.

### Logs and system status

System & Logs tab. **Refresh** on System Status shows whether live trading is enabled, whether
demo/real exchange credentials are configured, and whether the configured demo exchange has real
sandbox/testnet support (`hasSandbox: true/false`). **Refresh** on Logs shows recent activity —
credentials are already masked before being stored, so nothing sensitive appears here even if an
error message originally contained one.

## Disabling trading entirely

Set `ENABLE_LIVE_TRADING=false` and restart the server — Real Trading becomes unreachable
regardless of anything configured in the UI or `.env` (this is the one switch that's
deliberately restart-only, see [Real Trading safety](#real-trading-safety) above). Clearing the
exchange credentials (`.env`'s `REAL_EXCHANGE_NAME`/`REAL_API_KEY`/`REAL_API_SECRET`, or the
**Clear** button in the Exchange Credentials card) also blocks it without a restart, but
`ENABLE_LIVE_TRADING=false` is the more reliable single switch. Demo Trading can't place real
orders under any configuration, so there's no equivalent "disable" needed for it; use the
emergency stop if you just want to pause it temporarily.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Port already in use" on startup | Another process is on that port — set `PORT=<other>` (see above) |
| Indicators show `NO_DATA` | Not enough candle history yet for that indicator's period — wait for more candles to be fetched, or pick a shorter timeframe |
| Fundamentals show `unavailable` for a stock | `FUNDAMENTAL_API_KEY` isn't set, or the Finnhub free tier's rate limit was hit |
| Signal is always `NO_DATA` for a stock | Same as above — the default fundamental weight is 0.6/0.4 (technical/fundamental), and the system refuses to guess a BUY/SELL when fundamentals are unavailable and their weight is > 0. Either configure `FUNDAMENTAL_API_KEY`, or lower the fundamental weight for that call |
| Real order rejected with `MISSING_REAL_CREDENTIALS` | Nothing is configured in either the Exchange Credentials card or `.env`'s `REAL_EXCHANGE_NAME`/`REAL_API_KEY`/`REAL_API_SECRET` — set one of the two |
| Real order rejected with `REAL_TRADING_NOT_UNLOCKED` | You didn't complete the typed `CONFIRM` step in the order dialog, or the tab-level unlock reset (page reload) |
| An order is rejected with `RISK_REWARD_TOO_LOW`, `ORDER_VALUE_TOO_LARGE`, etc. | The risk pipeline caught it — check the message, it names exactly which limit was hit and by how much |
| `npm test` reports 0 tests | You're on a very old checkout before Phase 7 — pull the latest, tests live in `tests/` |
| AI Auto-Trade checkbox is greyed out | The currently loaded asset isn't on your watchlist yet — click **+ Add to Watchlist** first, or select it from the **Watchlist** dropdown |
| AI Auto-Trading isn't placing any orders | Check `GET /api/system-status` → `autoTrader.enabledAssetCount`; it only acts on `BUY`/`SELL` signals, so long stretches of `HOLD`/`NO_DATA` (very normal) produce no activity — check the Logs tab, category `auto-trader`, to see what it evaluated |
| Every request fails with `UNAUTHENTICATED` | Your session expired (30-day cookie) or you're logged out — log in again |
| Signup rejected with `VALIDATION_ERROR` | Username must be 3-32 lowercase letters/numbers/`_`/`-`; password must be at least 8 characters |
| Signup rejected with `USERNAME_TAKEN` | That username is already registered — log in instead, or pick another username |
| Forgot your password | There is no password-reset flow (no email capability) — an administrator would need to update `password_hash` directly in the database for your account |
| Watchlist from before you signed up seems to have disappeared | Only the very first account ever created on a given deployment inherits the pre-existing watchlist — if someone else signed up first, they got it, not you |
| Entered a Real exchange API key but the Real Portfolio still shows $0 / nothing | Expected — balance isn't fetched automatically. Click **Refresh Balance** on the Real Portfolio card with the matching exchange loaded in the header |
| Nobitex real orders start failing after working fine for a while | Your Token expired (4h by default, up to 30 days) — get a fresh one from your Nobitex account → Profile → API settings and re-save it in the Exchange Credentials card |
| Nobitex weekly ("1w") candles/chart show no data | Nobitex doesn't publish a weekly candle resolution at all — use 1d or shorter for Nobitex assets |
| Nobitex real order rejected as not fully filled | This app has no partial-fill handling; if Nobitex's ~1% market-order price band couldn't fully match your order size, it's rejected outright rather than silently recording a partial fill |

## API key security

- Demo exchange API keys (if you use a real sandbox instead of simulated fills) live only in
  `.env`, never in the database, never in a log line, never in an API response — verified by the
  automated test suite (`tests/security/mask-secrets.test.js`).
- Real exchange credentials can now live either in `.env` (same as before) **or** in the
  database, saved from the Real Trading tab's Exchange Credentials card — stored encrypted
  (AES-256-GCM), never returned by the API once saved (only a masked preview), and the
  encryption key lives in its own file (`data/credential-encryption.key`, separate from the
  database file, `0600` permissions, git-ignored by the existing `*.key` pattern). This is
  defense in depth, not a complete solution — anyone with full filesystem access to the server
  gets both files regardless, same as they'd get `.env` today.
- `.env` is git-ignored by default; double-check `git status` before committing anything if
  you're not sure.
- Use trade-only/no-withdrawal permission scoping on real exchange API keys wherever the
  exchange supports it — this app doesn't need withdrawal permissions and never calls a
  withdrawal endpoint.
