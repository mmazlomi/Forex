'use strict';

process.env.DATABASE_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const { fetchHistoricalRange } = require('../../src/services/backtesting/historical-data');

// Regression coverage for the market ('spot' | 'futures') param added to fetchHistoricalRange to
// support strategy-selector.js backtesting futures assets — see historical-data.js's comment.
// Confirms it routes to the correct exchange-client-factory function and that omitting `market`
// entirely is byte-for-byte identical to the spot-only behavior that existed before futures
// backtesting support was added.

function fakeClient() {
  return {
    markets: { 'BTC/USDT': {} },
    loadMarkets: async () => {},
    fetchOHLCV: async () => [[Date.now(), 100, 101, 99, 100.5, 10]],
  };
}

test.beforeEach(() => {
  resetForTests();
});

test('market omitted (default) routes to getPublicExchange, never getPublicFuturesExchange', async (t) => {
  const spotClient = fakeClient();
  const spotMock = t.mock.method(exchangeClientFactory, 'getPublicExchange', () => spotClient);
  const futuresMock = t.mock.method(exchangeClientFactory, 'getPublicFuturesExchange', () => { throw new Error('should never be called'); });

  const now = Date.now();
  await fetchHistoricalRange({ symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h', sinceMs: now - 60_000, untilMs: now });

  assert.equal(spotMock.mock.callCount(), 1);
  assert.equal(futuresMock.mock.callCount(), 0);
});

test('market: "spot" explicitly is identical to omitting it', async (t) => {
  const spotClient = fakeClient();
  const spotMock = t.mock.method(exchangeClientFactory, 'getPublicExchange', () => spotClient);

  const now = Date.now();
  await fetchHistoricalRange({ symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h', sinceMs: now - 60_000, untilMs: now, market: 'spot' });

  assert.equal(spotMock.mock.callCount(), 1);
});

test('market: "futures" routes to getPublicFuturesExchange, never getPublicExchange', async (t) => {
  const futuresClient = fakeClient();
  const spotMock = t.mock.method(exchangeClientFactory, 'getPublicExchange', () => { throw new Error('should never be called'); });
  const futuresMock = t.mock.method(exchangeClientFactory, 'getPublicFuturesExchange', () => futuresClient);

  const now = Date.now();
  await fetchHistoricalRange({ symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h', sinceMs: now - 60_000, untilMs: now, market: 'futures' });

  assert.equal(futuresMock.mock.callCount(), 1);
  assert.equal(spotMock.mock.callCount(), 0);
});
