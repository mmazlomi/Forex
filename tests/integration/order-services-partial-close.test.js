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
const realExchangeCredentialsRepository = require('../../src/database/repositories/real-exchange-credentials-repository');
const portfolioRepository = require('../../src/database/repositories/portfolio-repository');
const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
const positionsRepository = require('../../src/database/repositories/positions-repository');
const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
const portfolioService = require('../../src/services/portfolio/portfolio-service');
const futuresPortfolioService = require('../../src/services/portfolio/futures-portfolio-service');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const { placeDemoPartialClose } = require('../../src/services/orders/demo-orders');
const { placeRealPartialClose } = require('../../src/services/orders/real-orders');
const { placeDemoFuturesPartialClose } = require('../../src/services/orders/futures-demo-orders');
const { placeRealFuturesPartialClose } = require('../../src/services/orders/futures-real-orders');

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
  const calls = { createOrder: [] };
  return { calls, createOrder: async (...args) => { calls.createOrder.push(args); return { id: 'ex-spot-partial-1', status: 'closed' }; } };
}

function fakeRealFuturesClient() {
  const calls = { createOrder: [] };
  return { calls, createOrder: async (...args) => { calls.createOrder.push(args); return { id: 'ex-fut-partial-1', status: 'closed' }; } };
}

function openAdaptiveSpotPosition(userId, overrides = {}) {
  return portfolioService.openPosition('demo', userId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100, stopLoss: 90, takeProfit: 130,
    adaptiveTp: { tp1Price: 110, tp1QtyPercent: 25 },
    ...overrides,
  });
}

function openAdaptiveRealSpotPosition(userId, overrides = {}) {
  return portfolioService.openPosition('real', userId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100, stopLoss: 90, takeProfit: 130,
    adaptiveTp: { tp1Price: 110, tp1QtyPercent: 25 },
    ...overrides,
  });
}

function openAdaptiveFuturesPosition(mode, userId, overrides = {}) {
  return futuresPortfolioService.openPosition(mode, userId, {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', side: 'long', leverage: 3, qty: 10, entryPrice: 100, stopLoss: 90, takeProfit: 130,
    adaptiveTp: { tp1Price: 110, tp1QtyPercent: 25 },
    ...overrides,
  });
}

let userId;
test.beforeEach(() => {
  resetForTests();
  userId = usersRepository.createUser('partial-close-order-user', 'irrelevant-hash').id;
  portfolioRepository.ensureInitialized('demo', userId, 10000);
  portfolioRepository.ensureInitialized('real', userId, 10000);
  futuresPortfolioRepository.ensureInitialized('demo', userId, 10000);
  futuresPortfolioRepository.ensureInitialized('real', userId, 10000);
  // resolveRealCredentials' REAL_EXCHANGE_NAME/.env fallback only applies to the legacy "hoseini"
  // account (see futures-real-orders.test.js's identical comment) — every other user needs a
  // DB-stored credential to pass the MISSING_REAL_CREDENTIALS gate.
  realExchangeCredentialsRepository.set(userId, 'kucoin', 'test-key', 'test-secret');
});

// --- Demo spot ---

test('placeDemoPartialClose: fires TP1, decrements qty, records a filled sell order for closeQty only', async (t) => {
  const position = openAdaptiveSpotPosition(userId);
  mockSpotPrice(t, 110);

  const order = await placeDemoPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 2.5 });

  assert.equal(order.status, 'filled');
  assert.equal(order.qty, 2.5);
  assert.equal(order.realized_pnl, 25); // (110-100)*2.5

  const updated = positionsRepository.getPosition('demo', userId, position.id);
  assert.equal(updated.qty, 7.5);
  assert.equal(updated.status, 'open');
  assert.ok(updated.tp1_filled_at_utc);
});

test('placeDemoPartialClose: a dust-sized remainder falls through to a full close instead', async (t) => {
  const position = openAdaptiveSpotPosition(userId);
  mockSpotPrice(t, 110);

  // Requesting to close all but 0.05 (0.5% of initial_qty=10) — below the 1% dust threshold.
  const order = await placeDemoPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 9.95 });

  assert.equal(order.status, 'filled');
  assert.equal(order.qty, 10, 'full remaining qty was closed, not just the requested 9.95');
  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', userId, 'BTC/USDT'), undefined);
});

test('placeDemoPartialClose: rejects when the position is not adaptive-TP enabled', async (t) => {
  portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });
  mockSpotPrice(t, 110);

  const order = await placeDemoPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 2.5 });
  assert.equal(order.status, 'rejected');
  assert.match(order.reject_reason, /ADAPTIVE_TP_NOT_ENABLED/);
});

test('placeDemoPartialClose: rejects a duplicate fire of an already-filled tier', async (t) => {
  openAdaptiveSpotPosition(userId);
  mockSpotPrice(t, 110);
  await placeDemoPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 2.5 });

  const order = await placeDemoPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 1 });
  assert.equal(order.status, 'rejected');
  assert.match(order.reject_reason, /TP_TIER_ALREADY_FILLED/);
});

test('placeDemoPartialClose: rejects when there is no open position for the symbol', async (t) => {
  mockSpotPrice(t, 110);
  const order = await placeDemoPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 2.5 });
  assert.equal(order.status, 'rejected');
  assert.match(order.reject_reason, /NO_OPEN_POSITION_TO_CLOSE/);
});

