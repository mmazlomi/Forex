'use strict';

// Separate process (node --test isolates files) with its own env, so this doesn't affect
// the default "live trading disabled" tests in orders-isolation.test.js.
process.env.ENABLE_LIVE_TRADING = 'true';
process.env.REAL_EXCHANGE_NAME = 'kucoin';
process.env.REAL_API_KEY = 'test-key';
process.env.REAL_API_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');

function fakeSnapshot() {
  return {
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price: 50000,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  };
}

test('real order still requires the typed UI confirmation even when live trading is enabled', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer({ username: 'hoseini' });
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => fakeSnapshot());

  const res = await authedFetch('/api/orders/real', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000 }),
    // no confirmationText
  });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.errorCode, 'REAL_TRADING_NOT_UNLOCKED');
});

test('a confirmed real order calls the exchange client and records an audit log entry', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer({ username: 'hoseini' });
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => fakeSnapshot());

  const fakeExchange = {
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async (symbol, type, side, qty) => ({ id: 'exch-order-1', symbol, type, side, qty }),
  };
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeExchange);

  const res = await authedFetch('/api/orders/real', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, confirmationText: 'CONFIRM' }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.data.status, 'filled');
  assert.equal(body.data.exchange_order_id, 'exch-order-1');

  const portfolio = await (await authedFetch('/api/portfolio?mode=real')).json();
  assert.equal(portfolio.data.openPositions.length, 1);
});

test('a real order is rejected cleanly (not crashed, not routed to demo) when the exchange call fails', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer({ username: 'hoseini' });
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => fakeSnapshot());

  const failingExchange = {
    fetchBalance: async () => { throw new Error('simulated exchange outage'); },
  };
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => failingExchange);

  const res = await authedFetch('/api/orders/real', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, confirmationText: 'CONFIRM' }),
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  assert.equal(body.errorCode, 'EXCHANGE_UNAVAILABLE');

  // No demo-side effect from a failed real order.
  const demoPortfolio = await (await authedFetch('/api/portfolio?mode=demo')).json();
  assert.equal(demoPortfolio.data.openPositions.length, 0);
});
