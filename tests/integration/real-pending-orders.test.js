'use strict';

process.env.ENABLE_LIVE_TRADING = 'true';
process.env.REAL_EXCHANGE_NAME = 'binance';
process.env.REAL_API_KEY = 'test-key';
process.env.REAL_API_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const pendingOrdersWatcher = require('../../src/services/scheduler/pending-orders-watcher');

function fakeSnapshot() {
  return {
    symbol: 'BTC/USDT', exchange: 'binance', status: 'ok', price: 50000,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  };
}

async function json(res) {
  return res.json();
}

test('a real stop_market order is rejected with ORDER_TYPE_UNSUPPORTED_ON_EXCHANGE before any exchange call, mirroring binance\'s real createStopOrder gap', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer({ username: 'hoseini' });
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => fakeSnapshot());

  const createOrderCalls = [];
  const fakeExchange = {
    id: 'binance',
    has: { createOrder: true, createStopOrder: false, createStopLimitOrder: true },
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async (...args) => { createOrderCalls.push(args); return { id: 'ex-1', status: 'open' }; },
  };
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeExchange);

  const res = await authedFetch('/api/orders/real', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT', exchange: 'binance', side: 'buy', stopLoss: 44000, takeProfit: 60000,
      orderType: 'stop_market', triggerPrice: 48000, confirmationText: 'CONFIRM',
    }),
  });
  const body = await json(res);
  assert.equal(body.errorCode, 'ORDER_TYPE_UNSUPPORTED_ON_EXCHANGE');
  assert.equal(createOrderCalls.length, 0);
});

test('a real limit order is placed as pending with the exchange order id, then filled once the watcher confirms it via fetchOrder', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer({ username: 'hoseini' });
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => fakeSnapshot());

  const orderState = { status: 'open', average: undefined };
  const fakeExchange = {
    id: 'binance',
    has: { createOrder: true, createStopOrder: true, createStopLimitOrder: true },
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-limit-1', status: 'open' }),
    fetchOrder: async (id) => ({ id, ...orderState }),
  };
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeExchange);

  const placed = await json(await authedFetch('/api/orders/real', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT', exchange: 'binance', side: 'buy', stopLoss: 44000, takeProfit: 60000,
      qty: 0.01, orderType: 'limit', limitPrice: 48000, confirmationText: 'CONFIRM',
    }),
  }));
  assert.equal(placed.data.status, 'pending');
  assert.equal(placed.data.exchange_order_id, 'ex-limit-1');

  await pendingOrdersWatcher.runCycle();
  const stillPending = await json(await authedFetch('/api/orders?mode=real&status=pending'));
  assert.equal(stillPending.data.length, 1);

  orderState.status = 'closed';
  orderState.average = 48000;
  await pendingOrdersWatcher.runCycle();

  const filled = await json(await authedFetch('/api/orders?mode=real&status=filled'));
  assert.equal(filled.data.length, 1);
  assert.equal(filled.data[0].price, 48000);

  const portfolio = await json(await authedFetch('/api/portfolio?mode=real'));
  assert.equal(portfolio.data.openPositions.length, 1);
});

test('cancelling a real pending order calls the exchange\'s cancelOrder', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer({ username: 'hoseini' });
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => fakeSnapshot());

  const cancelCalls = [];
  const fakeExchange = {
    id: 'binance',
    has: { createOrder: true },
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-cancel-1', status: 'open' }),
    cancelOrder: async (id, symbol) => { cancelCalls.push({ id, symbol }); return { id, status: 'canceled' }; },
  };
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeExchange);

  const placed = await json(await authedFetch('/api/orders/real', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT', exchange: 'binance', side: 'buy', stopLoss: 44000, takeProfit: 60000,
      qty: 0.01, orderType: 'limit', limitPrice: 48000, confirmationText: 'CONFIRM',
    }),
  }));

  const cancelRes = await authedFetch(`/api/orders/real/${placed.data.id}/cancel`, { method: 'POST' });
  const cancelled = await json(cancelRes);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.deepEqual(cancelCalls, [{ id: 'ex-cancel-1', symbol: 'BTC/USDT' }]);
});
