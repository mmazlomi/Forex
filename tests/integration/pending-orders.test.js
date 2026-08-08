'use strict';

// Limit/Stop-Market/Stop-Limit order types (Phase 1 order types) — full HTTP-level coverage of
// the pending-order lifecycle for Demo. Real-mode capability gating and fetchOrder-based sync are
// covered in real-orders.js's own concerns; this file focuses on the demo simulation path plus
// the parts of the HTTP surface (controller field passthrough, cancel endpoint) shared by both.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');
const pendingOrdersWatcher = require('../../src/services/scheduler/pending-orders-watcher');

async function json(res) {
  return res.json();
}

function mockPrice(price) {
  return async ({ symbol, exchange }) => ({
    symbol, exchange, status: 'ok', price,
    changePercent24h: 0, volume24h: 100, marketOpen: true, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  });
}

test('a Limit buy order is stored pending (not filled) until the watcher confirms price has crossed it', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  const priceMock = t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));

  const res = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 44000, takeProfit: 60000,
      qty: 0.01, orderType: 'limit', limitPrice: 48000,
    }),
  });
  const body = await json(res);
  assert.equal(res.status, 201);
  assert.equal(body.data.status, 'pending');
  assert.equal(body.data.order_type, 'limit');
  assert.equal(body.data.limit_price, 48000);

  // Zero open positions — a pending order must not open a position prematurely.
  const portfolioRes = await json(await authedFetch('/api/portfolio?mode=demo'));
  assert.equal(portfolioRes.data.openPositions.length, 0);

  // A cycle at the current (unchanged) price shouldn't fill it.
  await pendingOrdersWatcher.runCycle();
  const stillPending = await json(await authedFetch('/api/orders?mode=demo&status=pending'));
  assert.equal(stillPending.data.length, 1);

  // Price drops through the limit -> the next cycle fills it and opens exactly one position.
  priceMock.mock.restore();
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(47000));
  await pendingOrdersWatcher.runCycle();

  const afterFill = await json(await authedFetch('/api/orders?mode=demo&status=pending'));
  assert.equal(afterFill.data.length, 0);
  const filledOrders = await json(await authedFetch('/api/orders?mode=demo&status=filled'));
  assert.equal(filledOrders.data.length, 1);
  assert.equal(filledOrders.data[0].price >= 47000 && filledOrders.data[0].price <= 48000, true);

  const portfolioAfter = await json(await authedFetch('/api/portfolio?mode=demo'));
  assert.equal(portfolioAfter.data.openPositions.length, 1);
});

test('a Stop-Market buy order (breakout entry) triggers once price rises through the trigger', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  const priceMock = t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));

  const res = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 49000, takeProfit: 60000,
      qty: 0.01, orderType: 'stop_market', triggerPrice: 52000,
    }),
  });
  const body = await json(res);
  assert.equal(body.data.status, 'pending');

  await pendingOrdersWatcher.runCycle();
  assert.equal((await json(await authedFetch('/api/orders?mode=demo&status=pending'))).data.length, 1);

  priceMock.mock.restore();
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(52500));
  await pendingOrdersWatcher.runCycle();
  const filled = await json(await authedFetch('/api/orders?mode=demo&status=filled'));
  assert.equal(filled.data.length, 1);
  assert.equal(filled.data[0].price, 52500); // stop-market fills at the current price once triggered, not the trigger price
});

test('MISSING_LIMIT_PRICE / MISSING_TRIGGER_PRICE are rejected before ever creating a pending order', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));

  const missingLimit = await json(await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 44000, takeProfit: 60000, orderType: 'limit' }),
  }));
  assert.equal(missingLimit.errorCode, 'MISSING_LIMIT_PRICE');

  const missingTrigger = await json(await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'ETH/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 44000, takeProfit: 60000, orderType: 'stop_market' }),
  }));
  assert.equal(missingTrigger.errorCode, 'MISSING_TRIGGER_PRICE');
});

test('a pending order can be cancelled; a filled order cannot', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));

  const placed = await json(await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 44000, takeProfit: 60000, qty: 0.01, orderType: 'limit', limitPrice: 48000 }),
  }));

  const cancelRes = await authedFetch(`/api/orders/demo/${placed.data.id}/cancel`, { method: 'POST' });
  const cancelled = await json(cancelRes);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');

  assert.equal((await json(await authedFetch('/api/orders?mode=demo&status=pending'))).data.length, 0);

  // Filling a market order, then trying to cancel it, should fail — it's not pending.
  const filled = await json(await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'ETH/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 44000, takeProfit: 60000, qty: 0.01 }),
  }));
  assert.equal(filled.data.status, 'filled');
  const notCancellable = await authedFetch(`/api/orders/demo/${filled.data.id}/cancel`, { method: 'POST' });
  const notCancellableBody = await json(notCancellable);
  assert.equal(notCancellable.status, 409);
  assert.equal(notCancellableBody.errorCode, 'ORDER_NOT_CANCELLABLE');

  const notFound = await authedFetch('/api/orders/demo/does-not-exist/cancel', { method: 'POST' });
  assert.equal(notFound.status, 404);
});

test('a standalone (non-OCO) pending sell order works as a single take-profit-only exit', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));

  await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 44000, takeProfit: 60000, qty: 0.01 }),
  });

  const sell = await json(await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell', orderType: 'limit', limitPrice: 55000 }),
  }));
  assert.equal(sell.data.status, 'pending');
  assert.equal(sell.data.oco_group_id, null);
});
