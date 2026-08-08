'use strict';

const exchangeClientFactory = require('../exchanges/exchange-client-factory');
const candlesRepository = require('../../database/repositories/candles-repository');
const { validateCandles, timeframeToMs } = require('../market-data/candle-validator');
const { withRetry } = require('../../utils/retry');
const config = require('../../../config/config');

const MAX_PAGES = 40; // safety cap so a bad range/timeframe can't loop forever

/**
 * Fetches and caches every candle in [sinceMs, untilMs] via paginated ccxt calls, validating
 * each page the same way live market data is validated. Returns the full sorted, deduplicated
 * candle list for that range (from the cache, so repeated backtests over the same range don't
 * re-fetch).
 *
 * `market` mirrors market-data-service.js#getCandles's spot/futures client split — 'spot'
 * (default, unchanged behavior) uses the regular public client; 'futures' routes through
 * getPublicFuturesExchange (KuCoin-only, and confirmed less reliable from this deployment's host
 * than spot — see exchange-client-factory.js). Omitting `market` entirely is byte-for-byte
 * identical to this function's behavior before futures backtesting existed.
 */
async function fetchHistoricalRange({ symbol, exchange, timeframe, sinceMs, untilMs, market = 'spot' }) {
  const client = market === 'futures'
    ? exchangeClientFactory.getPublicFuturesExchange(exchange)
    : exchangeClientFactory.getPublicExchange(exchange);
  await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });
  if (!client.markets[symbol]) {
    throw new Error(`Symbol "${symbol}" is not available on exchange "${exchange}"`);
  }

  const stepMs = timeframeToMs(timeframe);
  let cursor = sinceMs;
  let page = 0;

  while (cursor <= untilMs && page < MAX_PAGES) {
    const raw = await withRetry(() => client.fetchOHLCV(symbol, timeframe, cursor, 500), { maxRetries: config.maxApiRetries });
    if (!raw || raw.length === 0) break;

    const normalized = raw.map(([tsUtc, open, high, low, close, volume]) => ({
      symbol, exchange, timeframe, tsUtc, open, high, low, close, volume, source: 'backtest-import',
    }));
    const { valid } = validateCandles(normalized, timeframe);
    candlesRepository.upsertCandles(valid);

    const lastTs = raw[raw.length - 1][0];
    if (lastTs <= cursor) break; // exchange isn't advancing — avoid an infinite loop
    cursor = lastTs + stepMs;
    page += 1;
  }

  const all = candlesRepository.getCandles({ symbol, exchange, timeframe, limit: 100000 });
  return all.filter((c) => c.ts_utc >= sinceMs && c.ts_utc <= untilMs);
}

module.exports = { fetchHistoricalRange };
