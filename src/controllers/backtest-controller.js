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

module.exports = { postBacktest, getBacktest, listBacktests, postOptimize };
