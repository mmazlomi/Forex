'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');

async function json(res) {
  return res.json();
}

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

test('GET /api/portfolio/history returns a closed spot trade with realized P&L, strategy, and timeframe', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockSpotPrice(t, 60000);

  // Open a BUY.
  const openRes = await authedFetch('/api/orders/demo?mode=demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 55000, takeProfit: 70000 }),
  });
  assert.equal(openRes.status, 201);

  // Empty history before any close.
  const beforeRes = await authedFetch('/api/portfolio/history?mode=demo');
  const before = await json(beforeRes);
  assert.equal(before.data.length, 0);

  // Close it at a higher price (profit).
  mockSpotPrice(t, 63000);
  const closeRes = await authedFetch('/api/orders/demo?mode=demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell' }),
  });
  assert.equal(closeRes.status, 201);

  const res = await authedFetch('/api/portfolio/history?mode=demo');
  const body = await json(res);
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 1);
  const trade = body.data[0];
  assert.equal(trade.symbol, 'BTC/USDT');
  assert.equal(trade.side, 'buy');
  assert.ok(trade.realized_pnl > 0);
  assert.ok(trade.entry_price);
  assert.ok(trade.exit_price);
  assert.ok(trade.opened_at_utc);
  assert.ok(trade.closed_at_utc);
  assert.deepEqual(trade.strategies, []); // no signal_id -> no strategy attribution, and that's honestly represented
});

test('GET /api/futures/history returns a closed futures trade with realized P&L', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockFuturesPrice(t, 60000);

  const openRes = await authedFetch('/api/futures/orders/demo?mode=demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 5, stopLoss: 55000, takeProfit: 70000 }),
  });
  assert.equal(openRes.status, 201);

  mockFuturesPrice(t, 63000);
  const closeRes = await authedFetch('/api/futures/orders/demo?mode=demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'close' }),
  });
  assert.equal(closeRes.status, 201);

  const res = await authedFetch('/api/futures/history?mode=demo');
  const body = await json(res);
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 1);
  const trade = body.data[0];
  assert.equal(trade.symbol, 'BTC/USDT:USDT');
  assert.equal(trade.side, 'long');
  assert.ok(trade.realized_pnl > 0);
  assert.equal(trade.leverage, 5);
});

test('GET /api/portfolio/history requires a valid mode query param', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  const res = await authedFetch('/api/portfolio/history');
  assert.equal(res.status, 400);
});
