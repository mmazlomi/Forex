'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');
const signalsRepository = require('../../src/database/repositories/signals-repository');

// Order History (GET /api/orders) shows individual orders — unlike Trade History, which pairs
// entry+exit into closed positions and was already enriched with strategy/timeframe (see
// tests/integration/position-strategy-tracking.test.js). This covers the same resolve-from-
// signal-id enrichment (src/services/signals/resolve-position-strategy.js), now also applied to
// orders in src/controllers/orders-controller.js.

function mockSpotPrice(t, price) {
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price, changePercent24h: 1, volume24h: 100,
    marketOpen: true, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

function mockFuturesPrice(t, price) {
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => ({
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

function insertSignal({ id, symbol, timeframe = '1h', strategyId = 'momentum', combinedStrategyIds, combinedVotes }) {
  signalsRepository.insertSignal({
    id, symbol, exchange: 'kucoin', timeframe, tsUtc: new Date().toISOString(),
    price: 60000, technicalScore: 0.5, fundamentalScore: 0.5, finalScore: 0.5,
    status: 'BUY', confidence: 0.8, reasonsJson: '[]', technicalSummaryJson: '{}', fundamentalSummaryJson: '{}',
    entry: 60000, stopLoss: 50000, takeProfit: 80000, riskRewardRatio: 2, dataQuality: 'good', warningsJson: '[]',
    strategyVersion: '1.0.0', strategyId, sourceMode: 'demo',
    combinedStrategyIds: combinedStrategyIds ? JSON.stringify(combinedStrategyIds) : null,
    combinedVotes: combinedVotes ? JSON.stringify(combinedVotes) : null,
  });
}

test('GET /api/orders resolves strategy and timeframe from the signal that placed the order', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockSpotPrice(t, 60000);

  insertSignal({ id: 'order-history-sig-1', symbol: 'BTC/USDT', timeframe: '4h', strategyId: 'momentum' });

  const orderRes = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 50000, takeProfit: 80000, signalId: 'order-history-sig-1' }),
  });
  assert.equal(orderRes.status, 201);

  const listRes = await authedFetch('/api/orders?mode=demo');
  const body = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(body.data.length, 1);
  const [order] = body.data;
  assert.equal(order.timeframe, '4h');
  assert.deepEqual(order.strategies, [{ id: 'momentum', name: 'Momentum' }]);
});

test('GET /api/orders resolves every contributing strategy for a combined-signal order', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockSpotPrice(t, 60000);

  insertSignal({
    id: 'order-history-sig-combined', symbol: 'BTC/USDT', timeframe: '1h',
    strategyId: 'trend-following+momentum',
    combinedStrategyIds: ['trend-following', 'momentum'],
    combinedVotes: { 'trend-following': 'BUY', momentum: 'BUY' },
  });

  const orderRes = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 50000, takeProfit: 80000, signalId: 'order-history-sig-combined' }),
  });
  assert.equal(orderRes.status, 201);

  const listRes = await authedFetch('/api/orders?mode=demo');
  const body = await listRes.json();
  const [order] = body.data;
  assert.equal(order.timeframe, '1h');
  assert.deepEqual(order.strategies, [
    { id: 'trend-following', name: 'Trend Following' },
    { id: 'momentum', name: 'Momentum' },
  ]);
});

test('GET /api/orders leaves strategy/timeframe empty for a manual order placed with no signalId', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockSpotPrice(t, 60000);

  const orderRes = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 50000, takeProfit: 80000 }),
  });
  assert.equal(orderRes.status, 201);

  const listRes = await authedFetch('/api/orders?mode=demo');
  const body = await listRes.json();
  const [order] = body.data;
  assert.equal(order.timeframe, null);
  assert.deepEqual(order.strategies, []);
});

test('GET /api/futures/orders resolves strategy and timeframe from the signal that placed the order', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockFuturesPrice(t, 60000);

  insertSignal({ id: 'futures-order-history-sig-1', symbol: 'BTC/USDT:USDT', timeframe: '4h', strategyId: 'momentum' });

  const orderRes = await authedFetch('/api/futures/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 5,
      stopLoss: 50000, takeProfit: 80000, signalId: 'futures-order-history-sig-1',
    }),
  });
  assert.equal(orderRes.status, 201);

  const listRes = await authedFetch('/api/futures/orders?mode=demo');
  const body = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(body.data.length, 1);
  const [order] = body.data;
  assert.equal(order.timeframe, '4h');
  assert.deepEqual(order.strategies, [{ id: 'momentum', name: 'Momentum' }]);
});

test('GET /api/futures/orders leaves strategy/timeframe empty for a manual order placed with no signalId', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockFuturesPrice(t, 60000);

  const orderRes = await authedFetch('/api/futures/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000 }),
  });
  assert.equal(orderRes.status, 201);

  const listRes = await authedFetch('/api/futures/orders?mode=demo');
  const body = await listRes.json();
  const [order] = body.data;
  assert.equal(order.timeframe, null);
  assert.deepEqual(order.strategies, []);
});
