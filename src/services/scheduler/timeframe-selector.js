'use strict';

const assetsRepository = require('../../database/repositories/assets-repository');
const futuresAssetsRepository = require('../../database/repositories/futures-assets-repository');
const optimizer = require('../backtesting/optimizer');
const logger = require('../logging/logger');
const config = require('../../../config/config');

let intervalHandle = null;
let isRunning = false;

/**
 * Evaluates candidate timeframes (e.g. 15m, 1h, 4h) for one asset over the configured
 * rolling lookback window by optimizing strategies on each candidate.
 * Returns the candidate timeframe string that produced the highest win rate among those
 * passing the minimum-trade-count gate, or null if none qualified.
 */
async function rankTimeframesForAsset({ symbol, exchange, market }) {
  const candidates = config.timeframeCandidates || ['15m', '1h', '4h'];
  const endUtc = new Date().toISOString();
  const startUtc = new Date(Date.now() - config.timeframeSelectionLookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const candidateResults = [];

  for (const timeframe of candidates) {
    try {
      const { leaderboard } = await optimizer.optimizeStrategy({
        symbol,
        exchange,
        timeframe,
        startUtc,
        endUtc,
        rankBy: 'winRatePercent',
        market,
      });

      // Find the best entry for this timeframe that satisfies the min-trades threshold
      const qualifying = (leaderboard || []).filter(
        (entry) => entry.metrics && entry.metrics.tradeCount >= config.timeframeSelectionMinTrades
      );

      if (qualifying.length > 0) {
        // Best entry on this timeframe by winRatePercent (or tiebreak totalPnlPercent)
        qualifying.sort((a, b) => {
          if (b.metrics.winRatePercent !== a.metrics.winRatePercent) {
            return b.metrics.winRatePercent - a.metrics.winRatePercent;
          }
          return b.metrics.totalPnlPercent - a.metrics.totalPnlPercent;
        });

        const best = qualifying[0];
        candidateResults.push({
          timeframe,
          winRatePercent: best.metrics.winRatePercent,
          totalPnlPercent: best.metrics.totalPnlPercent,
          tradeCount: best.metrics.tradeCount,
        });
      }
    } catch (err) {
      logger.warn('timeframe-selector', `Timeframe candidate ${timeframe} failed for ${symbol}@${exchange} (${market}): ${err.message}`);
    }
  }

  if (candidateResults.length === 0) return null;

  candidateResults.sort((a, b) => {
    if (b.winRatePercent !== a.winRatePercent) {
      return b.winRatePercent - a.winRatePercent;
    }
    return b.totalPnlPercent - a.totalPnlPercent;
  });

  return candidateResults[0].timeframe;
}

async function processSpotAsset(asset) {
  const label = `${asset.symbol}@${asset.exchange} (spot, user ${asset.user_id})`;
  try {
    const selected = await rankTimeframesForAsset({
      symbol: asset.symbol,
      exchange: asset.exchange,
      market: 'spot',
    });
    if (!selected) {
      logger.debug('timeframe-selector', `Skipped timeframe update for ${label}: no candidate passed the minimum trade-count gate — leaving previous timeframe in place.`);
      return;
    }
    assetsRepository.setAutoSelectedTimeframe(asset.user_id, asset.symbol, asset.exchange, selected);
    logger.info('timeframe-selector', `Auto-selected timeframe ${selected} for ${label}`);
  } catch (err) {
    logger.error('timeframe-selector', `Timeframe selection cycle failed for ${label}: ${err.message}`);
  }
}

async function processFuturesAsset(mode, asset) {
  const label = `${asset.symbol}@${asset.exchange} (futures ${mode}, user ${asset.user_id})`;
  try {
    const selected = await rankTimeframesForAsset({
      symbol: asset.symbol,
      exchange: asset.exchange,
      market: 'futures',
    });
    if (!selected) {
      logger.debug('timeframe-selector', `Skipped timeframe update for ${label}: no candidate passed the minimum trade-count gate — leaving previous timeframe in place.`, {}, mode);
      return;
    }
    futuresAssetsRepository.setAutoSelectedTimeframe(mode, asset.user_id, asset.symbol, asset.exchange, selected);
    logger.info('timeframe-selector', `Auto-selected timeframe ${selected} for ${label}`, {}, mode);
  } catch (err) {
    logger.error('timeframe-selector', `Timeframe selection cycle failed for ${label}: ${err.message}`, {}, mode);
  }
}

/** Exported directly so it can be triggered on-demand (e.g. from a test or a manual "run now"). */
async function runCycle() {
  const spotAssets = assetsRepository.listAutoTimeframeAssets();
  const demoFuturesAssets = futuresAssetsRepository.listAutoTimeframeAssets('demo');
  const realFuturesAssets = futuresAssetsRepository.listAutoTimeframeAssets('real');

  const total = spotAssets.length + demoFuturesAssets.length + realFuturesAssets.length;
  if (total > 0) {
    logger.debug('timeframe-selector', `Running timeframe selection cycle: ${spotAssets.length} spot, ${demoFuturesAssets.length} demo futures, ${realFuturesAssets.length} real futures asset(s)`);
  }

  for (const asset of spotAssets) await processSpotAsset(asset);
  for (const asset of demoFuturesAssets) await processFuturesAsset('demo', asset);
  for (const asset of realFuturesAssets) await processFuturesAsset('real', asset);

  return {
    spotEvaluated: spotAssets.length,
    demoFuturesEvaluated: demoFuturesAssets.length,
    realFuturesEvaluated: realFuturesAssets.length,
  };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (isRunning) {
      logger.warn('timeframe-selector', 'Skipped timeframe selection cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('timeframe-selector', `Timeframe selection cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.timeframeSelectionIntervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('timeframe-selector', `Timeframe selector started (interval ${config.timeframeSelectionIntervalMs}ms, lookback ${config.timeframeSelectionLookbackDays}d)`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function getStatus() {
  return {
    running: intervalHandle !== null,
    intervalMs: config.timeframeSelectionIntervalMs,
    lookbackDays: config.timeframeSelectionLookbackDays,
    minTrades: config.timeframeSelectionMinTrades,
    candidates: config.timeframeCandidates || ['15m', '1h', '4h'],
    spotAutoModeCount: assetsRepository.listAutoTimeframeAssets().length,
    demoFuturesAutoModeCount: futuresAssetsRepository.listAutoTimeframeAssets('demo').length,
    realFuturesAutoModeCount: futuresAssetsRepository.listAutoTimeframeAssets('real').length,
  };
}

module.exports = {
  start,
  stop,
  runCycle,
  getStatus,
  rankTimeframesForAsset,
};
