'use strict';

// Proves the ENABLE_LIVE_TRADING gate independently blocks real futures auto-trading even when
// every other gate is on. Separate file/process from the other futures-auto-trader test files —
// see futures-auto-trader-flag-off.test.js's comment on why (config is frozen at process start).
process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.ENABLE_LIVE_TRADING = 'false';
process.env.ENABLE_FUTURES_AUTO_TRADING = 'true';
process.env.REAL_EXCHANGE_NAME = 'kucoin';
process.env.REAL_API_KEY = 'test-key';
process.env.REAL_API_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');
const futuresOrdersRepository = require('../../src/database/repositories/futures-orders-repository');
const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
const realExchangeCredentialsRepository = require('../../src/database/repositories/real-exchange-credentials-repository');
const usersRepository = require('../../src/database/repositories/users-repository');
const signalsService = require('../../src/services/signals');
const marketDataService = require('../../src/services/market-data/market-data-service');
const futuresAutoTrader = require('../../src/services/scheduler/futures-auto-trader');

test('ENABLE_LIVE_TRADING=false blocks real futures auto-trading even with every other gate on', async (t) => {
  resetForTests();
  const testUserId = usersRepository.createUser('live-trading-off-test-user', 'irrelevant-hash').id;
  futuresPortfolioRepository.ensureInitialized('demo', testUserId, 10000);
  futuresPortfolioRepository.ensureInitialized('real', testUserId, 10000);
  realExchangeCredentialsRepository.set(testUserId, 'kucoin', 'k', 's');

  const result = futuresAutoTrader.realAutoTradeGloballyAllowed();
  assert.equal(result.allowed, false);
  assert.match(result.reason, /ENABLE_LIVE_TRADING/);

  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => ({
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price: 60000, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
  t.mock.method(signalsService, 'generateSignal', async () => ({
    id: null, status: 'BUY', stopLoss: 50000, takeProfit: 80000,
  }));
  futuresAssetsRepository.addAsset('real', testUserId, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 });
  futuresAssetsRepository.setAutoTrade('real', testUserId, 'BTC/USDT:USDT', 'kucoin', true);

  const cycleResult = await futuresAutoTrader.runCycle();
  assert.equal(cycleResult.realEvaluated, 0);
  assert.equal(futuresOrdersRepository.listOrders('real', testUserId, {}).length, 0);
});
