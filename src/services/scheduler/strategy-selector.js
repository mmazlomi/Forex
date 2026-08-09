'use strict';

const assetsRepository = require('../../database/repositories/assets-repository');
const futuresAssetsRepository = require('../../database/repositories/futures-assets-repository');
// Accessed via the namespace object (optimizer.optimizeStrategy(...) below), not destructured —
// this project's tests mock exchange/backtest functions via t.mock.method(moduleObject, 'fn',
// ...), which only intercepts property access, not a destructured local reference captured at
// require-time.
const optimizer = require('../backtesting/optimizer');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// Structural twin of auto-trader.js/pending-orders-watcher.js: same start/stop/runCycle/getStatus
// shape, same .unref()'d setInterval, same per-row try/catch so one asset's failure never blocks
// the rest of the cycle. Unlike those schedulers, this one never places an order and carries zero
// trading risk on its own — it only decides which strategy config a LATER live signal gets scored
// with (see signals/index.js's generateCombinedSignal, consumed by auto-trader.js/
// futures-auto-trader.js). Comparatively expensive (a real backtest per asset), hence the much
// longer default interval — see config.js's strategySelectionIntervalMs.

let intervalHandle = null;
let isRunning = false;

/**
 * Ranks every built-in strategy for one asset by backtested win rate over the configured rolling
 * lookback window, returning the top strategySelectionCount ids that pass the minimum-trade-count
 * quality gate (fewer than 2 qualifying strategies -> empty array, since majority voting needs at
 * least 2). Reuses optimizer.js's existing grid search unmodified (5 strategies x 3 threshold
 * pairs = 15 combos in one fetch-once call) and groups its leaderboard by strategyId, taking each
 * strategy's own best-performing threshold-pair entry as that strategy's representative win rate.
 * The winning threshold pair itself is discarded — live signal generation for a selected strategy
 * always uses that strategy's own canonical default thresholds (getStrategy(id) in
 * strategies.js), not whatever threshold variant happened to backtest best. This deliberately
 * keeps "strategy" a stable, named, interpretable concept rather than also free-optimizing
 * thresholds, which would compound the overfitting risk the optimizer's own disclaimer already
 * warns about — and it's worth remembering the backtest ranking itself is technical-only
 * (buildScoringConfig in backtest-engine.js forces fundamentalWeight to 0 for backtests, since
 * historical fundamentals aren't available), even though live signals for the selected strategies
 * still apply their real technical+fundamental weights.
 */
