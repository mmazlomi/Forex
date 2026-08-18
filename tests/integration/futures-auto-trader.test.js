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
const futuresOrdersRepository = require('../../src/database/repositories/futures-orders-repository');
const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
const realExchangeCredentialsRepository = require('../../src/database/repositories/real-exchange-credentials-repository');
const usersRepository = require('../../src/database/repositories/users-repository');
const signalsService = require('../../src/services/signals');
const signalsRepository = require('../../src/database/repositories/signals-repository');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const futuresAutoTrader = require('../../src/services/scheduler/futures-auto-trader');

function mockPrice(t, price = 60000) {
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => ({
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

let signalCounter = 0;
function baseSignal(overrides = {}) {
  signalCounter += 1;
  const signal = {
    id: `sig-${signalCounter}`, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', timeframe: '1h',
    tsUtc: new Date().toISOString(), price: 60000, status: 'HOLD',
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

function fakeKuCoinClient() {
  return {
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-auto-1', status: 'closed' }),
    fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', liquidationPrice: 48300 }],
  };
}

let testUserId;
test.beforeEach(() => {
  resetForTests();
  testUserId = usersRepository.createUser('futures-autotrader-test-user', 'irrelevant-hash').id;
  futuresPortfolioRepository.ensureInitialized('demo', testUserId, 10000);
  futuresPortfolioRepository.ensureInitialized('real', testUserId, 10000);
});

// realAutoTradeGloballyAllowed() is now a pure server-wide check (ENABLE_FUTURES_AUTO_TRADING +
// ENABLE_LIVE_TRADING only) with NO credential lookup at all — per-user credential gating moved
// to processAsset's per-cycle cache (resolveRealCredentialsForUser), tested below via runCycle.
// The two env-flag-off cases are covered in their own separate-process files (config is frozen at
// process start) — see futures-auto-trader-flag-off.test.js and futures-auto-trader-live-trading-off.test.js.
test('realAutoTradeGloballyAllowed: pure server-wide check, independent of any credentials', () => {
  const result = futuresAutoTrader.realAutoTradeGloballyAllowed();
  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
});

test('runCycle: demo futures order is placed on a BUY signal, unaffected by the real watchlist being empty', async (t) => {
  mockPrice(t);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  // Real watchlist deliberately left empty — demo should still fire.
  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'BUY', entry: 60000, stopLoss: 50000, takeProfit: 80000 }));

  const result = await futuresAutoTrader.runCycle();
  assert.equal(result.demoEvaluated, 1);
  assert.equal(result.realEvaluated, 0);

  const demoOrders = futuresOrdersRepository.listOrders('demo', testUserId, {});
  assert.equal(demoOrders.length, 1);
  assert.equal(demoOrders[0].status, 'filled');
  assert.equal(demoOrders[0].action, 'open_long');
  assert.equal(demoOrders[0].source, 'auto');

  const realOrders = futuresOrdersRepository.listOrders('real', testUserId, {});
  assert.equal(realOrders.length, 0, 'symbol was never on the real watchlist — no real order should exist');
});

test('runCycle: leverage is clamped to FUTURES_AUTO_TRADE_MAX_LEVERAGE for the real list, but not for demo', async (t) => {
  mockPrice(t);
  realExchangeCredentialsRepository.set(testUserId, 'kucoin', 'k', 's');
  // Asset configured for 50x on both lists, but FUTURES_AUTO_TRADE_MAX_LEVERAGE=3 only clamps Real.
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 50 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  futuresAssetsRepository.addAsset('real', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 50 });
  futuresAssetsRepository.setAutoTrade('real', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'BUY', entry: 60000, stopLoss: 50000, takeProfit: 80000 }));
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeKuCoinClient());

  await futuresAutoTrader.runCycle();
  const demoOrders = futuresOrdersRepository.listOrders('demo', testUserId, {});
  const realOrders = futuresOrdersRepository.listOrders('real', testUserId, {});
  assert.equal(demoOrders[0].leverage, 50); // demo has no leverage cap
  assert.equal(realOrders[0].leverage, 3); // real is clamped down

  realExchangeCredentialsRepository.clear(testUserId);
});

test('runCycle: real futures order is placed only when the symbol is on the real watchlist AND global gates pass, source=auto, no unlockConfirmed prompt needed', async (t) => {
  mockPrice(t);
  realExchangeCredentialsRepository.set(testUserId, 'kucoin', 'k', 's');
  futuresAssetsRepository.addAsset('real', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('real', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'BUY', entry: 60000, stopLoss: 50000, takeProfit: 80000 }));
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeKuCoinClient());

  await futuresAutoTrader.runCycle();

  const realOrders = futuresOrdersRepository.listOrders('real', testUserId, {});
  assert.equal(realOrders.length, 1);
  assert.equal(realOrders[0].status, 'filled');
  assert.equal(realOrders[0].source, 'auto');
  const realPosition = futuresPositionsRepository.findOpenPositionBySymbol('real', testUserId, 'BTC/USDT:USDT');
  assert.ok(realPosition);
  assert.equal(realPosition.leverage, 3); // clamped, asset was configured for 5 but max is 3
  // Demo watchlist was never populated with this symbol — no demo order either.
  assert.equal(futuresOrdersRepository.listOrders('demo', testUserId, {}).length, 0);

  realExchangeCredentialsRepository.clear(testUserId);
});

