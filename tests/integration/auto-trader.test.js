'use strict';

process.env.DATABASE_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const usersRepository = require('../../src/database/repositories/users-repository');
const positionsRepository = require('../../src/database/repositories/positions-repository');
const ordersRepository = require('../../src/database/repositories/orders-repository');
const signalsService = require('../../src/services/signals');
const signalsRepository = require('../../src/database/repositories/signals-repository');
const marketDataService = require('../../src/services/market-data/market-data-service');
const autoTrader = require('../../src/services/scheduler/auto-trader');

function mockPrice(t, price = 100) {
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    status: 'ok', price, dataFreshnessMs: 500,
  }));
}

let signalCounter = 0;

// `demo_orders.signal_id` is a foreign key into `signals`, and the real generateSignal()
// always persists the signal before returning it. Since these tests mock generateSignal
// entirely, the mock must replicate that side effect too, or placeDemoOrder's insert would
// violate the FK constraint the same way an ungenerated signal id would in production.
function baseSignal(overrides = {}) {
  signalCounter += 1;
  const signal = {
    id: `sig-${signalCounter}`, symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h',
    tsUtc: new Date().toISOString(), price: 100, status: 'HOLD',
    entry: null, stopLoss: null, takeProfit: null, finalScore: 0, confidence: 0,
    technicalScore: 0, fundamentalScore: 0, riskRewardRatio: null,
    dataQuality: 'good', warnings: [], reasons: [], strategyVersion: '1.0.0', sourceMode: 'demo',
    ...overrides,
  };
  signalsRepository.insertSignal({
    id: signal.id, symbol: signal.symbol, exchange: signal.exchange, timeframe: signal.timeframe,
    tsUtc: signal.tsUtc, price: signal.price, technicalScore: signal.technicalScore,
    fundamentalScore: signal.fundamentalScore, finalScore: signal.finalScore, status: signal.status,
    confidence: signal.confidence, reasonsJson: '[]', technicalSummaryJson: '{}', fundamentalSummaryJson: '{}',
    entry: signal.entry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
    riskRewardRatio: signal.riskRewardRatio, dataQuality: signal.dataQuality, warningsJson: '[]',
    strategyVersion: signal.strategyVersion, sourceMode: signal.sourceMode,
  });
  return signal;
}

let testUserId;

test.beforeEach(() => {
  resetForTests();
  // Auto-trading watches every account's enabled assets (it's still a single shared Demo bot —
  // see assets-repository.js#listAutoTradeEnabled), so a plain single test user is enough here.
  testUserId = usersRepository.createUser('autotrader-test-user', 'irrelevant-hash').id;
});

test('runCycle does nothing when no asset has auto-trading enabled', async () => {
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  const result = await autoTrader.runCycle();
  assert.equal(result.evaluated, 0);
});

test('runCycle opens a Demo BUY when the signal is BUY and no position is open', async (t) => {
  mockPrice(t);
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);

  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({
    status: 'BUY', entry: 100, stopLoss: 90, takeProfit: 130,
  }));

  const result = await autoTrader.runCycle();
  assert.equal(result.evaluated, 1);

  const orders = ordersRepository.listOrders('demo', testUserId, {});
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'filled');
  assert.equal(orders[0].side, 'buy');

  const position = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.ok(position);
});

test('runCycle does not open a second position when one is already open for that symbol', async (t) => {
  mockPrice(t);
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({
    status: 'BUY', entry: 100, stopLoss: 90, takeProfit: 130,
  }));

  await autoTrader.runCycle();
  await autoTrader.runCycle(); // second tick, still BUY, position already open

  const orders = ordersRepository.listOrders('demo', testUserId, {});
  assert.equal(orders.length, 1, 'a second BUY should not have been placed while a position is already open');
});

test('runCycle closes the position with a Demo SELL when the signal turns SELL', async (t) => {
  mockPrice(t);
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);

  const mock = t.mock.method(signalsService, 'generateSignal', async () => baseSignal({
    status: 'BUY', entry: 100, stopLoss: 90, takeProfit: 130,
  }));
  await autoTrader.runCycle();
  assert.ok(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'));

  mock.mock.mockImplementation(async () => baseSignal({ status: 'SELL', entry: 105 }));
  await autoTrader.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), undefined);
  const orders = ordersRepository.listOrders('demo', testUserId, {});
  assert.equal(orders.length, 2);
  assert.equal(orders[0].side, 'sell'); // most recent first
});

