'use strict';

const exchangeClientFactory = require('../exchanges/exchange-client-factory');
const candlesRepository = require('../../database/repositories/candles-repository');
const { validateCandles, timeframeToMs } = require('./candle-validator');
const { withRetry } = require('../../utils/retry');
const config = require('../../../config/config');
const logger = require('../logging/logger');

const SUPPORTED_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

function normalizeCandle({ symbol, exchange, timeframe, ohlcv, source }) {
  const [tsUtc, open, high, low, close, volume] = ohlcv;
  return { symbol, exchange, timeframe, tsUtc, open, high, low, close, volume, source };
}

function assertTimeframeSupported(exchangeClient, timeframe) {
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    throw new Error(`Timeframe "${timeframe}" is not one of the supported timeframes: ${SUPPORTED_TIMEFRAMES.join(', ')}`);
  }
  if (exchangeClient.timeframes && !exchangeClient.timeframes[timeframe]) {
    throw new Error(`Exchange "${exchangeClient.id}" does not support timeframe "${timeframe}"`);
  }
}

/**
 * Fetches fresh OHLCV candles from the exchange, validates them, persists valid rows to
 * the local cache, and returns { candles, errors } — never throws away invalid data silently.
 *
 * `market` (optional, default 'spot') selects which exchange-client-factory resolver to use —
 * 'futures' routes through getPublicFuturesExchange (KuCoin-only, defaultType: 'swap') instead of
 * the spot-only client. Every existing caller omits this and is unaffected. Candles are cached in
 * the same `candles` table regardless — a futures symbol's colon-suffixed ccxt format (e.g.
 * BTC/USDT:USDT) is just a different string in that table's `symbol` column, so it never
 * collides with the spot BTC/USDT rows.
 */
async function fetchAndStoreCandles({ symbol, exchange, timeframe, limit = 200, market = 'spot' }) {
  const client = market === 'futures' ? exchangeClientFactory.getPublicFuturesExchange(exchange) : exchangeClientFactory.getPublicExchange(exchange);
  await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });
  assertTimeframeSupported(client, timeframe);

  if (!client.markets[symbol]) {
    throw new Error(`Symbol "${symbol}" is not available on exchange "${exchange}"`);
  }

  const raw = await withRetry(() => client.fetchOHLCV(symbol, timeframe, undefined, limit), { maxRetries: config.maxApiRetries });
  const normalized = raw.map((ohlcv) => normalizeCandle({ symbol, exchange, timeframe, ohlcv, source: 'live' }));
  const { valid, errors } = validateCandles(normalized, timeframe);

  if (errors.length > 0) {
    logger.warn('market-data', `Rejected ${errors.length} invalid candle(s) for ${symbol}@${exchange}/${timeframe}`, { errors: errors.slice(0, 5) });
  }

  candlesRepository.upsertCandles(valid);
  return { candles: valid, errors };
}

/** Returns cached candles, refreshing from the exchange if the cache is missing or stale.
 *  `market` — see fetchAndStoreCandles's doc comment. */
async function getCandles({ symbol, exchange, timeframe, limit = 200, market = 'spot' }) {
  const latestTs = candlesRepository.getLatestCandleTime({ symbol, exchange, timeframe });
  const staleThresholdMs = timeframeToMs(timeframe);
  const isStale = latestTs === null || Date.now() - latestTs > staleThresholdMs;

  if (isStale) {
    try {
      await fetchAndStoreCandles({ symbol, exchange, timeframe, limit, market });
    } catch (err) {
      logger.error('market-data', `Failed to refresh candles for ${symbol}@${exchange}/${timeframe}: ${err.message}`);
      // Fall through — serve whatever is cached, if anything; caller decides if it's enough.
    }
  }

  return candlesRepository.getCandles({ symbol, exchange, timeframe, limit });
}

/** Live snapshot: price, 24h change/volume, market status, and data freshness for the dashboard. */
async function getSnapshot({ symbol, exchange }) {
  const client = exchangeClientFactory.getPublicExchange(exchange);
  try {
    await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });
    if (!client.markets[symbol]) {
      return { symbol, exchange, status: 'invalid', error: `Symbol "${symbol}" not found on "${exchange}"` };
    }

    const ticker = await withRetry(() => client.fetchTicker(symbol), { maxRetries: config.maxApiRetries });
    const fetchedAtMs = Date.now();
    const tickerTimestampMs = ticker.timestamp || fetchedAtMs;

    return {
      symbol,
      exchange,
      status: 'ok',
      price: ticker.last ?? null,
      changePercent24h: ticker.percentage ?? null,
      volume24h: ticker.baseVolume ?? null,
      marketOpen: client.markets[symbol].active !== false,
      dataFreshnessMs: fetchedAtMs - tickerTimestampMs,
      asOfUtc: new Date(tickerTimestampMs).toISOString(),
    };
  } catch (err) {
    logger.error('market-data', `Failed to fetch snapshot for ${symbol}@${exchange}: ${err.message}`);
    return { symbol, exchange, status: 'unavailable', error: err.message };
  }
}

/** Futures analog of getSnapshot — same shape, routed through getPublicFuturesExchange
 *  (KuCoin-only) instead of the spot-only client. Used by the futures order services for a live
 *  reference price at order time, and by futures-portfolio-service.js for unrealized P&L. */
async function getFuturesSnapshot({ symbol, exchange }) {
  const client = exchangeClientFactory.getPublicFuturesExchange(exchange);
  try {
    await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });
    if (!client.markets[symbol]) {
      return { symbol, exchange, status: 'invalid', error: `Symbol "${symbol}" not found on "${exchange}"` };
    }

    const ticker = await withRetry(() => client.fetchTicker(symbol), { maxRetries: config.maxApiRetries });
    const fetchedAtMs = Date.now();
    const tickerTimestampMs = ticker.timestamp || fetchedAtMs;

    return {
      symbol,
      exchange,
      status: 'ok',
      price: ticker.last ?? null,
      changePercent24h: ticker.percentage ?? null,
      volume24h: ticker.baseVolume ?? null,
      marketOpen: client.markets[symbol].active !== false,
      dataFreshnessMs: fetchedAtMs - tickerTimestampMs,
      asOfUtc: new Date(tickerTimestampMs).toISOString(),
    };
  } catch (err) {
    logger.error('market-data', `Failed to fetch futures snapshot for ${symbol}@${exchange}: ${err.message}`);
    return { symbol, exchange, status: 'unavailable', error: err.message };
  }
}

module.exports = {
  fetchAndStoreCandles,
  getCandles,
  getSnapshot,
  getFuturesSnapshot,
  SUPPORTED_TIMEFRAMES,
};