test('runCycle: real order is NOT placed when the symbol is only on the demo watchlist, even with credentials and both env flags on', async (t) => {
  mockPrice(t);
  realExchangeCredentialsRepository.set(testUserId, 'kucoin', 'k', 's');
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  // Deliberately never added to the real watchlist.
  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'BUY', entry: 60000, stopLoss: 50000, takeProfit: 80000 }));
  const client = fakeKuCoinClient();
  const mockedFactory = t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => client);

  await futuresAutoTrader.runCycle();

  assert.equal(futuresOrdersRepository.listOrders('real', testUserId, {}).length, 0);
  assert.equal(mockedFactory.mock.callCount(), 0, 'the real exchange client should never even be resolved');
  realExchangeCredentialsRepository.clear(testUserId);
});

// Per-user credential gating: an asset on the real watchlist for a user with no usable KuCoin
// credentials is skipped entirely (no signal even generated, no order attempted) — this is what
// makes real trading genuinely independent per user, replacing the old single shared-credential
// global gate. Neither DB credentials nor the .env fallback apply here: the .env fallback (set at
// the top of this file) only ever applies to the legacy data owner account ("hoseini"), and this
// test's user is a fresh, unrelated account — so this is the natural "not configured" case,
// nothing needs to be explicitly cleared.
test('runCycle: a real-list asset for a user with no usable KuCoin credentials is skipped — no signal generated, no order placed', async (t) => {
  mockPrice(t);
  futuresAssetsRepository.addAsset('real', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('real', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  const signalMock = t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'BUY', entry: 60000, stopLoss: 50000, takeProfit: 80000 }));

  const result = await futuresAutoTrader.runCycle();
  assert.equal(result.realEvaluated, 1, 'the asset was fetched and iterated, even though it was skipped internally');
  assert.equal(signalMock.mock.callCount(), 0, 'no signal should even be generated for a user with no usable credentials');
  assert.equal(futuresOrdersRepository.listOrders('real', testUserId, {}).length, 0);
});

