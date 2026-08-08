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
const usersRepository = require('../../src/database/repositories/users-repository');
const positionsRepository = require('../../src/database/repositories/positions-repository');
const ordersRepository = require('../../src/database/repositories/orders-repository');
const portfolioRepository = require('../../src/database/repositories/portfolio-repository');
const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
const futuresOrdersRepository = require('../../src/database/repositories/futures-orders-repository');
const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
const realExchangeCredentialsRepository = require('../../src/database/repositories/real-exchange-credentials-repository');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const { placeDemoOrder } = require('../../src/services/orders/demo-orders');
const { placeRealOrder } = require('../../src/services/orders/real-orders');
const { placeDemoFuturesOrder } = require('../../src/services/orders/futures-demo-orders');
const { placeRealFuturesOrder } = require('../../src/services/orders/futures-real-orders');
const positionRiskWatcher = require('../../src/services/scheduler/position-risk-watcher');

function mockSpotPrice(t, price) {
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

function mockFuturesPrice(t, price) {
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => ({
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

function fakeRealSpotClient() {
  return {
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-spot-1', status: 'closed' }),
  };
}

function fakeRealFuturesClient() {
  return {
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-fut-1', status: 'closed' }),
    fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', liquidationPrice: 30000 }],
  };
}

let testUserId;
test.beforeEach(() => {
  resetForTests();
  testUserId = usersRepository.createUser('risk-watcher-test-user', 'irrelevant-hash').id;
  portfolioRepository.ensureInitialized('demo', testUserId, 10000);
  portfolioRepository.ensureInitialized('real', testUserId, 10000);
  futuresPortfolioRepository.ensureInitialized('demo', testUserId, 10000);
  futuresPortfolioRepository.ensureInitialized('real', testUserId, 10000);
});

test('spot demo: a position is closed once price falls to its stored stop-loss', async (t) => {
  mockSpotPrice(t, 100);
  const buy = await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130 });
  assert.equal(buy.status, 'filled');
  assert.ok(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'));

  mockSpotPrice(t, 85); // through the stop-loss
  await positionRiskWatcher.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), undefined);
  const orders = ordersRepository.listOrders('demo', testUserId, {});
  assert.equal(orders.length, 2);
  assert.equal(orders[0].side, 'sell'); // most recent first
  assert.equal(orders[0].price, 85);
});

test('spot demo: a position is closed once price rises to its stored take-profit', async (t) => {
  mockSpotPrice(t, 100);
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130 });

  mockSpotPrice(t, 135); // through the take-profit
  await positionRiskWatcher.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), undefined);
});

test('spot demo: a position between its stop-loss and take-profit is left open', async (t) => {
  mockSpotPrice(t, 100);
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130 });

  mockSpotPrice(t, 110);
  await positionRiskWatcher.runCycle();

  assert.ok(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'));
});

test('spot demo: a position already protected by a pending OCO exit is left alone by the watcher (no duplicate/competing close)', async (t) => {
  mockSpotPrice(t, 100);
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130 });
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell', orderType: 'oco', stopLoss: 90, takeProfit: 130 });
  assert.equal(ordersRepository.listPendingOrders('demo').length, 2);

  mockSpotPrice(t, 135); // through the take-profit, but the OCO leg is the one that should get it, not this watcher
  await positionRiskWatcher.runCycle();

  assert.ok(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), 'still open — the watcher deferred to the existing pending OCO exit');
  assert.equal(ordersRepository.listOrders('demo', testUserId, {}).filter((o) => o.side === 'sell' && o.status === 'filled').length, 0);
});

test('spot real: a position is closed on the real exchange once price crosses its stop-loss', async (t) => {
  realExchangeCredentialsRepository.set(testUserId, 'kucoin', 'test-key', 'test-secret');
  mockSpotPrice(t, 100);
  const client = fakeRealSpotClient();
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => client);
  const buy = await placeRealOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130, unlockConfirmed: true });
  assert.equal(buy.status, 'filled');

  const createOrderCalls = [];
  t.mock.method(client, 'createOrder', async (...args) => { createOrderCalls.push(args); return { id: 'ex-spot-close', status: 'closed' }; });

  mockSpotPrice(t, 85);
  await positionRiskWatcher.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('real', testUserId, 'BTC/USDT'), undefined);
  assert.equal(createOrderCalls.length, 1);
  assert.equal(createOrderCalls[0][2], 'sell');
});

test('futures demo (long): closes when price falls through the stop-loss', async (t) => {
  mockFuturesPrice(t, 60000);
  await placeDemoFuturesOrder({ userId: testUserId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 3, stopLoss: 50000, takeProfit: 80000 });
  assert.ok(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'));

  mockFuturesPrice(t, 49000);
  await positionRiskWatcher.runCycle();

  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'), undefined);
  const orders = futuresOrdersRepository.listOrders('demo', testUserId, {});
  assert.equal(orders[0].action, 'close');
  assert.equal(orders[0].source, 'auto');
});

test('futures demo (short): stop-loss and take-profit are inverted relative to a long, and the watcher gets the direction right', async (t) => {
  mockFuturesPrice(t, 60000);
  await placeDemoFuturesOrder({ userId: testUserId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_short', leverage: 3, stopLoss: 65000, takeProfit: 50000 });
  assert.ok(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'));

  mockFuturesPrice(t, 62000); // between take-profit (50000) and stop-loss (65000) — should stay open
  await positionRiskWatcher.runCycle();
  assert.ok(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'));

  mockFuturesPrice(t, 49000); // through the short's take-profit
  await positionRiskWatcher.runCycle();
  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'), undefined);
});

test('futures real: closes on the real exchange (reduceOnly) once price crosses its take-profit', async (t) => {
  realExchangeCredentialsRepository.set(testUserId, 'kucoin', 'test-key', 'test-secret');
  mockFuturesPrice(t, 60000);
  const client = fakeRealFuturesClient();
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => client);
  const opened = await placeRealFuturesOrder({ userId: testUserId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 3, stopLoss: 50000, takeProfit: 80000, unlockConfirmed: true });
  assert.equal(opened.status, 'filled');

  const createOrderCalls = [];
  t.mock.method(client, 'createOrder', async (...args) => { createOrderCalls.push(args); return { id: 'ex-fut-close', status: 'closed' }; });

  mockFuturesPrice(t, 81000);
  await positionRiskWatcher.runCycle();

  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('real', testUserId, 'BTC/USDT:USDT'), undefined);
  assert.equal(createOrderCalls.length, 1);
  assert.equal(createOrderCalls[0][2], 'sell'); // closing a long
  assert.deepEqual(createOrderCalls[0][4], undefined);
  assert.equal(createOrderCalls[0][5].reduceOnly, true);
});

test('runCycle never throws when a mode has no open positions at all', async () => {
  await assert.doesNotReject(() => positionRiskWatcher.runCycle());
});

test('getStatus reports whether the watcher is currently running', () => {
  const status = positionRiskWatcher.getStatus();
  assert.equal(typeof status.running, 'boolean');
  assert.ok(status.intervalMs >= 5000);
});
