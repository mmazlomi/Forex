'use strict';

const config = require('../../../../config/config');
const fundamentalsCacheRepository = require('../../../database/repositories/fundamentals-cache-repository');

const BASE_URL = 'https://api.coingecko.com/api/v3';
const ID_RESOLUTION_FIELD_GROUP = 'coingecko-id-resolution';
const ID_RESOLUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ticker->id mappings are effectively static

function unavailable(reason) {
  return { value: 'unavailable', source: 'coingecko', unavailableReason: reason };
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    // CoinGecko's free "Demo" plan accepts a key via this header; public (keyless) access also works.
    if (config.fundamentalApiKey) headers['x-cg-demo-api-key'] = config.fundamentalApiKey;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) {
      throw new Error(`CoinGecko request failed: HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves a trading ticker (e.g. "BTC") to CoinGecko's own coin id (e.g. "bitcoin") — these
 * are NOT the same thing (a naive `ticker.toLowerCase()` guess 404s for almost every coin;
 * CoinGecko ids are slugs, not tickers). Uses CoinGecko's /search endpoint, picks the exact
 * ticker match with the lowest (best) market_cap_rank to avoid wrapped-token/scam-coin
 * impostors sharing the same ticker, and caches the result for 30 days since this mapping is
 * effectively static. Returns null if no exact match is found.
 */
async function resolveCoinId(tickerSymbol, { timeoutMs = config.requestTimeoutMs } = {}) {
  const ticker = tickerSymbol.toUpperCase();
  const cached = fundamentalsCacheRepository.get({ symbol: ticker, assetType: 'crypto', fieldGroup: ID_RESOLUTION_FIELD_GROUP });
  if (fundamentalsCacheRepository.isFresh(cached)) {
    return JSON.parse(cached.data_json).coinId;
  }

  let coinId = null;
  try {
    const data = await fetchJson(`${BASE_URL}/search?query=${encodeURIComponent(ticker)}`, timeoutMs);
    const exactMatches = (data.coins || []).filter((c) => c.symbol?.toUpperCase() === ticker);
    exactMatches.sort((a, b) => (a.market_cap_rank ?? Infinity) - (b.market_cap_rank ?? Infinity));
    coinId = exactMatches[0]?.id ?? null;
  } catch {
    return null; // network/parse failure — caller falls back to "unavailable", never fabricates an id
  }

  if (coinId) {
    const fetchedAtUtc = new Date().toISOString();
    fundamentalsCacheRepository.set({
      symbol: ticker, assetType: 'crypto', fieldGroup: ID_RESOLUTION_FIELD_GROUP,
      dataJson: JSON.stringify({ coinId }), provider: 'coingecko', fetchedAtUtc,
      expiresAtUtc: new Date(Date.now() + ID_RESOLUTION_TTL_MS).toISOString(),
    });
  }
  return coinId;
}

/**
 * Crypto fundamentals via CoinGecko's public/demo API (works without a key on the free tier,
 * subject to a lower rate limit). `coinId` is CoinGecko's slug (e.g. "bitcoin"), not the ticker.
 */
async function fetchCryptoFundamentals(coinId, { timeoutMs = config.requestTimeoutMs } = {}) {
  const fetchedAtUtc = new Date().toISOString();
  try {
    const data = await fetchJson(
      `${BASE_URL}/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
      timeoutMs
    );
    const md = data.market_data || {};
    const withSource = (value) =>
      value === undefined || value === null
        ? unavailable('not_provided_by_source')
        : { value, source: 'coingecko', fetchedAtUtc };

    return {
      assetType: 'crypto',
      fetchedAtUtc,
      fields: {
        marketCap: withSource(md.market_cap?.usd),
        fdv: withSource(md.fully_diluted_valuation?.usd),
        circulatingSupply: withSource(md.circulating_supply),
        totalSupply: withSource(md.total_supply),
        volume24h: withSource(md.total_volume?.usd),
        liquidity: unavailable('coingecko_does_not_report_orderbook_liquidity_directly'),
        exchangeListings: withSource(data.tickers ? data.tickers.length : undefined),
        news: unavailable('news_endpoint_not_called_in_this_request'),
        events: unavailable('coingecko_free_tier_has_no_events_endpoint'),
        marketHealthStatus: computeHealthStatus(md),
      },
    };
  } catch (err) {
    return {
      assetType: 'crypto',
      fetchedAtUtc,
      error: err.message,
      fields: {
        marketCap: unavailable('fetch_failed'),
        fdv: unavailable('fetch_failed'),
        circulatingSupply: unavailable('fetch_failed'),
        totalSupply: unavailable('fetch_failed'),
        volume24h: unavailable('fetch_failed'),
        liquidity: unavailable('fetch_failed'),
        exchangeListings: unavailable('fetch_failed'),
        news: unavailable('fetch_failed'),
        events: unavailable('fetch_failed'),
        marketHealthStatus: unavailable('fetch_failed'),
      },
    };
  }
}

function computeHealthStatus(marketData) {
  const changePercent = marketData.price_change_percentage_24h;
  if (changePercent === undefined || changePercent === null) {
    return unavailable('insufficient_data_for_health_status');
  }
  // Documented rule: >2% => healthy, <-2% => weak, else neutral. Simple, transparent, not a prediction.
  let status = 'neutral';
  if (changePercent > 2) status = 'healthy';
  else if (changePercent < -2) status = 'weak';
  return { value: status, source: 'coingecko', basis: '24h_price_change_percent', changePercent24h: changePercent };
}

module.exports = { fetchCryptoFundamentals, resolveCoinId };
