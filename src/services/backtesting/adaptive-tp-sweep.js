'use strict';

// Adaptive-TP parameter sweep — follows optimizer.js's established "hyperopt-lite" grid-search
// convention (fetch candles once, re-run the pure in-memory simulate* function per combination,
// bounded by MAX_COMBINATIONS) extended to BOTH backtest engines (spot's backtest-engine.js and
// LSR's reversal-backtest-engine.js), selected via `engine`.
//
// The request's full grid (7 ATR multipliers x 7 R-multiples x 6 trailing multipliers = 294
// combinations) exceeds any sane single-run cap, and sweeping all three TP tiers independently
// (tp1 x tp2 x tp3 x trailing) would be combinatorially worse still. Instead: TP1/TP2/TP3 keep
// adaptive-take-profit-config.js's default 1:2:3 ratio to each other (the same ratio the request's
// own defaults use — TP1=1x, TP2=2x, TP3=3x), and the sweep varies the SCALAR base multiplier for
// whichever targetMode is being tested, crossed with the trailing multiplier — 7 x 6 = 42
// combinations per run, comfortably under the cap. Run it once with targetMode='atr' and once with
// targetMode='r_multiple' to compare both target schemes, per the request's "the engine should be
// able to compare ATR-based targets and R-multiple targets."
//
// Anti-overfitting: `holdoutPercent` splits [startUtc, endUtc] into an in-sample range (used for
// both running the grid AND ranking it via composite-score.js) and a later out-of-sample holdout
// range that the winning config is re-run against ONCE, after ranking — the in-sample leaderboard
// and the out-of-sample result are never the same data, satisfying "do not optimize and report on
// the same dataset."

const { fetchCandlesForBacktest, simulateStrategy, buildScoringConfig } = require('./backtest-engine');
const { fetchReversalCandles, simulateReversalStrategy, STRATEGY_ID: REVERSAL_STRATEGY_ID } = require('./reversal-backtest-engine');
const { computeMetrics } = require('./metrics');
const { computeExtendedMetrics } = require('./reversal-metrics');
const { rankByCompositeScore } = require('./composite-score');
const { getStrategy, DEFAULT_STRATEGY_ID } = require('../signals/strategies');
const { mergeConfig: mergeReversalConfig, validateConfig: validateReversalConfig } = require('../reversal-strategy/config');
const logger = require('../logging/logger');

const MAX_COMBINATIONS = 60; // same bounded-grid convention as optimizer.js

const DEFAULT_ATR_MULTIPLIERS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0];
const DEFAULT_R_MULTIPLES = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0];
const DEFAULT_TRAILING_MULTIPLIERS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

function buildAdaptiveTpConfigForCombo(targetMode, baseMultiplier, trailingAtrMultiplier) {
  const config = { targetMode, trailingAtrMultiplier };
  if (targetMode === 'atr') {
    Object.assign(config, { tp1AtrMultiplier: baseMultiplier, tp2AtrMultiplier: baseMultiplier * 2, tp3AtrMultiplier: baseMultiplier * 3 });
  } else {
    Object.assign(config, { tp1RMultiple: baseMultiplier, tp2RMultiple: baseMultiplier * 2, tp3RMultiple: baseMultiplier * 3 });
  }
  return config;
}

/** Splits [startMs, endMs] into an earlier in-sample range and a later holdout range — the
 *  holdout is always the MOST RECENT slice, matching how a real deployment would only ever have
 *  older data to optimize on and newer data to validate against. */
function splitInSampleAndHoldout(startMs, endMs, holdoutPercent) {
  const holdoutMs = (endMs - startMs) * (holdoutPercent / 100);
  const splitMs = endMs - holdoutMs;
  return { inSample: { startMs, endMs: splitMs }, holdout: { startMs: splitMs, endMs } };
}