test('runCycle never places a Real order, even if a signal somehow says BUY for a demo-disabled asset', async (t) => {
  mockPrice(t);
  assetsRepository.addAsset(testUserId, { symbol: 'ETH/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'ETH/USDT', 'kucoin', true);
  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({
    symbol: 'ETH/USDT', status: 'BUY', entry: 100, stopLoss: 90, takeProfit: 130,
  }));

  await autoTrader.runCycle();

  assert.equal(ordersRepository.listOrders('real', testUserId, {}).length, 0);
  assert.equal(ordersRepository.listOrders('demo', testUserId, {}).length, 1);
});

test('runCycle skips assets whose signal generation throws, without crashing the whole cycle', async (t) => {
  mockPrice(t);
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.addAsset(testUserId, { symbol: 'ETH/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  assetsRepository.setAutoTrade(testUserId, 'ETH/USDT', 'kucoin', true);

  let call = 0;
  t.mock.method(signalsService, 'generateSignal', async ({ symbol }) => {
    call += 1;
    if (symbol === 'BTC/USDT') throw new Error('simulated failure');
    return baseSignal({ symbol, status: 'BUY', entry: 100, stopLoss: 90, takeProfit: 130 });
  });

  const result = await autoTrader.runCycle();
  assert.equal(result.evaluated, 2);
  assert.equal(call, 2); // both assets were attempted despite the first one throwing
  assert.equal(ordersRepository.listOrders('demo', testUserId, {}).length, 1); // ETH still went through
});

test('getStatus reports the enabled asset count and Demo-only mode', async () => {
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);

  const status = autoTrader.getStatus();
  assert.equal(status.mode, 'demo');
  assert.equal(status.enabledAssetCount, 1);
  assert.ok(status.intervalMs >= 30_000);
});

test('processAsset uses generateCombinedSignal (majority vote) for a strategy_mode="auto" asset with >= 2 selected strategies, never the single-strategy generateSignal', async (t) => {
  mockPrice(t);
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  assetsRepository.setStrategyMode(testUserId, 'BTC/USDT', 'kucoin', 'auto');
  assetsRepository.setSelectedStrategies(testUserId, 'BTC/USDT', 'kucoin', ['balanced', 'trend-following']);

  const combinedMock = t.mock.method(signalsService, 'generateCombinedSignal', async ({ strategyIds }) => {
    assert.deepEqual(strategyIds, ['balanced', 'trend-following']);
    return baseSignal({ status: 'HOLD' });
  });
  const singleMock = t.mock.method(signalsService, 'generateSignal', async () => {
    throw new Error('generateSignal (single-strategy) should not be called for an auto-mode asset with a valid selection');
  });

  await autoTrader.runCycle();
  assert.equal(combinedMock.mock.callCount(), 1);
  assert.equal(singleMock.mock.callCount(), 0);
});

test('processAsset falls back to the single-strategy generateSignal for an "auto"-mode asset with no selection yet (not yet evaluated)', async (t) => {
  mockPrice(t);
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  assetsRepository.setStrategyMode(testUserId, 'BTC/USDT', 'kucoin', 'auto'); // selected_strategy_ids_json still null

  const combinedMock = t.mock.method(signalsService, 'generateCombinedSignal', async () => {
    throw new Error('generateCombinedSignal should not be called before a selection exists');
  });
  const singleMock = t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'HOLD' }));

  await autoTrader.runCycle();
  assert.equal(singleMock.mock.callCount(), 1);
  assert.equal(combinedMock.mock.callCount(), 0);
});

test('runCycle wires an opted-in asset\'s BUY through the Adaptive Take-Profit engine, storing tiered TP prices on the position', async (t) => {
  mockPrice(t, 160);
  t.mock.method(marketDataService, 'getCandles', async () => {
    const now = Date.now();
    const candles = [];
    let price = 100;
    for (let i = 0; i < 200; i += 1) {
      price += 0.3;
      candles.push({ tsUtc: now - (200 - i) * 3600_000, open: price - 0.2, high: price + 8, low: price - 8, close: price, volume: 10 + i });
    }
    return candles;
  });

  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  assetsRepository.setAdaptiveTpEnabled(testUserId, 'BTC/USDT', 'kucoin', true);

  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({
    status: 'BUY', entry: 160, stopLoss: 150, takeProfit: 175,
  }));

  await autoTrader.runCycle();

  const position = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.ok(position);
  assert.equal(position.adaptive_tp_enabled, 1);
  assert.ok(typeof position.tp1_price === 'number' && position.tp1_price > 160);
  assert.ok(position.tp2_price > position.tp1_price);
  assert.ok(position.tp3_price > position.tp2_price);
  assert.equal(position.take_profit, position.tp3_price, 'the classic take_profit column is the adaptive fallback ceiling (TP3), not the original fixed 175');
});

test('runCycle leaves a non-opted-in asset\'s BUY completely unaffected by the adaptive machinery (regression pin)', async (t) => {
  mockPrice(t, 100);
  const getCandlesMock = t.mock.method(marketDataService, 'getCandles', async () => { throw new Error('should never be called for a non-adaptive asset'); });

  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  // adaptive_tp_enabled left at its default (off).

  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({
    status: 'BUY', entry: 100, stopLoss: 90, takeProfit: 130,
  }));

  await autoTrader.runCycle();

  const position = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.ok(position);
  assert.equal(position.adaptive_tp_enabled, 0);
  assert.equal(position.take_profit, 130, 'unchanged: the original fixed take-profit, not an adaptive fallback');
  assert.equal(position.tp1_price, null);
  assert.equal(getCandlesMock.mock.calls.length, 0, 'resolveAdaptiveTp must never fetch candles for a non-opted-in asset');
});

test('processAsset uses the single-strategy generateSignal for an ordinary "manual"-mode asset (default, unchanged behavior)', async (t) => {
  mockPrice(t);
  assetsRepository.addAsset(testUserId, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  // strategy_mode defaults to 'manual' — never touched here.

  const combinedMock = t.mock.method(signalsService, 'generateCombinedSignal', async () => {
    throw new Error('generateCombinedSignal should not be called for a manual-mode asset');
  });
  const singleMock = t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'HOLD' }));

  await autoTrader.runCycle();
  assert.equal(singleMock.mock.callCount(), 1);
  assert.equal(combinedMock.mock.callCount(), 0);
});
