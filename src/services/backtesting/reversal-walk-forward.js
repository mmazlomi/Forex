'use strict';

// Sequential out-of-sample robustness check — see docs/reversal-strategy/IMPLEMENTATION_PLAN.md
// for why Phase 1 ships this deliberately lighter version of "walk-forward validation" rather
// than a full train->optimize->validate loop: in-loop parameter re-optimization per window is
// exactly the overfitting risk the original spec warns against ("do not optimize dozens of
// parameters simultaneously"), and deserves its own careful design rather than being bolted on
// here. This still delivers real evidentiary value: the SAME fixed config is run independently
// against several sequential, non-overlapping historical windows, and the report is built around
// how CONSISTENT the results are across them — a strategy whose win rate/expectancy swings wildly
// window to window is not robust, no matter how good its whole-range aggregate backtest looks.

const { fetchReversalCandles, simulateReversalStrategy, STRATEGY_ID, STRATEGY_VERSION } = require('./reversal-backtest-engine');
const { computeExtendedMetrics } = require('./reversal-metrics');
const { mergeConfig, validateConfig } = require('../reversal-strategy/config');

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

function mean(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

/** Splits [startMs, endMs] into `windowCount` equal, non-overlapping, sequential windows. */
function splitIntoWindows(startMs, endMs, windowCount) {
  const windowMs = (endMs - startMs) / windowCount;
  const windows = [];
  for (let i = 0; i < windowCount; i += 1) {
    windows.push({
      startMs: startMs + i * windowMs,
      endMs: i === windowCount - 1 ? endMs : startMs + (i + 1) * windowMs, // last window absorbs any rounding remainder
    });
  }
  return windows;
}

async function runReversalWalkForward({
  symbol,
  exchange,
  market = 'spot',
  startUtc,
  endUtc,
  windowCount = 4,
  initialCapital = 10000,
  feePercent = 0.1,
  slippagePercent = 0.05,
  configOverrides = {},
}) {
  const config = mergeConfig(configOverrides);
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) throw new Error(`Invalid reversal-strategy config: ${configErrors.join('; ')}`);
  if (!Number.isInteger(windowCount) || windowCount < 2) throw new Error('windowCount must be an integer >= 2.');

  const startMs = new Date(startUtc).getTime();
  const endMs = new Date(endUtc).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Invalid walk-forward date range: endUtc must be after startUtc.');
  }

  const windows = splitIntoWindows(startMs, endMs, windowCount);
  const windowResults = [];

  for (const window of windows) {
    const fetched = await fetchReversalCandles({ symbol, exchange, startMs: window.startMs, endMs: window.endMs, market, config });
    const { trades, equityCurve, warnings } = simulateReversalStrategy({ ...fetched, symbol, initialCapital, feePercent, slippagePercent, config });
    const periodsPerYear = MS_PER_YEAR / fetched.entryStepMs;
    const metrics = computeExtendedMetrics({ trades, equityCurve, initialCapital, periodsPerYear });
    windowResults.push({
      startUtc: new Date(window.startMs).toISOString(),
      endUtc: new Date(window.endMs).toISOString(),
      metrics,
      warningCount: warnings.length,
    });
  }

  const winRates = windowResults.map((w) => w.metrics.winRatePercent);
  const profitFactors = windowResults.map((w) => w.metrics.profitFactor).filter(Number.isFinite);
  const expectancies = windowResults.map((w) => w.metrics.expectancy);
  const netPnlPercents = windowResults.map((w) => w.metrics.totalPnlPercent);
  const profitableWindowCount = windowResults.filter((w) => w.metrics.totalPnl > 0).length;

  return {
    symbol, exchange, market, startUtc, endUtc, windowCount,
    strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION, config,
    windows: windowResults,
    aggregate: {
      profitableWindowCount,
      profitableWindowFraction: windowResults.length > 0 ? profitableWindowCount / windowResults.length : 0,
      winRatePercent: { mean: mean(winRates), stdev: stdev(winRates) },
      profitFactor: { mean: mean(profitFactors), stdev: stdev(profitFactors) },
      expectancy: { mean: mean(expectancies), stdev: stdev(expectancies) },
      netPnlPercent: { mean: mean(netPnlPercents), stdev: stdev(netPnlPercents) },
    },
    disclaimer: 'Every window uses the SAME fixed parameters (no per-window re-optimization) — this measures consistency across time, not best-case performance. High variance across windows is a warning sign about robustness, not noise to average away.',
  };
}

module.exports = { runReversalWalkForward, splitIntoWindows };
