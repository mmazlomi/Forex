'use strict';

const ccxt = require('ccxt');
const config = require('../../../config/config');
const { resolveRealCredentials } = require('./real-credentials-resolver');
const { CUSTOM_EXCHANGES } = require('./custom-exchange-registry');

// v1 is spot-only (see docs/phase2-requirements-architecture.md §1.6 — futures out of scope).
// Restricting loadMarkets() to spot avoids exchanges also querying unrelated futures/swap
// endpoints we never use (which, on some exchanges, live on a different subdomain that may
// not even be reachable — this isn't just an optimization, it fixed a real 500 in Phase 5
// where kucoin's futures endpoint was unreachable but its spot endpoint worked fine).
const SPOT_ONLY_OPTIONS = { fetchMarkets: { types: ['spot'] } };

function resolveExchangeClass(exchangeName) {
  const id = String(exchangeName || '').toLowerCase();
  const ExchangeClass = CUSTOM_EXCHANGES[id] || ccxt[id];
  if (!ExchangeClass) {
    throw new Error(`Unsupported or unknown exchange id: "${exchangeName}"`);
  }
  return ExchangeClass;
}

// On exchanges where ccxt's `has.fetchCurrencies` is true (e.g. CoinEx), loadMarkets() fetches
// currency deposit/withdrawal config as a PREREQUISITE to the market list itself — see ccxt's
// Exchange#loadMarketsHelper. This app never reads currency-level data (no deposit/withdraw UI,
// no use of client.currencies anywhere), but a failure on that one unrelated sub-call still
// rejects the whole loadMarkets() call, taking down market data/candles/signals for the entire
// exchange even when its actual markets/ticker endpoints are healthy (real-world case: CoinEx's
// "assets/all-deposit-withdraw-config" failing while "spot/market" and tickers work fine). Same
// motivating principle as SPOT_ONLY_OPTIONS above — don't depend on endpoints we don't use.
function skipUnusedCurrencyFetch(client) {
  if (client.has) client.has.fetchCurrencies = false;
  return client;
}

/** Market-data / read-only client. No credentials — works for any exchange without an account. */
function getPublicExchange(exchangeName) {
  const ExchangeClass = resolveExchangeClass(exchangeName);
  return skipUnusedCurrencyFetch(new ExchangeClass({ enableRateLimit: true, timeout: config.requestTimeoutMs, options: SPOT_ONLY_OPTIONS }));
}

/** Demo-mode client: uses DEMO_* credentials and enables the exchange sandbox/testnet if supported. */
function getDemoExchange() {
  if (!config.demoExchange.name) {
    throw new Error('DEMO_EXCHANGE_NAME is not configured in .env');
  }
  const ExchangeClass = resolveExchangeClass(config.demoExchange.name);
  const client = skipUnusedCurrencyFetch(new ExchangeClass({
    apiKey: config.demoExchange.apiKey,
    secret: config.demoExchange.apiSecret,
    enableRateLimit: true,
    timeout: config.requestTimeoutMs,
    options: SPOT_ONLY_OPTIONS,
  }));
  if (typeof client.setSandboxMode === 'function') {
    client.setSandboxMode(true);
  }
  return client;
}

/**
 * Real-mode client for this user: uses whichever Real credentials are currently configured for
 * them — either set via the UI (stored encrypted in the database) or, for the legacy data owner
 * only, REAL_EXCHANGE_NAME/REAL_API_KEY/REAL_API_SECRET in `.env` — resolved fresh on every call
 * (see real-credentials-resolver.js). Never sandboxed.
 */
function getRealExchange(userId) {
  const credentials = resolveRealCredentials(userId);
  if (!credentials.name) {
    throw new Error('No Real Trading exchange is configured (set it from the Real Trading tab, or REAL_EXCHANGE_NAME in .env).');
  }
  const ExchangeClass = resolveExchangeClass(credentials.name);
  return skipUnusedCurrencyFetch(new ExchangeClass({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    timeout: config.requestTimeoutMs,
    options: SPOT_ONLY_OPTIONS,
  }));
}

