'use strict';

const { runBacktest } = require('../services/backtesting/backtest-engine');
const { optimizeStrategy } = require('../services/backtesting/optimizer');
const backtestRepository = require('../database/repositories/backtest-repository');
const { scoringRejectionReason } = require('../services/signals/strategies');
const { sendSuccess, sendError } = require('../utils/http-response');

async function postBacktest(req, res) {
  const { symbol, exchange, timeframe, start, end, initialCapital, feePercent, slippagePercent, strategyId, scoringConfig } = req.body || {};
  if (!symbol || !exchange || !start || !end) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol, exchange, start, and end are required.');
  }
  // Liquidity Sweep Reversal isn't a weighted scoring config runBacktest() knows how to run —
  // see strategies.js#scoringRejectionReason's comment on the production bug this guards
  // against. Its own dedicated multi-timeframe backtest engine lives in reversal-backtest-engine.js.
  const rejectionReason = scoringRejectionReason(strategyId);
  if (rejectionReason) {
    return sendError(res, 'VALIDATION_ERROR', rejectionReason);
  }

  const result = await runBacktest({
    symbol, exchange, timeframe, startUtc: start, endUtc: end,
    initialCapital, feePercent, slippagePercent, strategyId, scoringConfig,
  });
  sendSuccess(res, result, 'Backtest completed.', 201);
}

async function getBacktest(req, res) {
  const run = backtestRepository.getRun(req.params.runId);
  if (!run) return sendError(res, 'NOT_FOUND', 'Backtest run not found.', 404);
  const trades = backtestRepository.listTrades(run.id);
  const equityCurve = backtestRepository.listEquityCurve(run.id);
  sendSuccess(res, { ...run, metrics: run.metrics_json ? JSON.parse(run.metrics_json) : null, trades, equityCurve });
}

async function listBacktests(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  sendSuccess(res, backtestRepository.listRuns({ limit }));
}

async function postOptimize(req, res) {
  const { symbol, exchange, timeframe, start, end, initialCapital, feePercent, slippagePercent, strategyIds, thresholdGrid, rankBy } = req.body || {};
  if (!symbol || !exchange || !start || !end) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol, exchange, start, and end are required.');
  }
  // Omitted strategyIds defaults (inside optimizeStrategy) to listStrategies(), which already
  // excludes LSR — only an explicit request naming it needs rejecting here.
  if (Array.isArray(strategyIds)) {
    for (const id of strategyIds) {
      const rejectionReason = scoringRejectionReason(id);
      if (rejectionReason) return sendError(res, 'VALIDATION_ERROR', rejectionReason);
    }
  }
  const result = await optimizeStrategy({
    symbol, exchange, timeframe, startUtc: start, endUtc: end,
    initialCapital, feePercent, slippagePercent, strategyIds, thresholdGrid, rankBy,
  });
  sendSuccess(res, result, 'Optimization completed.', 201);
}

const assetsRepository = require('../database/repositories/assets-repository');
const futuresAssetsRepository = require('../database/repositories/futures-assets-repository');
const strategySelector = require('../services/scheduler/strategy-selector');
const timeframeSelector = require('../services/scheduler/timeframe-selector');
const logger = require('../services/logging/logger');
const config = require('../../config/config');

async function getAutoPilotMatrix(req, res) {
  const userId = req.user?.id || 1;
  const spotRows = assetsRepository.listAssets(userId);
  const demoFuturesRows = futuresAssetsRepository.listAssets('demo', userId);
  const realFuturesRows = futuresAssetsRepository.listAssets('real', userId);

  function mapAsset(row, market) {
    let selectedStrategies = [];
    if (row.selected_strategy_ids_json) {
      try {
        selectedStrategies = JSON.parse(row.selected_strategy_ids_json);
      } catch (_) {
        selectedStrategies = [];
      }
    }
    let metrics = null;
    if (row.strategy_selection_metrics_json) {
      try {
        metrics = JSON.parse(row.strategy_selection_metrics_json);
      } catch (_) {
        metrics = null;
      }
    }
    const isAutoPilot = !!(row.autopilot_enabled ?? (row.strategy_mode === 'auto'));
    const isAutoTf = isAutoPilot || row.timeframe_mode === 'auto';
    return {
      market,
      symbol: row.symbol,
      exchange: row.exchange,
      strategyMode: row.strategy_mode || 'manual',
      autopilotEnabled: isAutoPilot,
      timeframe: row.default_timeframe || '1h',
      timeframeMode: isAutoTf ? 'auto' : 'manual',
      strategyId: row.strategy_id || 'balanced',
      selectedStrategies,
      strategySelectionUpdatedAt: row.strategy_selection_updated_at_utc || null,
      evaluated: Array.isArray(selectedStrategies) && selectedStrategies.length > 0,
      metrics,
    };
  }

  const assets = [
    ...spotRows.map((r) => mapAsset(r, 'spot')),
    ...demoFuturesRows.map((r) => mapAsset(r, 'futures-demo')),
    ...realFuturesRows.map((r) => mapAsset(r, 'futures-real')),
  ];

  sendSuccess(res, {
    scheduler: strategySelector.getStatus(),
    config: {
      lookbackDays: config.strategySelectionLookbackDays,
      selectionCount: config.strategySelectionCount,
      minTrades: config.strategySelectionMinTrades,
      intervalMs: config.strategySelectionIntervalMs,
    },
    assets,
  });
}

