'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');
const positionsRepository = require('../../src/database/repositories/positions-repository');
const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');

// Covers the HTTP surface of trailing stops: per-asset default (PUT .../trailing, spot and
// futures) and the per-order override (trailingPercent in the POST body) actually reaching the
// opened position. The ratchet mechanics themselves are covered in
// tests/integration/position-risk-watcher.test.js and tests/unit/position-risk-watcher.test.js.

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

test('PUT /api/assets/:symbol/trailing sets and clears the per-asset default, and rejects an out-of-range value', async (t) => {
  // One test, not three — the signupLimiter (5/60s) means a test file in this suite can't make
  // more than 5 startAuthedTestServer() calls without tripping it (see test-server.js's comment).
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  await authedFetch('/api/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' }),
  });

  const setRes = await authedFetch('/api/assets/BTC%2FUSDT/trailing?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trailingPercent: 3 }),
  });
  const setBody = await setRes.json();
  assert.equal(setRes.status, 200);
  assert.equal(setBody.data.trailing_percent, 3);

  const clearRes = await authedFetch('/api/assets/BTC%2FUSDT/trailing?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trailingPercent: null }),
  });
  const clearBody = await clearRes.json();
  assert.equal(clearRes.status, 200);
  assert.equal(clearBody.data.trailing_percent, null);

  const invalidRes = await authedFetch('/api/assets/BTC%2FUSDT/trailing?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trailingPercent: 150 }),
  });
  const invalidBody = await invalidRes.json();
  assert.equal(invalidRes.status, 400);
  assert.equal(invalidBody.errorCode, 'VALIDATION_ERROR');
});

test('PUT /api/futures/assets/:symbol/trailing sets the per-asset default on the demo futures watchlist only', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  await authedFetch('/api/futures/assets?mode=demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 3 }),
  });

  const setRes = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT/trailing?mode=demo&exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trailingPercent: 2.5 }),
  });
  const setBody = await setRes.json();
  assert.equal(setRes.status, 200);
  assert.equal(setBody.data.trailing_percent, 2.5);

  const realRes = await authedFetch('/api/futures/assets?mode=real');
  const realBody = await realRes.json();
  assert.equal(realBody.data.length, 0, 'the demo and real futures watchlists are fully independent');
});

test('POST /api/orders/demo with trailingPercent opens a position seeded to trail from entry price', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockSpotPrice(t, 60000);

  const res = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 50000, takeProfit: 90000, trailingPercent: 4 }),
  });
  assert.equal(res.status, 201);
  const order = (await res.json()).data;

  const [position] = positionsRepository.listOpenPositions('demo', order.user_id);
  assert.equal(position.trailing_percent, 4);
  assert.equal(position.trailing_high_water_mark, 60000);
});

test('POST /api/orders/demo rejects an invalid trailingPercent before ever touching the exchange', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockSpotPrice(t, 60000);

  const res = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 50000, takeProfit: 90000, trailingPercent: 0 }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.errorCode, 'VALIDATION_ERROR');
});

test('POST /api/futures/orders/demo with trailingPercent opens a position seeded to trail from entry price', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockFuturesPrice(t, 60000);

  const res = await authedFetch('/api/futures/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 3,
      stopLoss: 50000, takeProfit: 90000, trailingPercent: 4,
    }),
  });
  assert.equal(res.status, 201);
  const order = (await res.json()).data;

  const position = futuresPositionsRepository.findOpenPositionBySymbol('demo', order.user_id, 'BTC/USDT:USDT');
  assert.equal(position.trailing_percent, 4);
  assert.equal(position.trailing_high_water_mark, 60000);
});
