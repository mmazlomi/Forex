'use strict';

const fundamentalsCacheRepository = require('../../database/repositories/fundamentals-cache-repository');
const { fetchStockFundamentals } = require('./providers/finnhub');
const { fetchCryptoFundamentals, resolveCoinId } = require('./providers/coingecko');
const logger = require('../logging/logger');

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes — simplification: one TTL for all field groups.
const FIELD_GROUP = 'core';

const STOCK_ONLY_FIELDS = ['revenue', 'netIncome', 'eps', 'peRatio', 'debtRatio', 'cashFlow', 'revenueGrowth'];
const CRYPTO_ONLY_FIELDS = ['fdv', 'circulatingSupply', 'totalSupply', 'volume24h', 'liquidity', 'exchangeListings', 'events'];

function unavailableCryptoResult(reason) {
  const unavailable = { value: 'unavailable', source: 'coingecko', unavailableReason: reason };
  return {
    assetType: 'crypto',
    fetchedAtUtc: new Date().toISOString(),
    fields: {
      marketCap: unavailable, fdv: unavailable, circulatingSupply: unavailable, totalSupply: unavailable,
      volume24h: unavailable, liquidity: unavailable, exchangeListings: unavailable, news: unavailable,
      events: unavailable, marketHealthStatus: unavailable,
    },
  };
}

function notApplicable(assetType) {
  return { value: 'not_applicable', reason: `This metric does not apply to ${assetType} assets.` };
}

function normalize(assetType, providerResult) {
  const fields = { ...providerResult.fields };

  // overallStatus / marketHealthStatus unified under one key.
  const healthStatus = fields.overallStatus || fields.marketHealthStatus || { value: 'unavailable', unavailableReason: 'not_computed' };
  delete fields.overallStatus;
  delete fields.marketHealthStatus;
  fields.healthStatus = healthStatus;

  const otherTypeFields = assetType === 'stock' ? CRYPTO_ONLY_FIELDS : STOCK_ONLY_FIELDS;
  for (const key of otherTypeFields) {
    if (!(key in fields)) fields[key] = notApplicable(assetType);
  }

  return { assetType, fetchedAtUtc: providerResult.fetchedAtUtc, fields };
}

/**
 * Returns normalized fundamentals for a symbol, cache-through with a 15-minute TTL.
 * `providerId`, if given, is trusted as-is (CoinGecko coin id, e.g. "bitcoin") — callers that
 * already know it can skip resolution. If omitted for a crypto asset, the coin id is resolved
 * from the trading pair's base ticker (e.g. "BTC/USDT" -> "BTC" -> "bitcoin") via
 * coingecko.resolveCoinId(); a naive `ticker.toLowerCase()` is NOT a valid CoinGecko id (that
 * was a real bug — CoinGecko ids are slugs like "bitcoin", not tickers like "btc", and every
 * fundamentals field silently showed "unavailable" as a result of the 404 this caused).
 */
async function getFundamentals({ symbol, assetType, providerId }) {
  const cached = fundamentalsCacheRepository.get({ symbol, assetType, fieldGroup: FIELD_GROUP });
  if (fundamentalsCacheRepository.isFresh(cached)) {
    return { ...JSON.parse(cached.data_json), cacheHit: true };
  }

  let providerResult;
  let provider;
  if (assetType === 'stock') {
    providerResult = await fetchStockFundamentals(symbol);
    provider = 'finnhub';
  } else if (assetType === 'crypto') {
    provider = 'coingecko';
    const baseTicker = symbol.split('/')[0];
    const coinId = providerId || (await resolveCoinId(baseTicker));
    providerResult = coinId
      ? await fetchCryptoFundamentals(coinId)
      : unavailableCryptoResult(`could_not_resolve_coingecko_id_for_ticker_${baseTicker}`);
  } else {
    throw new Error(`Unknown assetType "${assetType}" — must be "stock" or "crypto"`);
  }

  const normalized = normalize(assetType, providerResult);
  const fetchedAtUtc = new Date().toISOString();
  const expiresAtUtc = new Date(Date.now() + CACHE_TTL_MS).toISOString();

  fundamentalsCacheRepository.set({
    symbol,
    assetType,
    fieldGroup: FIELD_GROUP,
    dataJson: JSON.stringify(normalized),
    provider,
    fetchedAtUtc,
    expiresAtUtc,
  });

  if (providerResult.error) {
    logger.warn('fundamental-analysis', `Provider error for ${symbol} (${assetType}): ${providerResult.error}`);
  }

  return { ...normalized, cacheHit: false };
}

module.exports = { getFundamentals };
