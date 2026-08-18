'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.ENABLE_LIVE_TRADING = 'true';
process.env.ENABLE_SPOT_AUTO_TRADING = 'true';
process.env.REAL_EXCHANGE_NAME = 'kucoin';
process.env.REAL_API_KEY = 'test-key';
process.env.REAL_API_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const portfolioRepository = require('../../src/database/repositories/portfolio-repository');
const positionsRepository = require('../../src/database/repositories/positions-repository');
const usersRepository = require('../../src/database/repositories/users-repository');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const liveEngine = require('../../src/services/reversal-strategy/live-engine');
const reversalSpotAutoTrader = require('../../src/services/scheduler/reversal-spot-auto-trader');
const autoTrader = require('../../src/services/scheduler/auto-trader');
const signalsService = require('../../src/services/signals');
const { STRATEGY_ID: LSR_STRATEGY_ID } = require('../../src/services/backtesting/reversal-backtest-engine');

function mockPrice(t, price = 60000) {
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price, changePercent24h: 1, volume24h: 100,
    marketOpen: true, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

function fakeSpotClient() {
  return {
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-spot-lsr-1', status: 'closed' }),
    loadMarkets: async () => {},
    markets: { 'BTC/USDT': {} },
  };
}

let testUserId;
test.beforeEach(() => {
  resetForTests();
  testUserId = usersRepository.createUser('lsr-spot-autotrader-test-user', 'irrelevant-hash').id;
  portfolioRepository.ensureInitialized('demo', testUserId, 10000);
  portfolioRepository.ensureInitialized('real', testUserId, 10000);
});

function addLsrAsset(userId, overrides = {}) {
  return assetsRepository.addAsset(userId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', assetType: 'crypto', strategyId: LSR_STRATEGY_ID, ...overrides,
  });
}

test('runCycle only processes LSR-tagged assets, ignoring every other strategy', async (t) => {
  addLsrAsset(testUserId);
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  assetsRepository.addAsset(testUserId, { symbol: 'ETH/USDT', exchange: 'kucoin', market: 'spot', assetType: 'crypto', strategyId: 'balanced' });
  assetsRepository.setAutoTrade(testUserId, 'ETH/USDT', 'kucoin', true);

  const spy = t.mock.method(liveEngine, 'processLiveCycle', async () => null);
  const result = await reversalSpotAutoTrader.runCycle();

  assert.equal(result.demoEvaluated, 1);
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(spy.mock.calls[0].arguments[0].market, 'spot');
  assert.equal(spy.mock.calls[0].arguments[0].symbol, 'BTC/USDT');
});

test('the existing generic auto-trader.js skips LSR-tagged assets entirely', async (t) => {
  addLsrAsset(testUserId);
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);

  const generateSignalSpy = t.mock.method(signalsService, 'generateSignal', async () => { throw new Error('should never be called for an LSR asset'); });
  const result = await autoTrader.runCycle();

  assert.equal(generateSignalSpy.mock.callCount(), 0);
  assert.equal(result.evaluated, 1); // still counted as "evaluated" — just a no-op inside processAsset
});

test('a bearish decision is discarded — spot never shorts', async (t) => {
  addLsrAsset(testUserId);
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  mockPrice(t, 60000);
  t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bearish', stopLoss: 62000, takeProfit: 56000 }));

  await reversalSpotAutoTrader.runCycle();

  assert.equal(positionsRepository.listOpenPositions('demo', testUserId).length, 0);
});

test('a bullish decision opens a Demo BUY spot position with the engine\'s own SL/TP', async (t) => {
  addLsrAsset(testUserId);
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  mockPrice(t, 60000);
  t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 58000, takeProfit: 64000 }));

  const result = await reversalSpotAutoTrader.runCycle();
  assert.equal(result.demoEvaluated, 1);

  const positions = positionsRepository.listOpenPositions('demo', testUserId);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'buy');
  assert.equal(positions[0].stop_loss, 58000);
  assert.equal(positions[0].take_profit, 64000);
  // Regression: LSR positions have no signals-table row to derive strategy_id from (unlike
  // every other strategy) — the scheduler must pass strategyId explicitly so the Open Positions
  // "Strategy" column isn't silently empty for LSR-opened positions.
  assert.equal(positions[0].strategy_id, LSR_STRATEGY_ID);
});

