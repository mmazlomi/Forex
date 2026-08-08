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
const strategySelector = require('../../src/services/scheduler/strategy-selector');

// Synthetic 15-entry leaderboard (5 strategies x 3 threshold pairs), matching optimizeStrategy's
// real shape — see optimizer.js. Lets tests exercise strategy-selector.js's own ranking/grouping/
// filtering logic without any real network call or real backtest.
function makeLeaderboard(winRateByStrategy, tradeCountByStrategy) {
  const leaderboard = [];
  for (const strategyId of Object.keys(winRateByStrategy)) {
    for (const t of [0.2, 0.3, 0.4]) {
      leaderboard.push({
        strategyId, strategyName: strategyId, buyThreshold: t, sellThreshold: -t,
        metrics: { winRatePercent: winRateByStrategy[strategyId], tradeCount: tradeCountByStrategy[strategyId] },
      });
    }
  }
  return leaderboard;
}

test.beforeEach(() => {
  resetForTests();
});

test('rankStrategiesForAsset groups by strategyId (best threshold-pair per strategy), filters by minimum trade count, and takes the top N by win rate', async (t) => {
  const leaderboard = makeLeaderboard(
    { balanced: 100, 'trend-following': 80, 'mean-reversion': 50, momentum: 75, 'fundamentals-driven': 40 },
    { balanced: 1, 'trend-following': 10, 'mean-reversion': 8, momentum: 12, 'fundamentals-driven': 9 } // balanced: too few trades
  );
  t.mock.method(optimizer, 'optimizeStrategy', async () => ({ leaderboard, combinationsRun: 15 }));

  const selected = await strategySelector.rankStrategiesForAsset({ symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h', market: 'spot' });

  // Default config: strategySelectionCount=3, strategySelectionMinTrades=5 (see config.js).
  assert.deepEqual(selected, ['trend-following', 'momentum', 'mean-reversion']);
});

test('rankStrategiesForAsset returns only the strategies that pass the trade-count gate, even if that leaves just 1 (the >=2-to-persist rule is enforced by its callers, not here)', async (t) => {
  const leaderboard = makeLeaderboard(
    { balanced: 100, 'trend-following': 80, 'mean-reversion': 50, momentum: 75, 'fundamentals-driven': 40 },
    { balanced: 1, 'trend-following': 1, 'mean-reversion': 8, momentum: 1, 'fundamentals-driven': 1 } // only mean-reversion qualifies
  );
  t.mock.method(optimizer, 'optimizeStrategy', async () => ({ leaderboard, combinationsRun: 15 }));

  const selected = await strategySelector.rankStrategiesForAsset({ symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h', market: 'spot' });
  assert.deepEqual(selected, ['mean-reversion']);
});

test('rankStrategiesForAsset returns an empty array when nothing passes the trade-count gate', async (t) => {
  const leaderboard = makeLeaderboard(
    { balanced: 100, 'trend-following': 80, 'mean-reversion': 50, momentum: 75, 'fundamentals-driven': 40 },
    { balanced: 1, 'trend-following': 1, 'mean-reversion': 1, momentum: 1, 'fundamentals-driven': 1 } // nothing qualifies
  );
  t.mock.method(optimizer, 'optimizeStrategy', async () => ({ leaderboard, combinationsRun: 15 }));

  const selected = await strategySelector.rankStrategiesForAsset({ symbol: 'BTC/USDT', exchange: 'kucoin', timeframe: '1h', market: 'spot' });
  assert.deepEqual(selected, []);
});

test('runCycle does NOT persist a selection when fewer than 2 strategies qualify — an asset keeps no selection (or its previous one) rather than a single-strategy "majority of 1"', async (t) => {
  const leaderboard = makeLeaderboard(
    { balanced: 100, 'trend-following': 80, 'mean-reversion': 50, momentum: 75, 'fundamentals-driven': 40 },
    { balanced: 1, 'trend-following': 1, 'mean-reversion': 8, momentum: 1, 'fundamentals-driven': 1 } // only mean-reversion qualifies
  );
  t.mock.method(optimizer, 'optimizeStrategy', async () => ({ leaderboard, combinationsRun: 15 }));

  const user = usersRepository.createUser('under-qualified-test-user', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setStrategyMode(user.id, 'BTC/USDT', 'kucoin', 'auto');

  await strategySelector.runCycle();

  const asset = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(asset.selected_strategy_ids_json, null);
  assert.equal(asset.strategy_selection_updated_at_utc, null);
});

test('runCycle only updates auto-mode assets, leaves manual-mode assets untouched, and keeps spot/demo-futures/real-futures fully separate', async (t) => {
  const leaderboard = makeLeaderboard(
    { balanced: 70, 'trend-following': 65, 'mean-reversion': 60, momentum: 55, 'fundamentals-driven': 50 },
    { balanced: 10, 'trend-following': 10, 'mean-reversion': 10, momentum: 10, 'fundamentals-driven': 10 }
  );
  t.mock.method(optimizer, 'optimizeStrategy', async () => ({ leaderboard, combinationsRun: 15 }));

  const user = usersRepository.createUser('cycle-test-user', 'irrelevant-hash');

  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setStrategyMode(user.id, 'BTC/USDT', 'kucoin', 'auto');
  assetsRepository.addAsset(user.id, { symbol: 'ETH/USDT', exchange: 'kucoin', assetType: 'crypto' }); // stays manual

  futuresAssetsRepository.addAsset('demo', user.id, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin' });
  futuresAssetsRepository.setStrategyMode('demo', user.id, 'BTC/USDT:USDT', 'kucoin', 'auto');
  futuresAssetsRepository.addAsset('real', user.id, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin' }); // stays manual

  const result = await strategySelector.runCycle();
  assert.deepEqual(result, { spotEvaluated: 1, demoFuturesEvaluated: 1, realFuturesEvaluated: 0 });

  const btc = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(JSON.parse(btc.selected_strategy_ids_json).length, 3);

  const eth = assetsRepository.getAsset(user.id, 'ETH/USDT', 'kucoin');
  assert.equal(eth.selected_strategy_ids_json, null, 'manual-mode asset must never be touched by the selector');

  const demoFutures = futuresAssetsRepository.getAsset('demo', user.id, 'BTC/USDT:USDT', 'kucoin');
  assert.equal(JSON.parse(demoFutures.selected_strategy_ids_json).length, 3);

  const realFutures = futuresAssetsRepository.getAsset('real', user.id, 'BTC/USDT:USDT', 'kucoin');
  assert.equal(realFutures.selected_strategy_ids_json, null);
});

test('a per-asset optimizeStrategy failure (e.g. unreachable exchange) is caught and skipped, without blocking other assets in the same cycle', async (t) => {
  const user = usersRepository.createUser('failure-test-user', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setStrategyMode(user.id, 'BTC/USDT', 'kucoin', 'auto');
  assetsRepository.addAsset(user.id, { symbol: 'ETH/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setStrategyMode(user.id, 'ETH/USDT', 'kucoin', 'auto');

  const leaderboard = makeLeaderboard(
    { balanced: 70, 'trend-following': 65, 'mean-reversion': 60, momentum: 55, 'fundamentals-driven': 50 },
    { balanced: 10, 'trend-following': 10, 'mean-reversion': 10, momentum: 10, 'fundamentals-driven': 10 }
  );
  let call = 0;
  t.mock.method(optimizer, 'optimizeStrategy', async ({ symbol }) => {
    call += 1;
    if (symbol === 'BTC/USDT') throw new Error('simulated exchange failure');
    return { leaderboard, combinationsRun: 15 };
  });

  const result = await strategySelector.runCycle();
  assert.equal(result.spotEvaluated, 2);
  assert.equal(call, 2, 'both assets were attempted despite the first one throwing');

  const btc = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(btc.selected_strategy_ids_json, null, 'failed asset keeps no selection (or its previous one) rather than crashing the cycle');

  const eth = assetsRepository.getAsset(user.id, 'ETH/USDT', 'kucoin');
  assert.equal(JSON.parse(eth.selected_strategy_ids_json).length, 3, 'ETH still went through');
});

test('getStatus reports config values and current auto-mode counts per list', async () => {
  const user = usersRepository.createUser('status-test-user', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setStrategyMode(user.id, 'BTC/USDT', 'kucoin', 'auto');

  const status = strategySelector.getStatus();
  assert.equal(status.spotAutoModeCount, 1);
  assert.equal(status.demoFuturesAutoModeCount, 0);
  assert.equal(status.realFuturesAutoModeCount, 0);
  assert.equal(status.selectionCount, 3);
  assert.equal(status.minTrades, 5);
});
