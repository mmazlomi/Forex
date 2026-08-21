'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const { runSpotWalkForward } = require('../../src/services/backtesting/spot-walk-forward');

test.beforeEach(() => {
  resetForTests();
});

test('runSpotWalkForward: rejects a windowCount below 2', async () => {
  await assert.rejects(
    runSpotWalkForward({ symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2020-01-01', endUtc: '2020-02-01', windowCount: 1 }),
    /windowCount must be an integer >= 2/,
  );
});

test('runSpotWalkForward: rejects an invalid date range', async () => {
  await assert.rejects(
    runSpotWalkForward({ symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2020-02-01', endUtc: '2020-01-01' }),
    /endUtc must be after startUtc/,
  );
});

test('runSpotWalkForward: splits the range into the requested number of windows and aggregates consistently (mocked exchange, no real network)', async (t) => {
  const now = Date.now();
  const HOUR = 3600_000;
  const flatCandles = Array.from({ length: 300 }, (_, i) => [now + i * HOUR, 100, 100.5, 99.5, 100, 10]);

  const client = {
    markets: { 'BTC/USDT': {} },
    loadMarkets: async () => {},
    fetchOHLCV: async (symbol, timeframe, since) => flatCandles.filter((c) => c[0] >= since),
  };
  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => client);

  const result = await runSpotWalkForward({
    symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h',
    startUtc: new Date(now).toISOString(), endUtc: new Date(now + 200 * HOUR).toISOString(),
    windowCount: 3,
  });

  assert.equal(result.windowCount, 3);
  assert.equal(result.windows.length, 3);
  // Flat, no-signal candles never produce a trade in any window.
  assert.ok(result.windows.every((w) => w.metrics.tradeCount === 0));
  assert.equal(result.aggregate.profitableWindowCount, 0);
  assert.ok(result.disclaimer.includes('SAME fixed parameters'));
});