// --- Real spot ---

test('placeRealPartialClose: gates block before any exchange call when not unlocked', async (t) => {
  openAdaptiveRealSpotPosition(userId);
  const fakeClient = fakeRealSpotClient();
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeClient);
  mockSpotPrice(t, 110);

  const order = await placeRealPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 2.5 });
  assert.equal(order.status, 'rejected');
  assert.match(order.reject_reason, /REAL_TRADING_NOT_UNLOCKED/);
  assert.equal(fakeClient.calls.createOrder.length, 0);
});

test('placeRealPartialClose: places a real market sell for exactly closeQty, not the full position', async (t) => {
  const position = openAdaptiveRealSpotPosition(userId);
  const fakeClient = fakeRealSpotClient();
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeClient);
  mockSpotPrice(t, 110);

  const order = await placeRealPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 2.5, unlockConfirmed: true });

  assert.equal(order.status, 'filled');
  assert.equal(fakeClient.calls.createOrder.length, 1);
  const [symbol, type, side, amount] = fakeClient.calls.createOrder[0];
  assert.equal(symbol, 'BTC/USDT');
  assert.equal(type, 'market');
  assert.equal(side, 'sell');
  assert.equal(amount, 2.5);

  const updated = positionsRepository.getPosition('real', userId, position.id);
  assert.equal(updated.qty, 7.5);
});

test('placeRealPartialClose: a dust-sized remainder falls through to closeRealPosition (full qty)', async (t) => {
  openAdaptiveRealSpotPosition(userId);
  const fakeClient = fakeRealSpotClient();
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeClient);
  mockSpotPrice(t, 110);

  const order = await placeRealPartialClose({ userId, symbol: 'BTC/USDT', exchange: 'kucoin', level: 1, closeQty: 9.95, unlockConfirmed: true });
  assert.equal(order.status, 'filled');
  assert.equal(fakeClient.calls.createOrder[0][3], 10, 'the exchange order was for the full remaining qty');
  assert.equal(positionsRepository.findOpenPositionBySymbol('real', userId, 'BTC/USDT'), undefined);
});

// --- Demo futures ---

test('placeDemoFuturesPartialClose: fires TP1, decrements qty, records a filled close order for closeQty only', async (t) => {
  const position = openAdaptiveFuturesPosition('demo', userId);
  mockFuturesPrice(t, 110);

  const order = await placeDemoFuturesPartialClose({ userId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', level: 1, closeQty: 2.5 });

  assert.equal(order.status, 'filled');
  assert.equal(order.qty, 2.5);
  assert.equal(order.realized_pnl, 25);

  const updated = futuresPositionsRepository.getPosition('demo', userId, position.id);
  assert.equal(updated.qty, 7.5);
  assert.equal(updated.status, 'open');
});

test('placeDemoFuturesPartialClose: dust remainder falls through to a full close', async (t) => {
  openAdaptiveFuturesPosition('demo', userId);
  mockFuturesPrice(t, 110);

  const order = await placeDemoFuturesPartialClose({ userId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', level: 1, closeQty: 9.95 });
  assert.equal(order.qty, 10);
  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', userId, 'BTC/USDT:USDT'), undefined);
});

// --- Real futures ---

test('placeRealFuturesPartialClose: sends reduceOnly:true for exactly closeQty', async (t) => {
  const position = openAdaptiveFuturesPosition('real', userId);
  const fakeClient = fakeRealFuturesClient();
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeClient);
  mockFuturesPrice(t, 110);

  const order = await placeRealFuturesPartialClose({ userId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', level: 1, closeQty: 2.5, unlockConfirmed: true });

  assert.equal(order.status, 'filled');
  const [symbol, type, side, amount, price, params] = fakeClient.calls.createOrder[0];
  assert.equal(symbol, 'BTC/USDT:USDT');
  assert.equal(type, 'market');
  assert.equal(side, 'sell'); // closing a long
  assert.equal(amount, 2.5);
  assert.deepEqual(params, { reduceOnly: true });

  const updated = futuresPositionsRepository.getPosition('real', userId, position.id);
  assert.equal(updated.qty, 7.5);
});

test('placeRealFuturesPartialClose: gates block before any exchange call when not unlocked', async (t) => {
  openAdaptiveFuturesPosition('real', userId);
  const fakeClient = fakeRealFuturesClient();
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeClient);
  mockFuturesPrice(t, 110);

  const order = await placeRealFuturesPartialClose({ userId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', level: 1, closeQty: 2.5 });
  assert.equal(order.status, 'rejected');
  assert.match(order.reject_reason, /REAL_TRADING_NOT_UNLOCKED/);
  assert.equal(fakeClient.calls.createOrder.length, 0);
});

test('placeRealFuturesPartialClose: a short position closes with side "buy" (reduceOnly)', async (t) => {
  openAdaptiveFuturesPosition('real', userId, { side: 'short' });
  const fakeClient = fakeRealFuturesClient();
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeClient);
  mockFuturesPrice(t, 90);

  const order = await placeRealFuturesPartialClose({ userId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', level: 1, closeQty: 2.5, unlockConfirmed: true });
  assert.equal(order.status, 'filled');
  assert.equal(fakeClient.calls.createOrder[0][2], 'buy'); // closing a short -> buy
  assert.equal(order.realized_pnl, 25); // short profits on fall: (100-90)*2.5
});
