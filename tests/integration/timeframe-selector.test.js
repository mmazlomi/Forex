'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const usersRepository = require('../../src/database/repositories/users-repository');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');
const optimizer = require('../../src/services/backtesting/optimizer');
const timeframeSelector = require('../../src/services/scheduler/timeframe-selector');

function makeLeaderboardForTf(timeframe, winRate, tradeCount, totalPnlPercent = 10) {
  return [
    {
      strategyId: 'balanced',
      strategyName: 'Balanced',
      buyThreshold: 0.3,
      sellThreshold: -0.3,
      metrics: {
        winRatePercent: winRate,
        tradeCount,
        totalPnlPercent,
      },
    },
  ];
}

test.beforeEach(() => {
  resetForTests();
});

test('rankTimeframesForAsset evaluates candidates and returns the timeframe with the highest win rate meeting min trades', async (t) => {
  t.mock.method(optimizer, 'optimizeStrategy', async ({ timeframe }) => {
    if (timeframe === '15m') {
      return { leaderboard: makeLeaderboardForTf('15m', 55, 10) };
    }
    if (timeframe === '1h') {
      return { leaderboard: makeLeaderboardForTf('1h', 75, 8) };
    }
    if (timeframe === '4h') {
      return { leaderboard: makeLeaderboardForTf('4h', 65, 6) };
    }
    return { leaderboard: [] };
  });

  const selected = await timeframeSelector.rankTimeframesForAsset({
    symbol: 'BTC/USDT',
    exchange: 'kucoin',
    market: 'spot',
  });

  assert.equal(selected, '1h');
});

test('rankTimeframesForAsset ignores candidates with trade count below minimum', async (t) => {
  t.mock.method(optimizer, 'optimizeStrategy', async ({ timeframe }) => {
    if (timeframe === '15m') {
      // High win rate but only 2 trades (below min 5)
      return { leaderboard: makeLeaderboardForTf('15m', 90, 2) };
    }
    if (timeframe === '1h') {
      // 60% win rate with 10 trades
      return { leaderboard: makeLeaderboardForTf('1h', 60, 10) };
    }
    return { leaderboard: [] };
  });

  const selected = await timeframeSelector.rankTimeframesForAsset({
    symbol: 'BTC/USDT',
    exchange: 'kucoin',
    market: 'spot',
  });

  assert.equal(selected, '1h');
});

test('rankTimeframesForAsset returns null when no candidate qualifies', async (t) => {
  t.mock.method(optimizer, 'optimizeStrategy', async () => {
    return { leaderboard: makeLeaderboardForTf('1h', 80, 1) }; // only 1 trade
  });

  const selected = await timeframeSelector.rankTimeframesForAsset({
    symbol: 'BTC/USDT',
    exchange: 'kucoin',
    market: 'spot',
  });

  assert.equal(selected, null);
});

test('rankTimeframesForAsset catches per-candidate failure gracefully without failing whole ranking', async (t) => {
  t.mock.method(optimizer, 'optimizeStrategy', async ({ timeframe }) => {
    if (timeframe === '15m') {
      throw new Error('Exchange rate limit simulated');
    }
    if (timeframe === '1h') {
      return { leaderboard: makeLeaderboardForTf('1h', 70, 7) };
    }
    return { leaderboard: [] };
  });

  const selected = await timeframeSelector.rankTimeframesForAsset({
    symbol: 'BTC/USDT',
    exchange: 'kucoin',
    market: 'spot',
  });

  assert.equal(selected, '1h');
});

test('runCycle updates default_timeframe only for auto-mode assets across spot, demo futures, and real futures', async (t) => {
  const user = usersRepository.createUser('tf-cycle-user', 'hash');

  // Spot asset: auto mode
  assetsRepository.addAsset(user.id, {
    symbol: 'BTC/USDT',
    exchange: 'kucoin',
    market: 'spot',
    assetType: 'crypto',
  });
  assetsRepository.setTimeframe(user.id, 'BTC/USDT', 'kucoin', '15m');
  assetsRepository.setTimeframeMode(user.id, 'BTC/USDT', 'kucoin', 'auto');

  // Spot asset 2: manual mode (should remain untouched)
  assetsRepository.addAsset(user.id, {
    symbol: 'ETH/USDT',
    exchange: 'kucoin',
    market: 'spot',
    assetType: 'crypto',
  });
  assetsRepository.setTimeframe(user.id, 'ETH/USDT', 'kucoin', '15m');
  assetsRepository.setTimeframeMode(user.id, 'ETH/USDT', 'kucoin', 'manual');

  // Demo futures: auto mode
  futuresAssetsRepository.addAsset('demo', user.id, {
    symbol: 'BTC/USDT:USDT',
    exchange: 'kucoin',
    leverage: 3,
  });
  futuresAssetsRepository.setTimeframe('demo', user.id, 'BTC/USDT:USDT', 'kucoin', '15m');
  futuresAssetsRepository.setTimeframeMode('demo', user.id, 'BTC/USDT:USDT', 'kucoin', 'auto');

  t.mock.method(optimizer, 'optimizeStrategy', async ({ timeframe }) => {
    if (timeframe === '4h') {
      return { leaderboard: makeLeaderboardForTf('4h', 85, 10) };
    }
    return { leaderboard: makeLeaderboardForTf(timeframe, 50, 10) };
  });

  const result = await timeframeSelector.runCycle();

  assert.equal(result.spotEvaluated, 1);
  assert.equal(result.demoFuturesEvaluated, 1);
  assert.equal(result.realFuturesEvaluated, 0);

  // Check spot auto asset updated to 4h
  const updatedSpot = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(updatedSpot.default_timeframe, '4h');
  assert.ok(updatedSpot.timeframe_selection_updated_at_utc);

  // Check spot manual asset left at 15m
  const manualSpot = assetsRepository.getAsset(user.id, 'ETH/USDT', 'kucoin');
  assert.equal(manualSpot.default_timeframe, '15m');

  // Check demo futures asset updated to 4h
  const updatedDemo = futuresAssetsRepository.getAsset('demo', user.id, 'BTC/USDT:USDT', 'kucoin');
  assert.equal(updatedDemo.default_timeframe, '4h');
  assert.ok(updatedDemo.timeframe_selection_updated_at_utc);
});

test('getStatus reports configuration and auto-mode asset counts', () => {
  const status = timeframeSelector.getStatus();
  assert.equal(typeof status.running, 'boolean');
  assert.ok(status.intervalMs >= 3600000);
  assert.ok(Array.isArray(status.candidates));
  assert.equal(typeof status.spotAutoModeCount, 'number');
  assert.equal(typeof status.demoFuturesAutoModeCount, 'number');
  assert.equal(typeof status.realFuturesAutoModeCount, 'number');
});
