'use strict';

const { fetchCandlesForBacktest, simulateStrategy, buildScoringConfig } = require('./backtest-engine');
const { computeMetrics } = require('./metrics');
const { listStrategies, getStrategy } = require('../signals/strategies');
const logger = require('../logging/logger');

const MAX_COMBINATIONS = 60; // keep a run bounded — this is grid search, not a real optimizer

/**
 * "Hyperopt-lite": grid-search parameter optimization over the existing backtest engine.
 * Real Freqtrade-style hyperopt uses Bayesian search (scikit-optimize) over a much larger
 * space; this is a deliberately simpler, dependency-free equivalent — it fetches historical
 * candles ONCE, then re-runs the pure, in-memory simulateStrategy() for every combination in
 * the grid (every named strategy × every buy/sell threshold pair by default, or a caller-
 * supplied grid), ranking results by net P&L % by default. Never places any order, demo or
 * real — this is pure historical simulation, same guarantee as a regular backtest.
 */
async function optimizeStrategy({
  symbol,
  exchange,
  timeframe = '1h',
  startUtc,
  endUtc,
  initialCapital = 10000,
  feePercent = 0.1,
  slippagePercent = 0.05,
  riskSettings = { maxRiskPerTradePercent: 1, minRiskRewardRatio: 1.5 },
  strategyIds, // optional: subset of strategies to try; defaults to all built-ins
  thresholdGrid, // optional: [{buyThreshold, sellThreshold}, ...]; defaults to a small spread
  rankBy = 'totalPnlPercent', // one of computeMetrics()'s numeric fields
  market = 'spot', // 'spot' (default, unchanged behavior) | 'futures' — see fetchCandlesForBacktest
}) {
  const startMs = new Date(startUtc).getTime();
  const endMs = new Date(endUtc).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Invalid optimization date range: endUtc must be after startUtc.');
  }

  const candidateStrategyIds = strategyIds?.length ? strategyIds : listStrategies().map((s) => s.id);
  const candidateThresholds = thresholdGrid?.length
    ? thresholdGrid
    : [
        { buyThreshold: 0.2, sellThreshold: -0.2 },
        { buyThreshold: 0.3, sellThreshold: -0.3 },
        { buyThreshold: 0.4, sellThreshold: -0.4 },
      ];

  const combinations = [];
  for (const strategyId of candidateStrategyIds) {
    for (const thresholds of candidateThresholds) {
      combinations.push({ strategyId, ...thresholds });
    }
  }
  if (combinations.length > MAX_COMBINATIONS) {
    throw new Error(`Requested grid has ${combinations.length} combinations, exceeding the limit of ${MAX_COMBINATIONS} — narrow strategyIds/thresholdGrid.`);
  }

  // Fetched once and reused for every combination — the whole point of separating
  // fetchCandlesForBacktest() from simulateStrategy() in backtest-engine.js.
  const { candles, startIndex } = await fetchCandlesForBacktest({ symbol, exchange, timeframe, startMs, endMs, market });

  const results = [];
  for (const combo of combinations) {
    const strategy = getStrategy(combo.strategyId);
    const { config } = buildScoringConfig(strategy, { buyThreshold: combo.buyThreshold, sellThreshold: combo.sellThreshold });

    try {
      const { trades, equityCurve } = simulateStrategy({
        candles, startIndex, symbol, initialCapital, feePercent, slippagePercent, riskSettings, config,
      });
      const metrics = computeMetrics({ trades, equityCurve, initialCapital });
      results.push({ strategyId: strategy.id, strategyName: strategy.name, buyThreshold: combo.buyThreshold, sellThreshold: combo.sellThreshold, metrics });
    } catch (err) {
      logger.warn('optimizer', `Combination ${strategy.id}/${combo.buyThreshold} failed: ${err.message}`);
    }
  }

  results.sort((a, b) => (b.metrics[rankBy] ?? -Infinity) - (a.metrics[rankBy] ?? -Infinity));

  return {
    symbol, exchange, timeframe, startUtc, endUtc, rankBy,
    combinationsRun: results.length,
    leaderboard: results,
    disclaimer: 'Past performance does not guarantee future results. Optimizing thresholds against historical data risks overfitting to that specific period — always validate on a separate, more recent date range before trusting a result.',
  };
}

module.exports = { optimizeStrategy, MAX_COMBINATIONS };
