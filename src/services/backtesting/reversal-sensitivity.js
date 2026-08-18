'use strict';

// 1-D parameter sensitivity sweep — see docs/reversal-strategy/STRATEGY_SPEC.md §15. Deliberately
// ONE parameter at a time (never a multi-parameter grid/heatmap) per the original spec's explicit
// anti-overfitting guidance: "do not optimize dozens of parameters simultaneously", "prefer
// robust parameter regions over a single best parameter". A narrow spike in performance at one
// specific value, surrounded by mediocre-or-worse neighbors, is exactly the overfitting signature
// this is meant to surface — see buildOverfittingNote below.

const { fetchReversalCandles, simulateReversalStrategy, STRATEGY_ID } = require('./reversal-backtest-engine');
const { computeExtendedMetrics } = require('./reversal-metrics');
const { mergeConfig, validateConfig } = require('../reversal-strategy/config');

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const TIMEFRAME_PARAMS = new Set(['htfTimeframe', 'signalTimeframe', 'entryTimeframe']);

/** Deep-clones `obj` and overwrites the value at dot-notation `path` (e.g. 'htfFilter.kijunSlopeLookback'). */
function withOverride(obj, path, value) {
  const clone = JSON.parse(JSON.stringify(obj));
  const parts = path.split('.');
  let cursor = clone;
  for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]];
  cursor[parts[parts.length - 1]] = value;
  return clone;
}

/**
 * A result is flagged as a likely overfit "spike" when the best-performing value's |net P&L %|
 * is more than 4x every other tested value's |net P&L %| (or every other value is flat/losing
 * while it alone is strongly profitable) — a rough, deliberately simple heuristic, not a
 * statistical test; it exists to prompt a second look, not to auto-reject a parameter.
 */
function buildOverfittingNote(successfulResults) {
  if (successfulResults.length < 3) return null;
  const netPnlPercents = successfulResults.map((r) => r.metrics.totalPnlPercent);
  const absValues = netPnlPercents.map(Math.abs);
  const maxAbs = Math.max(...absValues);
  if (maxAbs === 0) return null;
  const bestIndex = absValues.indexOf(maxAbs);

  const neighborsAreWeak = absValues.every((v, i) => i === bestIndex || v < maxAbs * 0.25);
  if (!neighborsAreWeak) return null;

  return `Value ${JSON.stringify(successfulResults[bestIndex].value)} outperforms every other tested value by more than 4x — a narrow "sweet spot" like this is a classic overfitting signature. Prefer a value from a wider region of consistently reasonable performance unless there is a principled, non-curve-fit reason to prefer this specific one.`;
}

/**
 * Runs the SAME backtest date range once per value in `values` for the parameter at `paramPath`,
 * holding every other parameter at `baseConfigOverrides`'s values. Candles are fetched ONCE and
 * reused across every value (same fetch-once/simulate-many split as optimizer.js) — UNLESS
 * `paramPath` is itself one of the three timeframe settings, in which case each value genuinely
 * needs its own fetch (a different timeframe means different candles entirely).
 */
async function runReversalSensitivitySweep({
  symbol,
  exchange,
  market = 'spot',
  startUtc,
  endUtc,
  paramPath,
  values,
  initialCapital = 10000,
  feePercent = 0.1,
  slippagePercent = 0.05,
  baseConfigOverrides = {},
}) {
  if (!paramPath || !Array.isArray(values) || values.length === 0) {
    throw new Error('paramPath and a non-empty values array are required.');
  }

  const startMs = new Date(startUtc).getTime();
  const endMs = new Date(endUtc).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Invalid sensitivity-sweep date range: endUtc must be after startUtc.');
  }

  const baseConfig = mergeConfig(baseConfigOverrides);
  const sweepsTimeframe = TIMEFRAME_PARAMS.has(paramPath);
  const sharedFetch = sweepsTimeframe ? null : await fetchReversalCandles({ symbol, exchange, startMs, endMs, market, config: baseConfig });

  const results = [];
  for (const value of values) {
    const config = withOverride(baseConfig, paramPath, value);
    const configErrors = validateConfig(config);
    if (configErrors.length > 0) {
      results.push({ value, error: `Invalid config: ${configErrors.join('; ')}` });
      continue;
    }
    try {
      const fetched = sharedFetch || await fetchReversalCandles({ symbol, exchange, startMs, endMs, market, config });
      const { trades, equityCurve } = simulateReversalStrategy({ ...fetched, symbol, initialCapital, feePercent, slippagePercent, config });
      const periodsPerYear = MS_PER_YEAR / fetched.entryStepMs;
      const metrics = computeExtendedMetrics({ trades, equityCurve, initialCapital, periodsPerYear });
      results.push({ value, metrics });
    } catch (err) {
      results.push({ value, error: err.message });
    }
  }

  const successfulResults = results.filter((r) => r.metrics);

  return {
    symbol, exchange, market, startUtc, endUtc, paramPath, strategyId: STRATEGY_ID,
    results,
    overfittingWarning: buildOverfittingNote(successfulResults),
    disclaimer: 'A 1-D sweep only — every other parameter held fixed at baseConfigOverrides\' values. See overfittingWarning for whether this particular sweep shows a narrow-spike (likely overfit) pattern.',
  };
}

module.exports = { runReversalSensitivitySweep, buildOverfittingNote };
