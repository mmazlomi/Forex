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

// Credential-free public clients are cached per exchange id for this long, then rebuilt from
// scratch on next use. ccxt's own loadMarkets() already skips its network call once a client's
// this.markets is populated — but every getPublicExchange()/getPublicFuturesExchange() call used
// to hand callers a BRAND NEW client instance, so that built-in skip never actually triggered:
// every position/signal/candle fetch was re-downloading the exchange's entire market list before
// it could do the one ticker/OHLCV call it actually needed. Reusing the same instance across calls
// makes that skip work as designed; the TTL just bounds how long a delisted/newly-listed symbol
// can go unnoticed.
const PUBLIC_CLIENT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — market lists change rarely
const publicSpotClientCache = new Map();
const publicFuturesClientCache = new Map();

function getCachedPublicClient(cache, exchangeName, buildClient) {
  const key = String(exchangeName || '').toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.createdAt < PUBLIC_CLIENT_CACHE_TTL_MS) {
    return cached.client;
  }
  const client = buildClient();
  cache.set(key, { client, createdAt: Date.now() });
  return client;
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
  return getCachedPublicClient(publicSpotClientCache, exchangeName, () => {
    const ExchangeClass = resolveExchangeClass(exchangeName);
    return skipUnusedCurrencyFetch(new ExchangeClass({ enableRateLimit: true, timeout: config.requestTimeoutMs, options: SPOT_ONLY_OPTIONS }));
  });
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
// them touch SPOT_ONLY_OPTIONS or each other. Each entry here is an exchange that's been
// individually confirmed reachable from this app's production host (Bybit was rejected outright —
// 403/CloudFront geo-block plus timeouts, a real server-side network block, not a code bug — see
// docs/architecture.md Phase 2 section) and whose ccxt futures/swap surface (setLeverage,
// fetchPositions, createOrder, fetchBalance, reduceOnly) has been read/verified directly against
// ccxt's source. Any exchange id not in this map is rejected outright rather than silently
// attempted unverified.
//
// `ccxtId`: which ccxt class implements this exchange's futures/swap API. KuCoin's is a genuinely
// SEPARATE class (`kucoinfutures`, not `kucoin` with a defaultType option) — resolveExchangeClass
// above resolves 'kucoin' to the *spot* class. CoinEx, by contrast, is a single unified class
// (`coinex`) that serves spot and swap off one class via `options.defaultType`.
//
// `instantiateOptions`: extra ccxt constructor options merged in when instantiating. CoinEx needs
// `options.defaultType: 'swap'` so unqualified calls (loadMarkets, fetchTicker, etc.) hit the
// futures/swap endpoints instead of spot; KuCoin's dedicated class needs nothing extra.
//
// `leverageMode`: how leverage/margin-mode get set on this exchange, since it differs by API shape
// — see futures-real-orders.js, the only caller that branches on it. 'inline': merged straight into
// the createOrder() params (KuCoin's own default for contract orders — confirmed via ccxt's
// createContractOrderRequest() source). 'preset': leverage/margin-mode must be set via a separate
// setLeverage() call before createOrder() — CoinEx's createOrder does not accept leverage/marginMode
// in its params (confirmed via ccxt's coinex.js createOrderRequest()); its setLeverage() accepts
// marginMode via params (default 'cross') and requires an explicit symbol argument (verified: CoinEx
// futures uses the standard swap fetchPositions().liquidationPrice unified field, populated from
// its own `liq_price`, and reduceOnly on close works identically to KuCoin's).
const FUTURES_EXCHANGES = {
  kucoin: { ccxtId: 'kucoinfutures', instantiateOptions: {}, leverageMode: 'inline' },
  coinex: { ccxtId: 'coinex', instantiateOptions: { options: { defaultType: 'swap' } }, leverageMode: 'preset' },
};
const DEFAULT_FUTURES_EXCHANGE_ID = 'kucoin';

function assertFuturesExchangeSupported(exchangeName) {
  const id = String(exchangeName || '').toLowerCase();
  if (!FUTURES_EXCHANGES[id]) {
    throw new Error(`Futures trading is only supported on ${Object.keys(FUTURES_EXCHANGES).join(', ')} in this app (got "${exchangeName}").`);
  }
  return id;
}

/** [{id, name}] for every futures-supported exchange — backs GET /api/futures/exchanges. */
function getSupportedFuturesExchanges() {
  return Object.keys(FUTURES_EXCHANGES).map((id) => {
    const ExchangeClass = ccxt[FUTURES_EXCHANGES[id].ccxtId];
    return { id, name: (ExchangeClass && new ExchangeClass({}).name) || id };
  });
}

function resolveFuturesExchangeClass(exchangeName) {
  const id = assertFuturesExchangeSupported(exchangeName);
  const { ccxtId } = FUTURES_EXCHANGES[id];
  const ExchangeClass = ccxt[ccxtId];
  if (!ExchangeClass) {
    throw new Error(`ccxt has no "${ccxtId}" class in this installed version.`);
  }
  return ExchangeClass;
}

function instantiateFuturesExchange(exchangeName, credentialOptions = {}) {
  const id = assertFuturesExchangeSupported(exchangeName);
  const ExchangeClass = resolveFuturesExchangeClass(id);
  const { instantiateOptions } = FUTURES_EXCHANGES[id];
  return new ExchangeClass({ enableRateLimit: true, timeout: config.requestTimeoutMs, ...credentialOptions, ...instantiateOptions });
}

/** Market-data / read-only futures client. No credentials. */
function getPublicFuturesExchange(exchangeName = DEFAULT_FUTURES_EXCHANGE_ID) {
  return getCachedPublicClient(publicFuturesClientCache, exchangeName, () => instantiateFuturesExchange(exchangeName));
}

/**
 * Demo-mode futures client. Not currently called by futures-demo-orders.js (Demo futures, like
 * Demo spot, is simulated locally against live public market data — see demo-orders.js, which
 * likewise never calls getDemoExchange()) — kept for parity/future use, e.g. if a real sandbox
 * order is ever wanted for Demo.
 */
function getDemoFuturesExchange() {
  const client = instantiateFuturesExchange(config.demoExchange.name || DEFAULT_FUTURES_EXCHANGE_ID, {
    apiKey: config.demoExchange.apiKey,
    secret: config.demoExchange.apiSecret,
  });
  if (typeof client.setSandboxMode === 'function') {
    client.setSandboxMode(true);
  }
  return client;
}

/**
 * Real-mode futures client for this user: same exchange account/credentials as their spot Real
 * trading (resolved via the same resolveRealCredentials()) — instantiated as the exchange's
 * dedicated futures/swap ccxt class+options rather than its plain spot one.
 */
function getRealFuturesExchange(userId) {
  const credentials = resolveRealCredentials(userId);
  if (!credentials.name) {
    throw new Error('No Real Trading exchange is configured (set it from the Real Trading tab, or REAL_EXCHANGE_NAME in .env).');
  }
  return instantiateFuturesExchange(credentials.name, { apiKey: credentials.apiKey, secret: credentials.apiSecret });
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
  isFuturesExchangeSupported: (exchangeName) => !!FUTURES_EXCHANGES[String(exchangeName || '').toLowerCase()],
  getFuturesLeverageMode: (exchangeName) => FUTURES_EXCHANGES[String(exchangeName || '').toLowerCase()]?.leverageMode,
  getSupportedFuturesExchanges,
};