async function runSpotCombo({ symbol, exchange, timeframe, market, startMs, endMs, initialCapital, feePercent, slippagePercent, riskSettings, strategyId, adaptiveTpConfig }) {
  const { candles, startIndex } = await fetchCandlesForBacktest({ symbol, exchange, timeframe, startMs, endMs, market });
  const strategy = getStrategy(strategyId);
  const { config } = buildScoringConfig(strategy, {});
  const { trades, equityCurve } = simulateStrategy({ candles, startIndex, symbol, initialCapital, feePercent, slippagePercent, riskSettings, config, adaptiveTpConfig });
  return computeMetrics({ trades, equityCurve, initialCapital });
}

async function runReversalCombo({ symbol, exchange, market, startMs, endMs, initialCapital, feePercent, slippagePercent, reversalConfig, adaptiveTpConfig }) {
  const fetched = await fetchReversalCandles({ symbol, exchange, startMs, endMs, market, config: reversalConfig });
  const { trades, equityCurve } = simulateReversalStrategy({ ...fetched, symbol, initialCapital, feePercent, slippagePercent, config: reversalConfig, adaptiveTpConfig });
  const periodsPerYear = MS_PER_YEAR / fetched.entryStepMs;
  return computeExtendedMetrics({ trades, equityCurve, initialCapital, periodsPerYear });
}

/**
 * Runs the adaptive-TP grid sweep for one engine, ranks the in-sample results by composite score
 * (never by net profit alone), then re-validates the single best config against a later,
 * never-optimized-on holdout slice. Never places an exchange order — pure historical simulation,
 * same guarantee as every other function in this directory.
 */
