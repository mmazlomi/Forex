'use strict';

// Stage H of the Adaptive Take-Profit build-out: a reporting deliverable, not new production
// code — nothing in server.js or any live scheduler imports this module. Runs the SAME
// walk-forward harness (spot-walk-forward.js / reversal-walk-forward.js — sequential, fixed-
// config, no per-window re-optimization, so each window is a genuine out-of-sample test) twice
// over identical symbol/date-range/window-count inputs: once with no adaptiveTpConfig (today's
// fixed-formula behavior, byte-identical per those modules' own regression pins) and once with
// one, then ranks the two using composite-score.js's same never-just-raw-profit objective used
// throughout this codebase's parameter sweeps.

// Accessed via namespace objects below, not destructured — this project's tests mock module
// functions via t.mock.method(moduleObject, 'fn', ...), which only intercepts property access.
const spotWalkForward = require('./spot-walk-forward');
const reversalWalkForward = require('./reversal-walk-forward');
const { rankByCompositeScore } = require('./composite-score');

function mean(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * Reduces a walk-forward run's per-window metrics (each already computeMetrics()/
 * computeExtendedMetrics()-shaped) into ONE metrics object composite-score.js#rankByCompositeScore
 * can rank — tradeCount summed (the real total trades this run traded, for the minimum-trade-count
 * gate), everything else averaged across windows. This is deliberately the same "consistency
 * across time, not best-case performance" spirit the walk-forward runners already document, not a
 * re-fit or cherry-pick of the best window.
 */
function aggregateMetricsForComposite(windows) {
  const tradeCount = windows.reduce((sum, w) => sum + (w.metrics.tradeCount ?? 0), 0);
  const finiteProfitFactors = windows.map((w) => w.metrics.profitFactor).filter(Number.isFinite);
  return {
    tradeCount,
    profitFactor: mean(finiteProfitFactors),
    expectancy: mean(windows.map((w) => w.metrics.expectancy ?? 0)),
    maxDrawdownPercent: mean(windows.map((w) => w.metrics.maxDrawdownPercent ?? 0)),
    sharpeRatio: mean(windows.map((w) => w.metrics.sharpeRatio ?? 0)),
    winRatePercent: mean(windows.map((w) => w.metrics.winRatePercent ?? 0)),
    totalPnlPercent: mean(windows.map((w) => w.metrics.totalPnlPercent ?? 0)),
  };
}

/**
 * @param {object} options
 * @param {'spot'|'reversal'} [options.engine='spot'] - which walk-forward harness to run; 'spot'
 *        drives backtest-engine.js (weighted-indicator strategies), 'reversal' drives
 *        reversal-backtest-engine.js (LSR, spot or futures per options.market).
 * @param {object} [options.adaptiveTpConfig] - passed to adaptive-take-profit-config.js#mergeConfig
 *        for the "adaptive" run; the "fixed" run always omits it entirely (not an empty object —
 *        omission is what both engines' own regression pins guarantee is byte-identical to today).
 * @param {...} everything else forwards verbatim to runSpotWalkForward/runReversalWalkForward
 *        (symbol, exchange, market, timeframe/configOverrides, startUtc, endUtc, windowCount, etc).
 * @returns {{engine, symbol, exchange, market, startUtc, endUtc, windowCount, fixed, adaptive, ranked, winner}}
 *          `ranked` is composite-score.js's own output shape (each entry has compositeScore and,
 *          when disqualified for too few trades, disqualifiedReason) — `winner` is null when the
 *          top-ranked entry was itself disqualified (neither run traded enough to compare).
 */
async function compareFixedVsAdaptive({ engine = 'spot', adaptiveTpConfig, ...rest }) {
  const runWalkForward = engine === 'reversal' ? reversalWalkForward.runReversalWalkForward : spotWalkForward.runSpotWalkForward;

  const [fixedRun, adaptiveRun] = await Promise.all([
    runWalkForward({ ...rest }),
    runWalkForward({ ...rest, adaptiveTpConfig: adaptiveTpConfig || {} }),
  ]);

  const results = [
    { label: 'fixed', metrics: aggregateMetricsForComposite(fixedRun.windows) },
    { label: 'adaptive', metrics: aggregateMetricsForComposite(adaptiveRun.windows) },
  ];
  const ranked = rankByCompositeScore(results);
  const top = ranked[0];

  return {
    engine,
    symbol: rest.symbol,
    exchange: rest.exchange,
    market: rest.market || 'spot',
    startUtc: rest.startUtc,
    endUtc: rest.endUtc,
    windowCount: rest.windowCount,
    fixed: { walkForward: fixedRun, compositeMetrics: results[0].metrics },
    adaptive: { walkForward: adaptiveRun, compositeMetrics: results[1].metrics },
    ranked: ranked.map((r) => ({ label: r.label, compositeScore: r.compositeScore, disqualifiedReason: r.disqualifiedReason })),
    winner: top && !top.disqualifiedReason ? top.label : null,
  };
}

module.exports = { compareFixedVsAdaptive, aggregateMetricsForComposite };