async function rankStrategiesForAsset({ symbol, exchange, timeframe, market }) {
  const endUtc = new Date().toISOString();
  const startUtc = new Date(Date.now() - config.strategySelectionLookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const { leaderboard } = await optimizer.optimizeStrategy({
    symbol, exchange, timeframe, startUtc, endUtc, rankBy: 'winRatePercent', market,
  });

  const bestPerStrategy = new Map(); // strategyId -> its own highest-winRatePercent leaderboard entry
  for (const entry of leaderboard) {
    const existing = bestPerStrategy.get(entry.strategyId);
    if (!existing || entry.metrics.winRatePercent > existing.metrics.winRatePercent) {
      bestPerStrategy.set(entry.strategyId, entry);
    }
  }

  const qualifying = [...bestPerStrategy.values()].filter((e) => e.metrics.tradeCount >= config.strategySelectionMinTrades);
  qualifying.sort((a, b) => b.metrics.winRatePercent - a.metrics.winRatePercent);

  return qualifying.slice(0, config.strategySelectionCount).map((e) => e.strategyId);
}

async function processSpotAsset(asset) {
  const label = `${asset.symbol}@${asset.exchange} (spot, user ${asset.user_id})`;
  try {
    const selected = await rankStrategiesForAsset({
      symbol: asset.symbol, exchange: asset.exchange, timeframe: asset.default_timeframe || '1h', market: 'spot',
    });
    if (selected.length < 2) {
      logger.debug('strategy-selector', `Skipped selection update for ${label}: only ${selected.length} strategy(ies) passed the minimum trade-count gate — leaving previous selection in place.`);
      return;
    }
    assetsRepository.setSelectedStrategies(asset.user_id, asset.symbol, asset.exchange, selected);
    logger.info('strategy-selector', `Selected [${selected.join(', ')}] for ${label}`);
  } catch (err) {
    logger.error('strategy-selector', `Selection cycle failed for ${label}: ${err.message}`);
  }
}

async function processFuturesAsset(mode, asset) {
  const label = `${asset.symbol}@${asset.exchange} (futures ${mode}, user ${asset.user_id})`;
  try {
    const selected = await rankStrategiesForAsset({
      symbol: asset.symbol, exchange: asset.exchange, timeframe: asset.default_timeframe || '1h', market: 'futures',
    });
    if (selected.length < 2) {
      logger.debug('strategy-selector', `Skipped selection update for ${label}: only ${selected.length} strategy(ies) passed the minimum trade-count gate — leaving previous selection in place.`, {}, mode);
      return;
    }
    futuresAssetsRepository.setSelectedStrategies(mode, asset.user_id, asset.symbol, asset.exchange, selected);
    logger.info('strategy-selector', `Selected [${selected.join(', ')}] for ${label}`, {}, mode);
  } catch (err) {
    // KuCoin's futures API is confirmed flaky/unreachable from some deployment hosts — a failure
    // here (including a timeout) is an accepted, expected outcome, not a bug; the previous
    // selection (or none) simply stays in place until a later cycle succeeds.
    logger.error('strategy-selector', `Selection cycle failed for ${label}: ${err.message}`, {}, mode);
  }
}

/** Exported directly so it can be triggered on-demand (e.g. from a test or a manual "run now"). */
async function runCycle() {
  const spotAssets = assetsRepository.listAutoStrategyModeAssets();
  const demoFuturesAssets = futuresAssetsRepository.listAutoStrategyModeAssets('demo');
  const realFuturesAssets = futuresAssetsRepository.listAutoStrategyModeAssets('real');

  const total = spotAssets.length + demoFuturesAssets.length + realFuturesAssets.length;
  if (total > 0) {
    logger.debug('strategy-selector', `Running strategy-selection cycle: ${spotAssets.length} spot, ${demoFuturesAssets.length} demo futures, ${realFuturesAssets.length} real futures asset(s)`);
  }

  for (const asset of spotAssets) await processSpotAsset(asset);
  for (const asset of demoFuturesAssets) await processFuturesAsset('demo', asset);
  for (const asset of realFuturesAssets) await processFuturesAsset('real', asset);

  return { spotEvaluated: spotAssets.length, demoFuturesEvaluated: demoFuturesAssets.length, realFuturesEvaluated: realFuturesAssets.length };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    // See auto-trader.js's identical guard: prevents overlapping cycles from piling up when a
    // cycle takes longer than the interval (each asset runs a real backtest, so this is the
    // most expensive of the five schedulers per cycle).
    if (isRunning) {
      logger.warn('strategy-selector', 'Skipped strategy-selection cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('strategy-selector', `Strategy-selection cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.strategySelectionIntervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('strategy-selector', `Strategy selector started (interval ${config.strategySelectionIntervalMs}ms, top ${config.strategySelectionCount} by win rate over a ${config.strategySelectionLookbackDays}d rolling lookback)`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function getStatus() {
  return {
    running: intervalHandle !== null,
    intervalMs: config.strategySelectionIntervalMs,
    lookbackDays: config.strategySelectionLookbackDays,
    selectionCount: config.strategySelectionCount,
    minTrades: config.strategySelectionMinTrades,
    spotAutoModeCount: assetsRepository.listAutoStrategyModeAssets().length,
    demoFuturesAutoModeCount: futuresAssetsRepository.listAutoStrategyModeAssets('demo').length,
    realFuturesAutoModeCount: futuresAssetsRepository.listAutoStrategyModeAssets('real').length,
  };
}

module.exports = { start, stop, runCycle, getStatus, rankStrategiesForAsset };