// Phase 2 (Futures): a completely separate resolver path from the spot functions above — none of
// them touch SPOT_ONLY_OPTIONS or each other. KuCoin only, chosen because it's confirmed reachable
// from this app's production host (KuCoin's API returned 403/timeouts from here — a real,
// server-side network/CDN block, not a code bug; see docs/architecture.md Phase 2 section).
// KuCoin's futures API is a genuinely SEPARATE ccxt class (`kucoinfutures`, not `kucoin` with a
// defaultType option) — resolveExchangeClass('kucoin') above resolves to the *spot* class, so
// futures needs its own class resolver, mapping the same user-facing/credential exchange name
// ('kucoin', the same one used everywhere else in this app) to the correct ccxt class. Confirmed
// via ccxt's own kucoinfutures.js/kucoin.js source: setLeverage/setMarginMode/fetchPositions/
// createOrder/fetchBalance all present, defaultType 'swap' built into the class already, and
// fetchPositions' returned liquidationPrice uses the same unified field name KuCoin's did. Any
// other exchange id is rejected outright rather than silently attempted unverified.
const FUTURES_EXCHANGE_ID = 'kucoin';
const FUTURES_CCXT_CLASS_ID = 'kucoinfutures';

function assertFuturesExchangeSupported(exchangeName) {
  const id = String(exchangeName || '').toLowerCase();
  if (id !== FUTURES_EXCHANGE_ID) {
    throw new Error(`Futures trading is only supported on KuCoin in this app (got "${exchangeName}").`);
  }
}

function resolveFuturesExchangeClass(exchangeName) {
  assertFuturesExchangeSupported(exchangeName);
  const ExchangeClass = ccxt[FUTURES_CCXT_CLASS_ID];
  if (!ExchangeClass) {
    throw new Error(`ccxt has no "${FUTURES_CCXT_CLASS_ID}" class in this installed version.`);
  }
  return ExchangeClass;
}

/** Market-data / read-only futures client. No credentials — KuCoin only. */
function getPublicFuturesExchange(exchangeName = FUTURES_EXCHANGE_ID) {
  const ExchangeClass = resolveFuturesExchangeClass(exchangeName);
  return new ExchangeClass({ enableRateLimit: true, timeout: config.requestTimeoutMs });
}

/**
 * Demo-mode futures client. Not currently called by futures-demo-orders.js (Demo futures, like
 * Demo spot, is simulated locally against live public market data — see demo-orders.js, which
 * likewise never calls getDemoExchange()) — kept for parity/future use, e.g. if a real sandbox
 * order is ever wanted for Demo.
 */
function getDemoFuturesExchange() {
  const ExchangeClass = resolveFuturesExchangeClass(config.demoExchange.name || FUTURES_EXCHANGE_ID);
  const client = new ExchangeClass({
    apiKey: config.demoExchange.apiKey,
    secret: config.demoExchange.apiSecret,
    enableRateLimit: true,
    timeout: config.requestTimeoutMs,
  });
  if (typeof client.setSandboxMode === 'function') {
    client.setSandboxMode(true);
  }
  return client;
}

/**
 * Real-mode futures client for this user: same KuCoin account/credentials as their spot Real
 * trading (resolved via the same resolveRealCredentials()) — KuCoin API keys work across both the
 * spot and futures endpoints on the same account — just instantiated as the dedicated
 * `kucoinfutures` ccxt class instead of `kucoin`.
 */
function getRealFuturesExchange(userId) {
  const credentials = resolveRealCredentials(userId);
  if (!credentials.name) {
    throw new Error('No Real Trading exchange is configured (set it from the Real Trading tab, or REAL_EXCHANGE_NAME in .env).');
  }
  const ExchangeClass = resolveFuturesExchangeClass(credentials.name);
  return new ExchangeClass({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    timeout: config.requestTimeoutMs,
  });
}

/** Checks whether an exchange declares a sandbox/testnet URL in ccxt, without making a network call. */
function probeSandboxSupport(exchangeName) {
  const ExchangeClass = resolveExchangeClass(exchangeName);
  const instance = new ExchangeClass({});
  const urls = instance.urls || {};
  return {
    exchangeId: instance.id,
    hasSandbox: !!urls.test,
    testUrls: urls.test || null,
  };
}

module.exports = {
  getPublicExchange,
  getDemoExchange,
  getRealExchange,
  probeSandboxSupport,
  getPublicFuturesExchange,
  getDemoFuturesExchange,
  getRealFuturesExchange,
};