async function postAutoPilotEvaluate(req, res) {
  const tfResult = await timeframeSelector.runCycle();
  const result = await strategySelector.runCycle();
  sendSuccess(res, { timeframe: tfResult, strategy: result }, 'AutoPilot evaluation cycle completed.');
}

async function postEvaluateAsset(req, res) {
  const userId = req.user?.id || 1;
  const { symbol, exchange, timeframe, market } = req.body || {};
  if (!symbol || !exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol and exchange are required.');
  }
  const isFutures = market === 'futures-demo' || market === 'futures-real' || market === 'futures';
  const marketType = isFutures ? 'futures' : 'spot';

  let asset = null;
  if (market === 'spot') {
    asset = assetsRepository.getAsset(userId, symbol, exchange);
  } else if (market === 'futures-demo') {
    asset = futuresAssetsRepository.getAsset('demo', userId, symbol, exchange);
  } else if (market === 'futures-real') {
    asset = futuresAssetsRepository.getAsset('real', userId, symbol, exchange);
  }

  const isAutoTf = !!(asset?.autopilot_enabled || asset?.timeframe_mode === 'auto');
  let chosenTimeframe = timeframe || asset?.default_timeframe || '1h';

  if (isAutoTf) {
    try {
      const optimal = await timeframeSelector.rankTimeframesForAsset({
        symbol,
        exchange,
        market: marketType,
      });
      if (optimal) {
        chosenTimeframe = optimal;
        if (market === 'spot') {
          assetsRepository.setAutoSelectedTimeframe(userId, symbol, exchange, optimal);
        } else if (market === 'futures-demo') {
          futuresAssetsRepository.setAutoSelectedTimeframe('demo', userId, symbol, exchange, optimal);
        } else if (market === 'futures-real') {
          futuresAssetsRepository.setAutoSelectedTimeframe('real', userId, symbol, exchange, optimal);
        }
      }
    } catch (err) {
      logger.warn('backtest-controller', `Failed to rank timeframes for ${symbol}: ${err.message}`);
    }
  }

  const result = await strategySelector.evaluateAssetWithDetails({
    symbol,
    exchange,
    timeframe: chosenTimeframe,
    market: marketType,
  });

  const metrics = strategySelector.extractMetricsFromDetails(result);
  const selected = result.selected || [];
  const strategiesToSave = selected.length >= 2 ? selected : (metrics.strategies || []).map((s) => s.strategyId);
  if (strategiesToSave.length > 0) {
    if (market === 'spot') {
      assetsRepository.setSelectedStrategies(userId, symbol, exchange, strategiesToSave, metrics);
    } else if (market === 'futures-demo') {
      futuresAssetsRepository.setSelectedStrategies('demo', userId, symbol, exchange, strategiesToSave, metrics);
    } else if (market === 'futures-real') {
      futuresAssetsRepository.setSelectedStrategies('real', userId, symbol, exchange, strategiesToSave, metrics);
    }
  }

  sendSuccess(res, { ...result, timeframe: chosenTimeframe, metrics }, `Evaluated strategies for ${symbol} on ${chosenTimeframe}.`);
}

module.exports = {
  postBacktest,
  getBacktest,
  listBacktests,
  postOptimize,
  getAutoPilotMatrix,
  postAutoPilotEvaluate,
  postEvaluateAsset,
};
