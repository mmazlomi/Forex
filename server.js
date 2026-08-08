'use strict';

const path = require('path');
const express = require('express');
const config = require('./config/config');
const { getDb } = require('./src/database/connection');
const apiRoutes = require('./src/routes');
const authRoutes = require('./src/routes/auth-routes');
const { requireAuth } = require('./src/middleware/require-auth');
const { createRateLimiter } = require('./src/middleware/rate-limiter');
const { sendSuccess } = require('./src/utils/http-response');
const logger = require('./src/services/logging/logger');
const { maskKnownSecrets } = require('./src/utils/mask-secrets');
const autoTrader = require('./src/services/scheduler/auto-trader');
const pendingOrdersWatcher = require('./src/services/scheduler/pending-orders-watcher');
const positionRiskWatcher = require('./src/services/scheduler/position-risk-watcher');
const futuresAutoTrader = require('./src/services/scheduler/futures-auto-trader');
const strategySelector = require('./src/services/scheduler/strategy-selector');

const KNOWN_SECRETS = [
  config.demoExchange.apiKey,
  config.demoExchange.apiSecret,
  config.realExchange.apiKey,
  config.realExchange.apiSecret,
  config.fundamentalApiKey,
].filter(Boolean);

// Reverse-proxy path prefixes this app is reachable under (in addition to its own root) —
// currently just nginx's /forex/ mount (see /etc/nginx/sites-available/solarScada). Stripped
// here, on the raw req.url string, before Express does any decoding/routing: nginx forwards
// $request_uri byte-for-byte (proxy_pass with no trailing path/URI part), which is required to
// keep %2F intact for symbols like BTC/USDT in a path segment — nginx's own rewrite/proxy_pass
// URI substitution would otherwise silently decode %2F to a literal /, breaking routing.
const REVERSE_PROXY_PREFIXES = ['/forex'];

function stripKnownPrefix(req, res, next) {
  const match = REVERSE_PROXY_PREFIXES.find((p) => req.url === p || req.url.startsWith(`${p}/`) || req.url.startsWith(`${p}?`));
  if (match) {
    const rest = req.url.slice(match.length);
    req.url = rest === '' ? '/' : rest.startsWith('/') ? rest : `/${rest}`;
  }
  next();
}

function createApp() {
  const app = express();

  app.use(stripKnownPrefix);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const generalLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 300 });
  app.use('/api', generalLimiter);

  app.get('/api/health', (req, res) => {
    sendSuccess(res, {
      status: 'ok',
      nodeEnv: config.nodeEnv,
      tradingMode: config.tradingMode,
      liveTradingEnabled: config.enableLiveTrading,
    });
  });

  // /api/auth/* (signup, login, logout, me) is intentionally mounted before the auth gate below
  // — you need to be able to call these while logged out. Everything else under /api requires a
  // valid session; login is mandatory to use the app at all (only the Watchlist's data is
  // actually partitioned per account — see docs/architecture.md — but the login gate itself
  // covers the whole API).
  app.use('/api/auth', authRoutes);
  app.use('/api', requireAuth);
  app.use('/api', apiRoutes);

  // Fallback error handler — never leak stack traces or secrets.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const safeMessage = maskKnownSecrets(err?.message || 'Unknown error', KNOWN_SECRETS);
    logger.error('http', `Unhandled error on ${req.method} ${req.path}: ${safeMessage}`);
    res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

function start() {
  // Initialize the database and apply schema before accepting traffic.
  getDb();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Trading bot server listening on http://localhost:${config.port} (mode: ${config.tradingMode}, live trading: ${config.enableLiveTrading})`);
  });

  // Started only for the real server boot, not for test servers (see tests/fixtures/test-server.js,
  // which calls createApp() directly) — auto-trading is Demo-only regardless, but tests shouldn't
  // have a background interval touching their in-memory DB unexpectedly.
  autoTrader.start();
  pendingOrdersWatcher.start();
  positionRiskWatcher.start();
  futuresAutoTrader.start();
  strategySelector.start();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const suggestedPort = config.port + 100;
      console.error(
        `\nPort ${config.port} is already in use.\n\n` +
        `Another process is listening on this port. To use a different port:\n\n` +
        `  Linux/macOS:\n` +
        `    PORT=${suggestedPort} npm start\n\n` +
        `  Windows PowerShell:\n` +
        `    $env:PORT=${suggestedPort}; npm start\n\n` +
        `Or set PORT=${suggestedPort} in your .env file and restart.\n`
      );
      process.exit(1);
    }
    throw err;
  });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { createApp, start };