// The single most important test in this file given the real-money stakes: proves real trading
// is genuinely independent per user, not just per-asset skip logic in isolation. Two users, both
// on the real watchlist in the SAME cycle — one with valid (mocked) KuCoin credentials, one with
// none at all. The unconfigured user's asset must be skipped without generating so much as a
// signal for it, while that skip must have zero effect on the configured user's asset actually
// trading normally in the same runCycle() call.
test('runCycle: real trading is genuinely independent per user — a configured user trades normally while an unconfigured user is skipped, in the same cycle', async (t) => {
  mockPrice(t);
  const configuredUserId = testUserId;
  const unconfiguredUserId = usersRepository.createUser('futures-autotrader-unconfigured-user', 'irrelevant-hash').id;
  realExchangeCredentialsRepository.set(configuredUserId, 'kucoin', 'k', 's');
  // unconfiguredUserId deliberately gets no DB-stored credentials, and the .env fallback set at
  // the top of this file only ever applies to the legacy owner account ("hoseini") — neither
  // account here is that one, so unconfiguredUserId is a clean "nothing configured" case.

  futuresAssetsRepository.addAsset('real', configuredUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('real', configuredUserId, 'BTC/USDT:USDT', 'kucoin', true);
  futuresAssetsRepository.addAsset('real', unconfiguredUserId, { symbol: 'ETH/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('real', unconfiguredUserId, 'ETH/USDT:USDT', 'kucoin', true);

  const signalMock = t.mock.method(signalsService, 'generateSignal', async ({ symbol }) => baseSignal({ symbol, status: 'BUY', entry: 60000, stopLoss: 50000, takeProfit: 80000 }));
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => fakeKuCoinClient());

  const result = await futuresAutoTrader.runCycle();
  assert.equal(result.realEvaluated, 2, 'both users\' real-list assets were fetched in the same cycle');
  assert.equal(signalMock.mock.callCount(), 1, 'signal generation ran exactly once — only for the configured user; the unconfigured user was skipped before ever reaching it');

  const configuredOrders = futuresOrdersRepository.listOrders('real', configuredUserId, {});
  assert.equal(configuredOrders.length, 1);
  assert.equal(configuredOrders[0].status, 'filled');
  assert.equal(configuredOrders[0].symbol, 'BTC/USDT:USDT');

  const unconfiguredOrders = futuresOrdersRepository.listOrders('real', unconfiguredUserId, {});
  assert.equal(unconfiguredOrders.length, 0, 'the unconfigured user has no order at all — not even a rejected one — since processAsset returns before ever calling placeRealFuturesOrder');

  realExchangeCredentialsRepository.clear(configuredUserId);
});

test('runCycle skips assets whose signal generation throws, without crashing the whole cycle', async (t) => {
  mockPrice(t);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'ETH/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'ETH/USDT:USDT', 'kucoin', true);

  let call = 0;
  t.mock.method(signalsService, 'generateSignal', async ({ symbol }) => {
    call += 1;
    if (symbol === 'BTC/USDT:USDT') throw new Error('simulated failure');
    return baseSignal({ symbol, status: 'BUY', entry: 60000, stopLoss: 50000, takeProfit: 80000 });
  });

  const result = await futuresAutoTrader.runCycle();
  assert.equal(result.demoEvaluated, 2);
  assert.equal(call, 2);
  assert.equal(futuresOrdersRepository.listOrders('demo', testUserId, {}).length, 1); // ETH still went through
});

test('getStatus reports demo and real enabled asset counts independently', async () => {
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'ETH/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  // ETH left disabled — should not count.

  const status = futuresAutoTrader.getStatus();
  assert.equal(status.demoEnabledAssetCount, 1);
  assert.equal(status.realEnabledAssetCount, 0);
  assert.equal(status.maxLeverage, 3);
  assert.equal(status.enableFuturesAutoTrading, true);
});

test('processAsset uses generateCombinedSignal (majority vote) for a strategy_mode="auto" futures asset with >= 2 selected strategies, never the single-strategy generateSignal', async (t) => {
  mockPrice(t);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  futuresAssetsRepository.setStrategyMode('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', 'auto');
  futuresAssetsRepository.setSelectedStrategies('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', ['momentum', 'mean-reversion', 'balanced']);

  const combinedMock = t.mock.method(signalsService, 'generateCombinedSignal', async ({ strategyIds, market }) => {
    assert.deepEqual(strategyIds, ['momentum', 'mean-reversion', 'balanced']);
    assert.equal(market, 'futures');
    return baseSignal({ status: 'HOLD' });
  });
  const singleMock = t.mock.method(signalsService, 'generateSignal', async () => {
    throw new Error('generateSignal (single-strategy) should not be called for an auto-mode asset with a valid selection');
  });

  await futuresAutoTrader.runCycle();
  assert.equal(combinedMock.mock.callCount(), 1);
  assert.equal(singleMock.mock.callCount(), 0);
});

test('processAsset uses the single-strategy generateSignal for an ordinary "manual"-mode futures asset (default, unchanged behavior)', async (t) => {
  mockPrice(t);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  // strategy_mode defaults to 'manual' — never touched here.

  const combinedMock = t.mock.method(signalsService, 'generateCombinedSignal', async () => {
    throw new Error('generateCombinedSignal should not be called for a manual-mode asset');
  });
  const singleMock = t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'HOLD' }));

  await futuresAutoTrader.runCycle();
  assert.equal(singleMock.mock.callCount(), 1);
  assert.equal(combinedMock.mock.callCount(), 0);
});

// A SELL signal with nothing open used to be a silent no-op (long-only auto-trading, even though
// open_short is fully supported at the order layer — see docs/architecture.md §18). This proves
// the fix: SELL now opens a short exactly the way BUY opens a long.
test('runCycle: a SELL signal with no open position opens a short (not a silent no-op)', async (t) => {
  mockPrice(t);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'SELL', entry: 60000, stopLoss: 70000, takeProfit: 40000 }));

  await futuresAutoTrader.runCycle();

  const demoOrders = futuresOrdersRepository.listOrders('demo', testUserId, {});
  assert.equal(demoOrders.length, 1);
  assert.equal(demoOrders[0].status, 'filled');
  assert.equal(demoOrders[0].action, 'open_short');
  const position = futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT');
  assert.ok(position);
  assert.equal(position.side, 'short');
});

test('runCycle: a SELL signal while already short is left alone — no duplicate open, no close', async (t) => {
  mockPrice(t);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);
  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'SELL', entry: 60000, stopLoss: 70000, takeProfit: 40000 }));

  await futuresAutoTrader.runCycle(); // opens the short
  await futuresAutoTrader.runCycle(); // should be a no-op, not a second order

  assert.equal(futuresOrdersRepository.listOrders('demo', testUserId, {}).length, 1);
});

test('runCycle: a BUY signal while an opposing short is open closes it (does not attempt to open a long into it)', async (t) => {
  mockPrice(t);
  futuresAssetsRepository.addAsset('demo', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('demo', testUserId, 'BTC/USDT:USDT', 'kucoin', true);

  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'SELL', entry: 60000, stopLoss: 70000, takeProfit: 40000 }));
  await futuresAutoTrader.runCycle(); // opens the short
  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT').side, 'short');

  t.mock.method(signalsService, 'generateSignal', async () => baseSignal({ status: 'BUY', entry: 60000, stopLoss: 50000, takeProfit: 80000 }));
  await futuresAutoTrader.runCycle(); // should close the short, not reject with POSITION_ALREADY_OPEN

  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'), undefined);
  const orders = futuresOrdersRepository.listOrders('demo', testUserId, {});
  assert.equal(orders.length, 2);
  assert.equal(orders[0].action, 'close');
});