test('a null decision places no order', async (t) => {
  addLsrAsset(testUserId);
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  mockPrice(t);
  t.mock.method(liveEngine, 'processLiveCycle', async () => null);

  await reversalSpotAutoTrader.runCycle();
  assert.equal(positionsRepository.listOpenPositions('demo', testUserId).length, 0);
});

test('the live engine is told about an already-open position via hasOpenPosition (one-way, no pyramiding)', async (t) => {
  addLsrAsset(testUserId);
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  mockPrice(t, 60000);

  t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 58000, takeProfit: 64000 }));
  await reversalSpotAutoTrader.runCycle();

  const spy = t.mock.method(liveEngine, 'processLiveCycle', async (args) => {
    assert.equal(args.hasOpenPosition, true);
    return null;
  });
  await reversalSpotAutoTrader.runCycle();
  assert.equal(spy.mock.callCount(), 1);
});

// realSpotAutoTradeGloballyAllowed is a pure server-wide check (ENABLE_SPOT_AUTO_TRADING +
// ENABLE_LIVE_TRADING only, no credential lookup — per-user credentials are resolved separately
// in processAsset). The two env-flag-off cases can't be tested in this file (config is frozen at
// process start, and this file's top already sets both flags true) — they'd need their own
// separate-process test files, same convention as futures-auto-trader-flag-off.test.js /
// futures-auto-trader-live-trading-off.test.js, not added here to keep this session's scope
// focused on the happy path already exercised end to end by the tests below.
test('realSpotAutoTradeGloballyAllowed: pure server-wide check, independent of any credentials', () => {
  const result = reversalSpotAutoTrader.realSpotAutoTradeGloballyAllowed();
  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
});

test('real LSR spot assets require their OWN real_auto_trade_enabled opt-in, separate from the Demo flag', async (t) => {
  addLsrAsset(testUserId);
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true); // demo only, no real opt-in
  const spy = t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 1, takeProfit: 2 }));

  const result = await reversalSpotAutoTrader.runCycle();
  assert.equal(result.realEvaluated, 0);
  assert.equal(spy.mock.callCount(), 1); // only the demo call
});

test('real LSR spot assets are skipped when the user has no usable real credentials, without touching demo', async (t) => {
  addLsrAsset(testUserId);
  assetsRepository.setRealAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  const spy = t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 1, takeProfit: 2 }));

  const result = await reversalSpotAutoTrader.runCycle();
  assert.equal(result.realEvaluated, 1, 'the asset was fetched and iterated, even though it was skipped internally');
  assert.equal(spy.mock.callCount(), 0);
});

test('real LSR spot auto-trade places a real BUY order end to end when credentials + gates + the real opt-in are all satisfied', async (t) => {
  const legacyOwnerId = usersRepository.createUser('hoseini', 'irrelevant-hash').id;
  portfolioRepository.ensureInitialized('real', legacyOwnerId, 10000);
  addLsrAsset(legacyOwnerId);
  assetsRepository.setRealAutoTrade(legacyOwnerId, 'BTC/USDT', 'kucoin', true);

  mockPrice(t, 60000);
  const fakeClient = fakeSpotClient();
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeClient);
  t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 58000, takeProfit: 64000 }));

  const result = await reversalSpotAutoTrader.runCycle();
  assert.equal(result.realEvaluated, 1);

  const positions = positionsRepository.listOpenPositions('real', legacyOwnerId);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'buy');
});

test('getStatus counts only LSR-tagged assets, separately for demo/real opt-ins', () => {
  addLsrAsset(testUserId);
  assetsRepository.setAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  assetsRepository.setRealAutoTrade(testUserId, 'BTC/USDT', 'kucoin', true);
  assetsRepository.addAsset(testUserId, { symbol: 'ETH/USDT', exchange: 'kucoin', market: 'spot', assetType: 'crypto', strategyId: 'momentum' });
  assetsRepository.setAutoTrade(testUserId, 'ETH/USDT', 'kucoin', true);

  const status = reversalSpotAutoTrader.getStatus();
  assert.equal(status.demoEnabledAssetCount, 1);
  assert.equal(status.realEnabledAssetCount, 1);
});
