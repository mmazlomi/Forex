'use strict';

// OCO (One-Cancels-the-Other) exit orders — full HTTP-level coverage of the linked take-profit +
// stop-loss pair, including the sibling-cancellation behavior pending-orders-watcher.js performs
// when one leg fills.

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

async function openPosition(authedFetch, symbol = 'BTC/USDT') {
  await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, exchange: 'kucoin', side: 'buy', stopLoss: 44000, takeProfit: 60000, qty: 0.01 }),
  });
}

test('OCO places two linked pending orders sharing one oco_group_id', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));
  await openPosition(authedFetch);

  const res = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell', stopLoss: 45000, takeProfit: 55000, orderType: 'oco' }),
  });
  const body = await json(res);
  assert.equal(res.status, 201);
  assert.equal(body.data.takeProfitOrder.status, 'pending');
  assert.equal(body.data.takeProfitOrder.order_type, 'limit');
  assert.equal(body.data.takeProfitOrder.limit_price, 55000);
  assert.equal(body.data.stopLossOrder.status, 'pending');
  assert.equal(body.data.stopLossOrder.order_type, 'stop_market');
  assert.equal(body.data.stopLossOrder.trigger_price, 45000);
  assert.equal(body.data.takeProfitOrder.oco_group_id, body.data.stopLossOrder.oco_group_id);
  assert.ok(body.data.takeProfitOrder.oco_group_id);
});

test('take-profit leg filling cancels the stop-loss leg and closes the position', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  const priceMock = t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));
  await openPosition(authedFetch);

  const oco = await json(await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell', stopLoss: 45000, takeProfit: 55000, orderType: 'oco' }),
  }));

  // Price rises through the take-profit limit — should fill that leg and cancel the stop-loss leg.
  priceMock.mock.restore();
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(56000));
  await pendingOrdersWatcher.runCycle();

  const tpAfter = await json(await authedFetch(`/api/orders?mode=demo&status=filled`));
  const slAfter = await json(await authedFetch(`/api/orders?mode=demo&status=cancelled`));
  assert.ok(tpAfter.data.some((o) => o.id === oco.data.takeProfitOrder.id));
  assert.ok(slAfter.data.some((o) => o.id === oco.data.stopLossOrder.id));

  const portfolio = await json(await authedFetch('/api/portfolio?mode=demo'));
  assert.equal(portfolio.data.openPositions.length, 0);
});

test('stop-loss leg triggering cancels the take-profit leg', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  const priceMock = t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));
  await openPosition(authedFetch);

  const oco = await json(await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell', stopLoss: 45000, takeProfit: 55000, orderType: 'oco' }),
  }));

  priceMock.mock.restore();
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(44000));
  await pendingOrdersWatcher.runCycle();

  const filled = await json(await authedFetch('/api/orders?mode=demo&status=filled'));
  const cancelled = await json(await authedFetch('/api/orders?mode=demo&status=cancelled'));
  assert.ok(filled.data.some((o) => o.id === oco.data.stopLossOrder.id));
  assert.ok(cancelled.data.some((o) => o.id === oco.data.takeProfitOrder.id));
});

test('OCO is rejected with NO_OPEN_POSITION_FOR_OCO when there is nothing to protect', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', mockPrice(50000));

  const res = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell', stopLoss: 45000, takeProfit: 55000, orderType: 'oco' }),
  });
  const body = await json(res);
  assert.equal(body.errorCode, 'NO_OPEN_POSITION_FOR_OCO');
});
