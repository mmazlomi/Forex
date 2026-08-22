'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const usersRepository = require('../../src/database/repositories/users-repository');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');
const reversalBacktestEngine = require('../../src/services/backtesting/reversal-backtest-engine');
const lsrTimeframeSelector = require('../../src/services/scheduler/lsr-timeframe-selector');

const { STRATEGY_ID: LSR_STRATEGY_ID } = reversalBacktestEngine;

function fakeTrades(count, pnlEach) {
  return Array.from({ length: count }, (_, i) => ({
    symbol: 'BTC/USDT', side: 'long', entryPrice: 100, exitPrice: 100 + pnlEach, qty: 1,
    enteredAtUtc: new Date(2026, 0, i + 1).toISOString(), exitedAtUtc: new Date(2026, 0, i + 1).toISOString(),
    pnl: pnlEach, exitReason: pnlEach > 0 ? 'take_profit' : 'stop_loss',
  }));
}

function fakeEquityCurve(trades, initialCapital = 10000) {
  let equity = initialCapital;
  return trades.map((t) => { equity += t.pnl; return { tsUtc: t.exitedAtUtc, equity }; });
}

/** Mocks fetchReversalCandles/simulateReversalStrategy so every candidate timeframe combo in
 *  CANDIDATE_TIMEFRAMES resolves deterministically without any real network/backtest — keyed by
 *  htfTimeframe so each test can give different candidates different (or zero) trade histories. */
function mockBacktest(t, tradesByHtf) {
  t.mock.method(reversalBacktestEngine, 'fetchReversalCandles', async ({ config }) => ({
    entryStepMs: 5 * 60 * 1000, htfTimeframe: config.htfTimeframe,
  }));
  t.mock.method(reversalBacktestEngine, 'simulateReversalStrategy', ({ config }) => {
    const trades = tradesByHtf[config.htfTimeframe] || [];
    return { trades, equityCurve: fakeEquityCurve(trades), warnings: [] };
  });
}

test.beforeEach(() => {
  resetForTests();
});

test('rankTimeframesForAsset picks the candidate with the best composite score among those clearing the minimum trade-count gate', async (t) => {
  mockBacktest(t, {
    '4h': fakeTrades(15, 5),   // default candidate: modest, consistent wins, enough trades
    '1h': fakeTrades(15, 20),  // best: bigger wins, same trade count
    '1d': fakeTrades(2, 100),  // huge win but only 2 trades — disqualified by the min-trade gate
  });

  const selected = await lsrTimeframeSelector.rankTimeframesForAsset({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'futures' });
  assert.ok(selected);
  assert.equal(selected.htfTimeframe, '1h');
});

test('rankTimeframesForAsset returns null when no candidate clears the minimum trade-count gate', async (t) => {
  mockBacktest(t, {
    '4h': fakeTrades(1, 5),
    '1h': fakeTrades(2, 5),
  });

  const selected = await lsrTimeframeSelector.rankTimeframesForAsset({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'futures' });
  assert.equal(selected, null);
});

test('rankTimeframesForAsset never optimizes for raw profit alone — a lower-drawdown/higher-Sharpe candidate can beat a bigger-but-choppier one', async (t) => {
  // Same net trade count and average win, but '1h' has one huge loss mixed in (bigger drawdown,
  // worse Sharpe) while '4h' is steady.
  const steady = fakeTrades(12, 10);
  const choppy = [...fakeTrades(11, 12), { symbol: 'BTC/USDT', side: 'long', entryPrice: 100, exitPrice: 40, qty: 1, enteredAtUtc: '2026-01-01', exitedAtUtc: '2026-01-02', pnl: -500, exitReason: 'stop_loss' }];
  mockBacktest(t, { '4h': steady, '1h': choppy });

  const selected = await lsrTimeframeSelector.rankTimeframesForAsset({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'futures' });
  assert.equal(selected.htfTimeframe, '4h');
});

test('a per-candidate backtest failure is caught and that candidate is simply excluded, without crashing the whole selection', async (t) => {
  t.mock.method(reversalBacktestEngine, 'fetchReversalCandles', async ({ config }) => {
    if (config.htfTimeframe === '4h') throw new Error('simulated exchange failure');
    return { entryStepMs: 5 * 60 * 1000, htfTimeframe: config.htfTimeframe };
  });
  t.mock.method(reversalBacktestEngine, 'simulateReversalStrategy', ({ config }) => {
    const trades = config.htfTimeframe === '1h' ? fakeTrades(12, 10) : [];
    return { trades, equityCurve: fakeEquityCurve(trades), warnings: [] };
  });

  const selected = await lsrTimeframeSelector.rankTimeframesForAsset({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'futures' });
  assert.ok(selected);
  assert.equal(selected.htfTimeframe, '1h');
});

