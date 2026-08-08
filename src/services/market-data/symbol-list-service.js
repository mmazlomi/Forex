'use strict';

const exchangeClientFactory = require('../exchanges/exchange-client-factory');
const { withRetry } = require('../../utils/retry');
const config = require('../../../config/config');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — market lists change rarely; loadMarkets() is a real network call
const cache = new Map(); // exchangeId -> { symbols, expiresAt }

/**
 * Returns every active spot trading symbol on an exchange (e.g. "BTC/USDT"), sorted with the
 * most commonly-quoted pairs (USDT/USD/USDC) first, then alphabetically — for the symbol
 * picker's suggestions. In-memory cached per exchange for an hour; a fresh ccxt client has no
 * market data of its own, so without this every call would re-fetch the full market list.
 */
async function getSymbolsForExchange(exchangeId) {
  const cached = cache.get(exchangeId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.symbols;
  }

  const client = exchangeClientFactory.getPublicExchange(exchangeId);
  await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });

  const preferredQuotes = ['USDT', 'USD', 'USDC'];
  const symbols = Object.values(client.markets)
    .filter((m) => m.active !== false && m.spot)
    .map((m) => m.symbol)
    .sort((a, b) => {
      const aPreferred = preferredQuotes.includes(a.split('/')[1]);
      const bPreferred = preferredQuotes.includes(b.split('/')[1]);
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
      // Plain alphabetical sorts every digit-prefixed multiplier token (e.g. Nobitex's
      // "100K_FLOKI", "1B_BABYDOGE", "1M_BTT" — it has ~10 of these) before any letter, since
      // digits sort before letters. The symbol picker only renders the first 25 matches for an
      // empty/short filter (dashboard.js#showSymbolSuggestions), so on an exchange with many such
      // tokens they crowded out common assets like BTC/ETH entirely from that initial view —
      // looking exactly like "the real symbols aren't listed." Digit-leading symbols are pushed
      // after letter-leading ones (within the same quote-preference group) so major assets
      // surface first; typing to filter still finds every symbol regardless of this ordering.
      const aDigitLeading = /^\d/.test(a);
      const bDigitLeading = /^\d/.test(b);
      if (aDigitLeading !== bDigitLeading) return aDigitLeading ? 1 : -1;
      return a.localeCompare(b);
    });

  cache.set(exchangeId, { symbols, expiresAt: Date.now() + CACHE_TTL_MS });
  return symbols;
}

const futuresCache = new Map(); // exchangeId -> { symbols, expiresAt }

/**
 * Futures analog of getSymbolsForExchange — KuCoin only, filters ccxt's `m.swap` markets instead
 * of `m.spot`, and returns KuCoin's unified BASE/QUOTE:SETTLE symbol strings (e.g.
 * "BTC/USDT:USDT") as-is, since that's the exact string every futures order/candle/position call
 * needs. Kept as a fully separate cache/function from the spot one above, per the "separate
 * everything" Phase 2 decision — see docs/architecture.md.
 */
async function getFuturesSymbolsForExchange(exchangeId) {
  const cached = futuresCache.get(exchangeId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.symbols;
  }

  const client = exchangeClientFactory.getPublicFuturesExchange(exchangeId);
  await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });

  const preferredQuotes = ['USDT', 'USD', 'USDC'];
  const symbols = Object.values(client.markets)
    .filter((m) => m.active !== false && m.swap)
    .map((m) => m.symbol)
    .sort((a, b) => {
      const aPreferred = preferredQuotes.includes(a.split('/')[1]?.split(':')[0]);
      const bPreferred = preferredQuotes.includes(b.split('/')[1]?.split(':')[0]);
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
      return a.localeCompare(b);
    });

  futuresCache.set(exchangeId, { symbols, expiresAt: Date.now() + CACHE_TTL_MS });
  return symbols;
}

module.exports = { getSymbolsForExchange, getFuturesSymbolsForExchange };