async function runAdaptiveTpSweep({
  engine = 'spot', // 'spot' | 'reversal'
  symbol,
  exchange,
  timeframe = '1h', // spot only
  market = 'spot',
  startUtc,
  endUtc,
  holdoutPercent = 30,
  initialCapital = 10000,
  feePercent = 0.1,
  slippagePercent = 0.05,
  riskSettings = { maxRiskPerTradePercent: 1, minRiskRewardRatio: 1.5 }, // spot only
  strategyId = DEFAULT_STRATEGY_ID, // spot only
  reversalConfigOverrides = {}, // reversal only
  targetMode = 'atr', // 'atr' | 'r_multiple' — which grid this run sweeps
  atrMultiplierGrid = DEFAULT_ATR_MULTIPLIERS,
  rMultipleGrid = DEFAULT_R_MULTIPLES,
  trailingMultiplierGrid = DEFAULT_TRAILING_MULTIPLIERS,
  rankWeights,
  minTradeCount,
}) {
  if (!['spot', 'reversal'].includes(engine)) throw new Error(`engine must be "spot" or "reversal", got "${engine}"`);
  if (!['atr', 'r_multiple'].includes(targetMode)) throw new Error(`targetMode must be "atr" or "r_multiple", got "${targetMode}"`);
  if (!(holdoutPercent >= 0 && holdoutPercent < 100)) throw new Error('holdoutPercent must be >= 0 and < 100.');

  const startMs = new Date(startUtc).getTime();
  const endMs = new Date(endUtc).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Invalid sweep date range: endUtc must be after startUtc.');
  }

  let reversalConfig = null;
  if (engine === 'reversal') {
    reversalConfig = mergeReversalConfig(reversalConfigOverrides);
    const errors = validateReversalConfig(reversalConfig);
    if (errors.length > 0) throw new Error(`Invalid reversal-strategy config: ${errors.join('; ')}`);
  }

  const baseGrid = targetMode === 'atr' ? atrMultiplierGrid : rMultipleGrid;
  const combinations = [];
  for (const baseMultiplier of baseGrid) {
    for (const trailingAtrMultiplier of trailingMultiplierGrid) {
      combinations.push({ baseMultiplier, trailingAtrMultiplier });
    }
  }
  if (combinations.length > MAX_COMBINATIONS) {
    throw new Error(`Requested grid has ${combinations.length} combinations, exceeding the limit of ${MAX_COMBINATIONS} — narrow atrMultiplierGrid/rMultipleGrid/trailingMultiplierGrid.`);
  }

  const { inSample, holdout } = splitInSampleAndHoldout(startMs, endMs, holdoutPercent);

  const results = [];
  for (const combo of combinations) {
    const adaptiveTpConfig = buildAdaptiveTpConfigForCombo(targetMode, combo.baseMultiplier, combo.trailingAtrMultiplier);
    try {
      const metrics = engine === 'spot'
        ? await runSpotCombo({ symbol, exchange, timeframe, market, startMs: inSample.startMs, endMs: inSample.endMs, initialCapital, feePercent, slippagePercent, riskSettings, strategyId, adaptiveTpConfig })
        : await runReversalCombo({ symbol, exchange, market, startMs: inSample.startMs, endMs: inSample.endMs, initialCapital, feePercent, slippagePercent, reversalConfig, adaptiveTpConfig });
      results.push({ baseMultiplier: combo.baseMultiplier, trailingAtrMultiplier: combo.trailingAtrMultiplier, targetMode, metrics });
    } catch (err) {
      logger.warn('adaptive-tp-sweep', `Combination baseMultiplier=${combo.baseMultiplier}/trailing=${combo.trailingAtrMultiplier} failed: ${err.message}`);
    }
  }

  const ranked = rankByCompositeScore(results, { weights: rankWeights, minTradeCount });
  const best = ranked.find((r) => r.compositeScore > -Infinity) ?? ranked[0] ?? null;

  let outOfSample = null;
  if (best && holdoutPercent > 0) {
    const bestAdaptiveTpConfig = buildAdaptiveTpConfigForCombo(targetMode, best.baseMultiplier, best.trailingAtrMultiplier);
    try {
      const metrics = engine === 'spot'
        ? await runSpotCombo({ symbol, exchange, timeframe, market, startMs: holdout.startMs, endMs: holdout.endMs, initialCapital, feePercent, slippagePercent, riskSettings, strategyId, adaptiveTpConfig: bestAdaptiveTpConfig })
        : await runReversalCombo({ symbol, exchange, market, startMs: holdout.startMs, endMs: holdout.endMs, initialCapital, feePercent, slippagePercent, reversalConfig, adaptiveTpConfig: bestAdaptiveTpConfig });
      outOfSample = { startUtc: new Date(holdout.startMs).toISOString(), endUtc: new Date(holdout.endMs).toISOString(), metrics };
    } catch (err) {
      logger.warn('adaptive-tp-sweep', `Holdout validation of the best combo failed: ${err.message}`);
      outOfSample = { startUtc: new Date(holdout.startMs).toISOString(), endUtc: new Date(holdout.endMs).toISOString(), error: err.message };
    }
  }

  return {
    engine, symbol, exchange, targetMode, startUtc, endUtc, holdoutPercent,
    inSampleRange: { startUtc: new Date(inSample.startMs).toISOString(), endUtc: new Date(inSample.endMs).toISOString() },
    combinationsRun: results.length,
    inSampleLeaderboard: ranked,
    bestConfig: best ? { baseMultiplier: best.baseMultiplier, trailingAtrMultiplier: best.trailingAtrMultiplier, targetMode } : null,
    outOfSample,
    strategyId: engine === 'spot' ? strategyId : REVERSAL_STRATEGY_ID,
    disclaimer: 'Ranked by a composite of expectancy, profit factor, max drawdown, Sharpe ratio, win rate, and net P&L — never by net profit alone. The out-of-sample result uses a later holdout slice never seen during ranking; a best in-sample config that performs much worse out-of-sample is a sign of overfitting, not a sign to keep searching.',
  };
}

module.exports = { runAdaptiveTpSweep, buildAdaptiveTpConfigForCombo, splitInSampleAndHoldout, MAX_COMBINATIONS, DEFAULT_ATR_MULTIPLIERS, DEFAULT_R_MULTIPLES, DEFAULT_TRAILING_MULTIPLIERS };
