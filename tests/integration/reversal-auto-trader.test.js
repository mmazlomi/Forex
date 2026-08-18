'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.ENABLE_LIVE_TRADING = 'true';
process.env.ENABLE_FUTURES_AUTO_TRADING = 'true';
process.env.FUTURES_AUTO_TRADE_MAX_LEVERAGE = '3';
process.env.REAL_EXCHANGE_NAME = 'kucoin';
process.env.REAL_API_KEY = 'test-key';
process.env.REAL_API_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');
const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
const usersRepository = require('../../src/database/repositories/users-repository');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const liveEngine = require('../../src/services/reversal-strategy/live-engine');
const reversalAutoTrader = require('../../src/services/scheduler/reversal-auto-trader');
const futuresAutoTrader = require('../../src/services/scheduler/futures-auto-trader');
const signalsService = require('../../src/services/signals');
const { STRATEGY_ID: LSR_STRATEGY_ID } = require('../../src/services/backtesting/reversal-backtest-engine');

function mockPrice(t, price = 60000) {
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => ({
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

function fakeKuCoinClient() {
  return {
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-lsr-1', status: 'closed' }),
    fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', liquidationPrice: 48300 }],
  };
}

let testUserId;
test.beforeEach(() => {
  resetForTests();
  testUserId = usersRepository.createUser('lsr-autotrader-test-user', 'irrelevant-hash').id;
  futuresPortfolioRepository.ensureInitialized('demo', testUserId, 10000);
  futuresPortfolioRepository.ensureInitialized('real', testUserId, 10000);
});

test('runCycle only processes assets tagged with the LSR strategy id, ignoring every other strategy', async (t) => {
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'ETH/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: 'balanced' });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'ETH/USDT:USDT', 'kucoin', true);

  const liveEngineSpy = t.mock.method(liveEngine, 'processLiveCycle', async () => null);
  const result = await reversalAutoTrader.runCycle();

  assert.equal(result.demoEvaluated, 1); // only the LSR-tagged asset
  assert.equal(liveEngineSpy.mock.callCount(), 1);
  assert.equal(liveEngineSpy.mock.calls[0].arguments[0].symbol, 'BTC/USDT:USDT');
});

test('futures-auto-trader.js skips LSR-tagged assets entirely (never scores them as a weighted strategy)', async (t) => {
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);

  const generateSignalSpy = t.mock.method(signalsService, 'generateSignal', async () => { throw new Error('should never be called for an LSR asset'); });
  const result = await futuresAutoTrader.runCycle();

  assert.equal(generateSignalSpy.mock.callCount(), 0);
  assert.equal(result.demoEvaluated, 1); // still counted as "evaluated" — just a no-op inside processAsset
});

test('a null decision from the live engine places no order', async (t) => {
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  mockPrice(t);
  t.mock.method(liveEngine, 'processLiveCycle', async () => null);

  await reversalAutoTrader.runCycle();

  const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
  assert.equal(futuresPositionsRepository.listOpenPositions('demo', testUserId).length, 0);
});

test('a bullish entry decision opens a long demo futures position with the engine\'s own SL/TP', async (t) => {
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  mockPrice(t, 60000);
  t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 58000, takeProfit: 64000 }));

  const result = await reversalAutoTrader.runCycle();
  assert.equal(result.demoEvaluated, 1);

  const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
  const positions = futuresPositionsRepository.listOpenPositions('demo', testUserId);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'long');
  assert.equal(positions[0].stop_loss, 58000);
  assert.equal(positions[0].take_profit, 64000);
  assert.equal(positions[0].source, 'auto');
  // Regression: LSR positions have no signals-table row to derive strategy_id from (unlike
  // every other strategy) — the scheduler must pass strategyId explicitly so the Open Positions
  // "Strategy" column isn't silently empty for LSR-opened positions.
  assert.equal(positions[0].strategy_id, LSR_STRATEGY_ID);
});

test('a bearish entry decision opens a short demo futures position', async (t) => {
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  mockPrice(t, 60000);
  t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bearish', stopLoss: 62000, takeProfit: 56000 }));

  await reversalAutoTrader.runCycle();

  const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
  const positions = futuresPositionsRepository.listOpenPositions('demo', testUserId);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'short');
});

test('the live engine is told about an already-open position (one-way mode) via hasOpenPosition, not asked to re-detect it', async (t) => {
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  mockPrice(t, 60000);

  // First cycle opens a position.
  t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 58000, takeProfit: 64000 }));
  await reversalAutoTrader.runCycle();

  // Second cycle: the scheduler must report hasOpenPosition=true for this symbol now.
  const spy = t.mock.method(liveEngine, 'processLiveCycle', async (args) => {
    assert.equal(args.hasOpenPosition, true);
    return null;
  });
  await reversalAutoTrader.runCycle();
  assert.equal(spy.mock.callCount(), 1);
});

test('real LSR assets are skipped when the user has no usable real credentials configured, without touching demo', async (t) => {
  futuresAssetsRepository.addAsset('real', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('real', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  // No real credentials stored for this user, and the .env fallback only applies to the legacy
  // "hoseini" owner account — see real-credentials-resolver.js, same convention futures-real-orders
  // tests rely on.
  const spy = t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 1, takeProfit: 2 }));

  const result = await reversalAutoTrader.runCycle();
  // Matches futures-auto-trader.js's identical convention: the asset was fetched/iterated (still
  // counted as "evaluated") but skipped INSIDE processAsset before ever calling the live engine —
  // see resolveRealCredentialsForUser's per-asset gate, not a pre-filter on the evaluated count.
  assert.equal(result.realEvaluated, 1, 'the asset was fetched and iterated, even though it was skipped internally');
  assert.equal(spy.mock.callCount(), 0);
});

test('real LSR auto-trade actually places a real order end to end when credentials + gates are all satisfied', async (t) => {
  const legacyOwnerId = usersRepository.createUser('hoseini', 'irrelevant-hash').id;
  futuresPortfolioRepository.ensureInitialized('real', legacyOwnerId, 10000);
  futuresAssetsRepository.addAsset('real', legacyOwnerId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('real', legacyOwnerId, 'BTC/USDT:USDT', 'kucoin', true);

  mockPrice(t, 60000);
  const fakeClient = fakeKuCoinClient();
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeClient);
  t.mock.method(liveEngine, 'processLiveCycle', async () => ({ direction: 'bullish', stopLoss: 58000, takeProfit: 64000 }));

  const result = await reversalAutoTrader.runCycle();
  assert.equal(result.realEvaluated, 1);

  const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
  const positions = futuresPositionsRepository.listOpenPositions('real', legacyOwnerId);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].source, 'auto');
});

test('getStatus counts only LSR-tagged auto-trade-enabled assets', () => {
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: LSR_STRATEGY_ID });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'ETH/USDT:USDT', exchange: 'kucoin', leverage: 5, strategyId: 'momentum' });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'ETH/USDT:USDT', 'kucoin', true);

  const status = reversalAutoTrader.getStatus();
  assert.equal(status.demoEnabledAssetCount, 1);
});
