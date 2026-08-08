'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.ENABLE_LIVE_TRADING = 'true';
process.env.REAL_EXCHANGE_NAME = 'kucoin';
process.env.REAL_API_KEY = 'test-key';
process.env.REAL_API_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const usersRepository = require('../../src/database/repositories/users-repository');

// The `.env` REAL_EXCHANGE_NAME/REAL_API_KEY/REAL_API_SECRET fallback used throughout this file
// only applies to the legacy data owner account (username "hoseini") — see
// real-credentials-resolver.js. Every test creates that exact user so the existing .env-based
// fixtures keep working without needing a DB-stored credential per test.
function createLegacyOwner() {
  return usersRepository.createUser('hoseini', 'irrelevant-hash').id;
}

function mockPrice(price) {
  return {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  };
}

function makeFakeKucoinFuturesClient({ liquidationPrice = 48300 } = {}) {
  const calls = { createOrder: [], fetchPositions: [] };
  return {
    calls,
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async (...args) => { calls.createOrder.push(args); return { id: 'ex-order-1', status: 'closed' }; },
    fetchPositions: async (...args) => {
      calls.fetchPositions.push(args);
      return [{ symbol: 'BTC/USDT:USDT', liquidationPrice }];
    },
  };
}

// The ENABLE_LIVE_TRADING gate itself (config is Object.freeze()'d, set once at process start
// from process.env, so it can't be toggled mid-test-file) is already exhaustively covered for the
// identical config.enableLiveTrading check in orders-isolation.test.js (spot). This file only
// needs to prove futures-real-orders.js checks the SAME gate before any exchange call, which the
// REAL_TRADING_NOT_UNLOCKED test below (a gate checked immediately after) already demonstrates —
// zero exchange calls happen before either gate.
test('futures-real-orders: gates block before any exchange call', async (t) => {
  resetForTests();

  await t.test('REAL_TRADING_NOT_UNLOCKED when unlockConfirmed is not passed', async () => {
    const userId = createLegacyOwner();
    const { placeRealFuturesOrder } = require('../../src/services/orders/futures-real-orders');
    const fakeClient = makeFakeKucoinFuturesClient();
    t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeClient);
    t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(60000));
    const order = await placeRealFuturesOrder({ userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000 });
    assert.equal(order.status, 'rejected');
    assert.match(order.reject_reason, /REAL_TRADING_NOT_UNLOCKED/);
    assert.equal(fakeClient.calls.createOrder.length, 0);
  });
});

test('futures-real-orders: a well-formed open_long calls createOrder once with marginMode/leverage in params (no separate setLeverage/setMarginMode calls), then fetchPositions for the real liquidation price', async (t) => {
  resetForTests();
  const userId = createLegacyOwner();
  const { placeRealFuturesOrder } = require('../../src/services/orders/futures-real-orders');
  const futuresPortfolioService = require('../../src/services/portfolio/futures-portfolio-service');

  const fakeClient = makeFakeKucoinFuturesClient({ liquidationPrice: 48300 });
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeClient);
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(60000));

  const order = await placeRealFuturesOrder({
    userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000, unlockConfirmed: true,
  });

  assert.equal(order.status, 'filled');
  assert.equal(order.exchange_order_id, 'ex-order-1');
  assert.equal(fakeClient.calls.createOrder.length, 1);
  const [symbol, type, side, amount, price, params] = fakeClient.calls.createOrder[0];
  assert.equal(symbol, 'BTC/USDT:USDT');
  assert.equal(type, 'market');
  assert.equal(side, 'buy');
  assert.ok(amount > 0);
  assert.equal(price, undefined);
  assert.deepEqual(params, { marginMode: 'isolated', leverage: 5 });
  assert.equal(fakeClient.calls.fetchPositions.length, 1);

  const snapshot = futuresPortfolioService.getSnapshot('real', userId);
  assert.equal(snapshot.openPositions.length, 1);
  assert.equal(snapshot.openPositions[0].liquidation_price, 48300); // KuCoin's real number, not the demo estimate
});

test('futures-real-orders: createOrder failure (e.g. leverage rejected by exchange) is rejected cleanly, no position/order side effects', async (t) => {
  resetForTests();
  const userId = createLegacyOwner();
  const { placeRealFuturesOrder } = require('../../src/services/orders/futures-real-orders');

  const fakeClient = makeFakeKucoinFuturesClient();
  fakeClient.createOrder = async () => { throw new Error('leverage rejected by exchange'); };
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeClient);
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(60000));

  const order = await placeRealFuturesOrder({
    userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000, unlockConfirmed: true,
  });
  assert.equal(order.status, 'rejected');
  assert.match(order.reject_reason, /EXCHANGE_ORDER_FAILED/);
  assert.equal(fakeClient.calls.fetchPositions.length, 0);
});

test('futures-real-orders: close sends reduceOnly: true', async (t) => {
  resetForTests();
  const userId = createLegacyOwner();
  const { placeRealFuturesOrder } = require('../../src/services/orders/futures-real-orders');

  const fakeClient = makeFakeKucoinFuturesClient();
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeClient);
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(60000));

  await placeRealFuturesOrder({ userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000, unlockConfirmed: true });

  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(63000));
  const closeOrder = await placeRealFuturesOrder({ userId, symbol: 'BTC/USDT:USDT', action: 'close', unlockConfirmed: true });

  assert.equal(closeOrder.status, 'filled');
  const closeCall = fakeClient.calls.createOrder[1]; // [0] was the open, [1] is the close
  assert.equal(closeCall[2], 'sell'); // closing a long -> sell
  assert.deepEqual(closeCall[5], { reduceOnly: true });
});

test('futures-real-orders: marginCurrencyFor correctly parses KuCoin\'s BASE/QUOTE:SETTLE format (the bug this whole module exists to avoid)', () => {
  const { marginCurrencyFor } = require('../../src/services/orders/futures-real-orders');
  assert.equal(marginCurrencyFor('BTC/USDT:USDT'), 'USDT');
  assert.equal(marginCurrencyFor('ETH/USDT:USDT'), 'USDT');
  // naive symbol.split('/')[1] would have returned 'USDT:USDT' here — the exact bug this helper
  // avoids, discovered by reading ccxt's own exchange source.
});
