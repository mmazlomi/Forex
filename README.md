# Trading Bot

A browser-based trading platform combining technical and fundamental analysis to generate
BUY/SELL/HOLD/NO_DATA signals, with **Backtest**, **Demo (paper) Trading**, and **Real (live)
Trading** modes. Node.js + Express backend, Vanilla JS/HTML/CSS frontend — no TypeScript, no
frontend framework.

> **Risk warning:** This software is for educational and informational purposes only and is
> **not financial advice**. Trading carries a high level of risk. No profit is guaranteed. You
> are solely responsible for any trading decisions made using this software.

## Prerequisites

- Node.js ≥ 22 (tested on 24.x)
- npm

## Install

```bash
npm install
```

## Configure

```bash
cp .env.example .env
```

All defaults are safe — Demo mode, Real Trading disabled (`ENABLE_LIVE_TRADING=false`), sane
risk limits. See [docs/user-guide.md](docs/user-guide.md) for what each variable does and how to
safely enable Real Trading.

## Run

```bash
npm start
```

Then open `http://localhost:3450` (or whatever `PORT` you configured) in your browser.

### Using a different port

If `PORT` is already in use, the server explains why and exits rather than failing silently or
picking a random port:

```bash
# Linux/macOS
PORT=3550 npm start

# Windows PowerShell
$env:PORT=3550; npm start
```

Or set `PORT=3550` in `.env` and restart.

## Test

```bash
npm test
```

290 tests via Node's built-in test runner, no external test dependency. See
[docs/test-report.md](docs/test-report.md) for full results and what is/isn't covered.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | How to use the app — assets, signals, backtesting, Demo/Real trading, risk settings, emergency stop, troubleshooting |
| [docs/api-documentation.md](docs/api-documentation.md) | Every REST endpoint, request/response shapes, error codes |
| [docs/architecture.md](docs/architecture.md) | Stack, directory layout, request flow, database/mode isolation, every deviation from the original plan and why |
| [docs/technical-documentation.md](docs/technical-documentation.md) | Objective, scope, limitations, indicators, fundamentals, scoring, risk, backtesting, security, deployment, future work |
| [docs/test-report.md](docs/test-report.md) | Test results, coverage by area, bugs the test suite caught and fixed, honest gaps |
| [docs/phase1-technology-selection.md](docs/phase1-technology-selection.md) | Technology research and selection rationale |
| [docs/phase2-requirements-architecture.md](docs/phase2-requirements-architecture.md) | Original requirements/architecture/DB/API design, with implementation-time deviations noted inline |

## Project status

All 8 build phases complete: research, requirements/architecture, skeleton, backend core
(market data, technical + fundamental analysis, signals, risk), backtesting/demo/real trading +
API routes, the Vanilla JS dashboard, automated tests, and this documentation set. See
[docs/technical-documentation.md](docs/technical-documentation.md) for known limitations and
what's intentionally left for future work — most notably, the frontend has not yet been
click-tested in a real browser (no headless browser was available during development).
