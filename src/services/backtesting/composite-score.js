'use strict';

// Composite ranking objective for backtest parameter sweeps — shared by both the spot and LSR
// adaptive-TP sweeps (adaptive-tp-sweep.js) so ranking a config isn't just "which had the highest
// net profit" (the request is explicit: don't optimize for max profit alone). Expectancy, profit
// factor, max drawdown, Sharpe ratio, win rate, and net P&L all contribute, each normalized
// relative to the OTHER candidates in the same sweep via min-max scaling — not against fixed
// absolute thresholds, which would need constant re-tuning across symbols/timeframes/regimes. A
// candidate with too few trades to be statistically meaningful is ranked last regardless of its
// raw numbers: a config that "won" on 3 trades says nothing about whether it's actually better
// than one that traded 200 times.

const DEFAULT_WEIGHTS = {
  expectancy: 0.2,
  profitFactor: 0.2,
  maxDrawdownPercent: 0.2, // higher = worse; inverted before scoring
  sharpeRatio: 0.15,
  winRatePercent: 0.1,
  totalPnlPercent: 0.15,
};

const DEFAULT_MIN_TRADE_COUNT = 10;

function clampFinite(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

/** A profit factor of Infinity (zero losing trades) is real, valuable information — but can't be
 *  min-max normalized directly. Capped to a large-but-finite stand-in so it still reads as "best
 *  in this population" without letting a literal Infinity make every other candidate's normalized
 *  value collapse to 0. */
function finiteProfitFactor(pf) {
  if (pf === Infinity) return 1000;
  return clampFinite(pf, 0);
}

/** Min-max normalizes `values` to [0,1]; a flat (zero-range) population normalizes to 0.5 for
 *  every entry (no information to rank on, not an arbitrary 0). */
function minMaxNormalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * @param {Array<{metrics: object}>} results - each result's `metrics` must have the fields
 *        computeExtendedMetrics()/computeMetrics() produce (expectancy, profitFactor,
 *        maxDrawdownPercent, sharpeRatio, winRatePercent, totalPnlPercent, tradeCount). Results
 *        without `sharpeRatio`/`expectancy` (i.e. computeMetrics()'s plainer output) treat those
 *        as 0 rather than throwing, so this also works with the spot engine's base metrics.
 * @returns a NEW array (input not mutated), each entry augmented with `compositeScore` (and
 *          `disqualifiedReason` when applicable), sorted descending by compositeScore. Entries
 *          with tradeCount < minTradeCount always sort to the bottom (compositeScore: -Infinity).
 */
function rankByCompositeScore(results, { weights = DEFAULT_WEIGHTS, minTradeCount = DEFAULT_MIN_TRADE_COUNT } = {}) {
  if (results.length === 0) return [];

  const normProfitFactor = minMaxNormalize(results.map((r) => finiteProfitFactor(r.metrics.profitFactor)));
  const normSharpe = minMaxNormalize(results.map((r) => clampFinite(r.metrics.sharpeRatio)));
  const normExpectancy = minMaxNormalize(results.map((r) => clampFinite(r.metrics.expectancy)));
  const normDrawdown = minMaxNormalize(results.map((r) => clampFinite(r.metrics.maxDrawdownPercent))).map((v) => 1 - v);
  const normWinRate = minMaxNormalize(results.map((r) => clampFinite(r.metrics.winRatePercent)));
  const normPnl = minMaxNormalize(results.map((r) => clampFinite(r.metrics.totalPnlPercent)));

  const scored = results.map((result, i) => {
    const tradeCount = result.metrics.tradeCount ?? 0;
    const disqualified = tradeCount < minTradeCount;
    const compositeScore = disqualified
      ? -Infinity
      : normExpectancy[i] * weights.expectancy
        + normProfitFactor[i] * weights.profitFactor
        + normDrawdown[i] * weights.maxDrawdownPercent
        + normSharpe[i] * weights.sharpeRatio
        + normWinRate[i] * weights.winRatePercent
        + normPnl[i] * weights.totalPnlPercent;
    return {
      ...result,
      compositeScore,
      disqualifiedReason: disqualified ? `Only ${tradeCount} trade(s) — below the minimum of ${minTradeCount} to be statistically meaningful.` : null,
    };
  });

  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  return scored;
}

module.exports = { rankByCompositeScore, minMaxNormalize, DEFAULT_WEIGHTS, DEFAULT_MIN_TRADE_COUNT };
