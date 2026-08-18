'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const marketDataService = require('../../src/services/market-data/market-data-service');
const usersRepository = require('../../src/database/repositories/users-repository');
const signalsRepository = require('../../src/database/repositories/signals-repository');

// Positions record which signal/strategy (if any) opened them — see
// src/services/signals/resolve-position-strategy.js and describeStrategyIds in strategies.js.
// This file exercises that end-to-end: placing an order with a signalId results in an open
// position whose strategy fields resolve back to the signal's strategy/strategies, and a plain
// manual order with no signalId leaves them empty.

function mockFuturesPrice(price) {
  return {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  };
}

function mockSpotPrice(price) {
  return {
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  };
}

function insertSingleStrategySignal({ id, symbol }) {
  signalsRepository.insertSignal({
    id, symbol, exchange: 'kucoin', timeframe: '1h', tsUtc: new Date().toISOString(),
    price: 60000, technicalScore: 0.5, fundamentalScore: 0.5, finalScore: 0.5,
    status: 'BUY', confidence: 0.8, reasonsJson: '[]', technicalSummaryJson: '{}', fundamentalSummaryJson: '{}',
    entry: 60000, stopLoss: 50000, takeProfit: 80000, riskRewardRatio: 2, dataQuality: 'good', warningsJson: '[]',
    strategyVersion: '1.0.0', strategyId: 'momentum', sourceMode: 'demo',
  });
}

function insertCombinedStrategySignal({ id, symbol }) {
  signalsRepository.insertSignal({
    id, symbol, exchange: 'kucoin', timeframe: '1h', tsUtc: new Date().toISOString(),
    price: 60000, technicalScore: 0.5, fundamentalScore: 0.5, finalScore: 0.5,
    status: 'BUY', confidence: 0.8, reasonsJson: '[]', technicalSummaryJson: '{}', fundamentalSummaryJson: '{}',
    entry: 60000, stopLoss: 50000, takeProfit: 80000, riskRewardRatio: 2, dataQuality: 'good', warningsJson: '[]',
    strategyVersion: '1.0.0', strategyId: 'trend-following+momentum', sourceMode: 'demo',
    combinedStrategyIds: JSON.stringify(['trend-following', 'momentum']),
    combinedVotes: JSON.stringify({ 'trend-following': 'BUY', momentum: 'BUY' }),
  });
}

test('futures position records the single strategy that opened it via signalId', async (t) => {
  resetForTests();
  const userId = usersRepository.createUser('strategy-tracking-futures-1', 'hash').id;
  const { placeDemoFuturesOrder } = require('../../src/services/orders/futures-demo-orders');
  const futuresPortfolioService = require('../../src/services/portfolio/futures-portfolio-service');
  const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
  futuresPortfolioRepository.ensureInitialized('demo', userId, 10000);
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockFuturesPrice(60000));

  insertSingleStrategySignal({ id: 'sig-1', symbol: 'BTC/USDT:USDT' });

  const order = await placeDemoFuturesOrder({
    userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000,
    signalId: 'sig-1', source: 'auto',
  });
  assert.equal(order.status, 'filled');

  const [position] = await futuresPortfolioService.getOpenPositionsWithUnrealizedPnl('demo', userId);
  assert.equal(position.signal_id, 'sig-1');
  assert.equal(position.strategy_id, 'momentum');
  assert.equal(position.source, 'auto');
  assert.deepEqual(position.strategies, [{ id: 'momentum', name: 'Momentum' }]);
});

test('futures position records every contributing strategy for a combined (auto-mode) signal', async (t) => {
  resetForTests();
  const userId = usersRepository.createUser('strategy-tracking-futures-2', 'hash').id;
  const { placeDemoFuturesOrder } = require('../../src/services/orders/futures-demo-orders');
  const futuresPortfolioService = require('../../src/services/portfolio/futures-portfolio-service');
  const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
  futuresPortfolioRepository.ensureInitialized('demo', userId, 10000);
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockFuturesPrice(60000));

  insertCombinedStrategySignal({ id: 'sig-combined-1', symbol: 'BTC/USDT:USDT' });

  const order = await placeDemoFuturesOrder({
    userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000,
    signalId: 'sig-combined-1', source: 'auto',
  });
  assert.equal(order.status, 'filled');

  const [position] = await futuresPortfolioService.getOpenPositionsWithUnrealizedPnl('demo', userId);
  assert.equal(position.strategy_id, 'trend-following+momentum');
  assert.deepEqual(JSON.parse(position.combined_votes_json), { 'trend-following': 'BUY', momentum: 'BUY' });
  assert.deepEqual(position.strategies, [
    { id: 'trend-following', name: 'Trend Following' },
    { id: 'momentum', name: 'Momentum' },
  ]);
});

test('a manual futures order with no signalId leaves the position strategy fields empty', async (t) => {
  resetForTests();
  const userId = usersRepository.createUser('strategy-tracking-futures-3', 'hash').id;
  const { placeDemoFuturesOrder } = require('../../src/services/orders/futures-demo-orders');
  const futuresPortfolioService = require('../../src/services/portfolio/futures-portfolio-service');
  const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
  futuresPortfolioRepository.ensureInitialized('demo', userId, 10000);
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockFuturesPrice(60000));

  const order = await placeDemoFuturesOrder({
    userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000,
  });
  assert.equal(order.status, 'filled');

  const [position] = await futuresPortfolioService.getOpenPositionsWithUnrealizedPnl('demo', userId);
  assert.equal(position.signal_id, null);
  assert.equal(position.strategy_id, null);
  assert.equal(position.source, 'manual');
  assert.deepEqual(position.strategies, []);
});

test('spot position records the strategy that opened it via signalId', async (t) => {
  resetForTests();
  const userId = usersRepository.createUser('strategy-tracking-spot-1', 'hash').id;
  const { placeDemoOrder } = require('../../src/services/orders/demo-orders');
  const portfolioService = require('../../src/services/portfolio/portfolio-service');
  const portfolioRepository = require('../../src/database/repositories/portfolio-repository');
  portfolioRepository.ensureInitialized('demo', userId, 10000);
  t.mock.method(marketDataService, 'getSnapshot', async () => mockSpotPrice(60000));

  insertSingleStrategySignal({ id: 'spot-sig-1', symbol: 'BTC/USDT' });

  const order = await placeDemoOrder({
    userId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 50000, takeProfit: 80000,
    signalId: 'spot-sig-1',
  });
  assert.equal(order.status, 'filled');

  const [position] = await portfolioService.getOpenPositionsWithUnrealizedPnl('demo', userId);
  assert.equal(position.signal_id, 'spot-sig-1');
  assert.equal(position.strategy_id, 'momentum');
  assert.deepEqual(position.strategies, [{ id: 'momentum', name: 'Momentum' }]);
});
