'use strict';

// Spot-engine counterpart to reversal-walk-forward.js — same sequential, fixed-config,
// no-per-window-re-optimization design (see that file's header comment for the full rationale).
// Only the LSR side had a walk-forward runner until now; this covers the weighted-indicator
// strategies backtest-engine.js drives, including adaptive-TP configs via the same optional
// `adaptiveTpConfig` passthrough backtest-engine.js#simulateStrategy already supports.

const { fetchCandlesForBacktest, simulateStrategy, buildScoringConfig } = require('./backtest-engine');
const { computeMetrics } = require('./metrics');
const { getStrategy, DEFAULT_STRATEGY_ID } = require('../signals/strategies');
const { splitIntoWindows } = require('./reversal-walk-forward');

function mean(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

async function runSpotWalkForward({
  symbol,
  exchange,
  timeframe = '1h',
  market = 'spot',
  startUtc,
  endUtc,
  windowCount = 4,
  initialCapital = 10000,
  feePercent = 0.1,
  slippagePercent = 0.05,
  riskSettings = { maxRiskPerTradePercent: 1, minRiskRewardRatio: 1.5 },
  strategyId = DEFAULT_STRATEGY_ID,
  adaptiveTpConfig,
}) {
  if (!Number.isInteger(windowCount) || windowCount < 2) throw new Error('windowCount must be an integer >= 2.');

  const startMs = new Date(startUtc).getTime();
  const endMs = new Date(endUtc).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Invalid walk-forward date range: endUtc must be after startUtc.');
  }

  const strategy = getStrategy(strategyId);
  const { config } = buildScoringConfig(strategy, {});
  const windows = splitIntoWindows(startMs, endMs, windowCount);
  const windowResults = [];

  for (const window of windows) {
    const { candles, startIndex } = await fetchCandlesForBacktest({ symbol, exchange, timeframe, startMs: window.startMs, endMs: window.endMs, market });
    const { trades, equityCurve, warnings } = simulateStrategy({ candles, startIndex, symbol, initialCapital, feePercent, slippagePercent, riskSettings, config, adaptiveTpConfig });
    const metrics = computeMetrics({ trades, equityCurve, initialCapital });
    windowResults.push({
      startUtc: new Date(window.startMs).toISOString(),
      endUtc: new Date(window.endMs).toISOString(),
      metrics,
      warningCount: warnings.length,
    });
  }

  const winRates = windowResults.map((w) => w.metrics.winRatePercent);
  const profitFactors = windowResults.map((w) => w.metrics.profitFactor).filter(Number.isFinite);
  const netPnlPercents = windowResults.map((w) => w.metrics.totalPnlPercent);
  const profitableWindowCount = windowResults.filter((w) => w.metrics.totalPnl > 0).length;

  return {
    symbol, exchange, timeframe, market, startUtc, endUtc, windowCount,
    strategyId: strategy.id, strategyName: strategy.name,
    windows: windowResults,
    aggregate: {
      profitableWindowCount,
      profitableWindowFraction: windowResults.length > 0 ? profitableWindowCount / windowResults.length : 0,
      winRatePercent: { mean: mean(winRates), stdev: stdev(winRates) },
      profitFactor: { mean: mean(profitFactors), stdev: stdev(profitFactors) },
      netPnlPercent: { mean: mean(netPnlPercents), stdev: stdev(netPnlPercents) },
    },
    disclaimer: 'Every window uses the SAME fixed parameters (no per-window re-optimization) — this measures consistency across time, not best-case performance. High variance across windows is a warning sign about robustness, not noise to average away.',
  };
}

module.exports = { runSpotWalkForward };
