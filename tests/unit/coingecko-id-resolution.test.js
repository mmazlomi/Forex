'use strict';

// Regression test for a real bug: the app previously guessed a CoinGecko "coin id" by
// lowercasing the ticker (BTC -> "btc"), but CoinGecko ids are slugs ("bitcoin"), not
// tickers — every crypto fundamental field silently showed "unavailable" as a result.

process.env.DATABASE_PATH = ':memory:';
process.env.COINGECKO_MIN_INTERVAL_MS = '0'; // no need to throttle real network calls in tests

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const { resolveCoinId } = require('../../src/services/fundamental-analysis/providers/coingecko');
const fundamentalAnalysis = require('../../src/services/fundamental-analysis');

function jsonResponse(body, ok = true, status = 200, headers = {}) {
  return { ok, status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body };
}

test.beforeEach(() => {
  resetForTests();
});

test('resolveCoinId picks the exact-ticker match with the best (lowest) market cap rank', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    coins: [
      { id: 'bitget-wrapped-btc', symbol: 'BGBTC', market_cap_rank: 427 },
      { id: 'bitcoin', symbol: 'BTC', market_cap_rank: 1 },
      { id: 'ebtc-2', symbol: 'EBTC', market_cap_rank: 563 },
    ],
  }));

  const id = await resolveCoinId('BTC');
  assert.equal(id, 'bitcoin');
});

test('resolveCoinId returns null (never fabricates) when there is no exact ticker match', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ coins: [{ id: 'something-else', symbol: 'XYZ' }] }));
  const id = await resolveCoinId('NOTAREALTICKER');
  assert.equal(id, null);
});

test('resolveCoinId caches its result — a second call does not hit the network again', async (t) => {
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount += 1;
    return jsonResponse({ coins: [{ id: 'ethereum', symbol: 'ETH', market_cap_rank: 2 }] });
  });

  await resolveCoinId('ETH');
  await resolveCoinId('ETH');
  assert.equal(callCount, 1);
});

test('getFundamentals resolves the coin id itself when the caller supplies none (old bug: symbol.toLowerCase() was passed straight to CoinGecko and 404s)', async (t) => {
  let requestedUrl = null;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requestedUrl = String(url);
    if (requestedUrl.includes('/search')) {
      return jsonResponse({ coins: [{ id: 'bitcoin', symbol: 'BTC', market_cap_rank: 1 }] });
    }
    return jsonResponse({ market_data: { market_cap: { usd: 123 }, price_change_percentage_24h: 1 } });
  });

  const result = await fundamentalAnalysis.getFundamentals({ symbol: 'BTC/USDT', assetType: 'crypto' });
  assert.equal(result.fields.marketCap.value, 123);
  assert.ok(requestedUrl.includes('/coins/bitcoin'), `expected the final request to hit /coins/bitcoin, got: ${requestedUrl}`);
});

test('getFundamentals trusts an explicitly-supplied providerId without resolving', async (t) => {
  let searchCalled = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/search')) searchCalled = true;
    return jsonResponse({ market_data: { market_cap: { usd: 999 }, price_change_percentage_24h: 0 } });
  });

  const result = await fundamentalAnalysis.getFundamentals({ symbol: 'BTC/USDT', assetType: 'crypto', providerId: 'bitcoin' });
  assert.equal(result.fields.marketCap.value, 999);
  assert.equal(searchCalled, false);
});

test('getFundamentals returns "unavailable" (not a crash, not fabricated) when the ticker cannot be resolved', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ coins: [] }));
  const result = await fundamentalAnalysis.getFundamentals({ symbol: 'NOTAREAL/USDT', assetType: 'crypto' });
  assert.equal(result.fields.marketCap.value, 'unavailable');
  assert.match(result.fields.marketCap.unavailableReason, /could_not_resolve_coingecko_id/);
});

// Regression test for a real incident: NOT/USDT (and other symbols) came back NO_DATA because a
// full watchlist scan fired one CoinGecko request per symbol back-to-back and got 429'd —
// resolveCoinId/fetchCryptoFundamentals previously never retried a 429 at all.
test('resolveCoinId retries a 429, honoring its Retry-After header, and succeeds on the next attempt', async (t) => {
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount += 1;
    if (callCount === 1) return jsonResponse({}, false, 429, { 'retry-after': '0' });
    return jsonResponse({ coins: [{ id: 'notcoin', symbol: 'NOT', market_cap_rank: 508 }] });
  });

  const id = await resolveCoinId('NOT');
  assert.equal(id, 'notcoin');
  assert.equal(callCount, 2);
});

test('resolveCoinId does not retry a non-429 4xx (retrying a bad request/not-found can never succeed)', async (t) => {
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount += 1;
    return jsonResponse({}, false, 404);
  });

  const id = await resolveCoinId('WHATEVER');
  assert.equal(id, null);
  assert.equal(callCount, 1);
});

test('resolveCoinId gives up and returns null after exhausting retries on repeated 429s', async (t) => {
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount += 1;
    return jsonResponse({}, false, 429, { 'retry-after': '0' });
  });

  const id = await resolveCoinId('WHATEVER');
  assert.equal(id, null);
  assert.equal(callCount, 4); // 1 initial attempt + config.maxApiRetries (default 3) retries
});