test('runCycle only updates lsr_timeframe_mode="auto" assets, leaves manual assets untouched, and keeps spot/demo-futures/real-futures separate', async (t) => {
  mockBacktest(t, { '4h': fakeTrades(12, 10) });

  const user = usersRepository.createUser('lsr-tf-cycle-user', 'irrelevant-hash');

  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setStrategy(user.id, 'BTC/USDT', 'kucoin', LSR_STRATEGY_ID);
  assetsRepository.setLsrTimeframeMode(user.id, 'BTC/USDT', 'kucoin', 'auto');

  assetsRepository.addAsset(user.id, { symbol: 'ETH/USDT', exchange: 'kucoin', assetType: 'crypto' }); // stays manual

  futuresAssetsRepository.addAsset('demo', user.id, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin' });
  futuresAssetsRepository.setLsrTimeframeMode('demo', user.id, 'BTC/USDT:USDT', 'kucoin', 'auto');
  futuresAssetsRepository.addAsset('real', user.id, { symbol: 'BTC/USDT:USDT', exchange: 'kucoin' }); // stays manual

  const result = await lsrTimeframeSelector.runCycle();
  assert.deepEqual(result, { spotEvaluated: 1, demoFuturesEvaluated: 1, realFuturesEvaluated: 0 });

  const btc = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.ok(btc.lsr_selected_timeframes_json);
  assert.equal(JSON.parse(btc.lsr_selected_timeframes_json).htfTimeframe, '4h');
  assert.ok(btc.lsr_timeframe_selection_updated_at_utc);

  const eth = assetsRepository.getAsset(user.id, 'ETH/USDT', 'kucoin');
  assert.equal(eth.lsr_selected_timeframes_json, null, 'manual-mode asset must never be touched');

  const demoFutures = futuresAssetsRepository.getAsset('demo', user.id, 'BTC/USDT:USDT', 'kucoin');
  assert.ok(demoFutures.lsr_selected_timeframes_json);

  const realFutures = futuresAssetsRepository.getAsset('real', user.id, 'BTC/USDT:USDT', 'kucoin');
  assert.equal(realFutures.lsr_selected_timeframes_json, null);
});

test('runCycle leaves a previous selection in place (does not overwrite with null) when a later cycle qualifies nothing', async (t) => {
  const user = usersRepository.createUser('lsr-tf-keep-user', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setStrategy(user.id, 'BTC/USDT', 'kucoin', LSR_STRATEGY_ID);
  assetsRepository.setLsrTimeframeMode(user.id, 'BTC/USDT', 'kucoin', 'auto');
  assetsRepository.setLsrSelectedTimeframes(user.id, 'BTC/USDT', 'kucoin', { htfTimeframe: '4h', signalTimeframe: '15m', entryTimeframe: '5m' });

  mockBacktest(t, {}); // nothing qualifies this cycle
  await lsrTimeframeSelector.runCycle();

  const btc = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(JSON.parse(btc.lsr_selected_timeframes_json).htfTimeframe, '4h', 'previous selection must survive a cycle that qualifies nothing');
});

test('resolveLsrConfigOverrides-equivalent: setLsrManualTimeframes persists a per-asset override independent of setLsrSelectedTimeframes', () => {
  const user = usersRepository.createUser('lsr-tf-manual-user', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setLsrManualTimeframes(user.id, 'BTC/USDT', 'kucoin', { htfTimeframe: '1d', signalTimeframe: '4h', entryTimeframe: '1h' });

  const asset = assetsRepository.getAsset(user.id, 'BTC/USDT', 'kucoin');
  assert.equal(asset.lsr_htf_timeframe, '1d');
  assert.equal(asset.lsr_signal_timeframe, '4h');
  assert.equal(asset.lsr_entry_timeframe, '1h');
  assert.equal(asset.lsr_timeframe_mode, 'manual', 'setting a manual override does not itself flip the mode to auto');
});

test('getStatus reports config values and current auto-mode counts per list', async () => {
  const user = usersRepository.createUser('lsr-tf-status-user', 'irrelevant-hash');
  assetsRepository.addAsset(user.id, { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' });
  assetsRepository.setLsrTimeframeMode(user.id, 'BTC/USDT', 'kucoin', 'auto');

  const status = lsrTimeframeSelector.getStatus();
  assert.equal(status.spotAutoModeCount, 1);
  assert.equal(status.demoFuturesAutoModeCount, 0);
  assert.equal(status.realFuturesAutoModeCount, 0);
  assert.equal(status.lookbackDays, 90);
  assert.equal(status.minTrades, 3);
  assert.equal(status.candidateCount, lsrTimeframeSelector.CANDIDATE_TIMEFRAMES.length);
});
