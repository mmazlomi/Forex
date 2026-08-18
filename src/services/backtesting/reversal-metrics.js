'use strict';

// Extended reporting metrics for the reversal-strategy backtest engine — additive on top of the
// existing metrics.js#computeMetrics (which is left untouched so the spot backtest-engine.js/
// optimizer.js and their existing tests are unaffected). See docs/reversal-strategy/STRATEGY_SPEC.md
// and the original spec's reporting requirements (§12) for why each of these exists.

const { computeMetrics, computeMaxDrawdown } = require('./metrics');
const { SESSION_PRESETS } = require('../reversal-strategy/config');
const { isWithinAnySession } = require('../reversal-strategy/session-filter');

function mean(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Bar-to-bar percent returns from an equity curve — the input to Sharpe/Sortino. */
function periodicReturns(equityCurve) {
  const returns = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev);
  }
  return returns;
}

/** Absolute-dollar (not percent) max drawdown — needed for recovery factor. */
function computeMaxDrawdownAbsolute(equityCurve) {
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, peak - point.equity);
  }
  return maxDrawdown;
}

/**
 * @param {number} periodsPerYear used to annualize Sharpe/Sortino from per-bar returns — derive
 *        from the entry timeframe (e.g. 5m -> 365*24*12). Pass 1 (or omit) for an un-annualized,
 *        per-period ratio instead — useful when comparing runs across different timeframes where
 *        an annualized number would misleadingly imply comparability it doesn't have.
 */
function computeSharpeRatio(equityCurve, periodsPerYear = 1) {
  const returns = periodicReturns(equityCurve);
  const sd = stdev(returns);
  if (sd === 0) return 0;
  return (mean(returns) / sd) * Math.sqrt(periodsPerYear);
}

/** Same as Sharpe but only penalizes downside volatility (returns below 0). */
function computeSortinoRatio(equityCurve, periodsPerYear = 1) {
  const returns = periodicReturns(equityCurve);
  const downside = returns.filter((r) => r < 0);
  const downsideDeviation = stdev(downside.length > 0 ? downside : [0]);
  if (downsideDeviation === 0) return 0;
  return (mean(returns) / downsideDeviation) * Math.sqrt(periodsPerYear);
}

function computeExpectancy(closedTrades) {
  if (closedTrades.length === 0) return 0;
  return mean(closedTrades.map((t) => t.pnl));
}

function computeAvgTradeDurationMs(closedTrades) {
  const durations = closedTrades
    .filter((t) => t.enteredAtUtc && t.exitedAtUtc)
    .map((t) => new Date(t.exitedAtUtc).getTime() - new Date(t.enteredAtUtc).getTime());
  return mean(durations);
}

function breakdownBySide(closedTrades) {
  const bySide = {};
  for (const side of ['long', 'short']) {
    const trades = closedTrades.filter((t) => t.side === side);
    const wins = trades.filter((t) => t.pnl > 0);
    bySide[side] = {
      tradeCount: trades.length,
      totalPnl: trades.reduce((sum, t) => sum + t.pnl, 0),
      winRatePercent: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    };
  }
  return bySide;
}

function monthKey(isoString) {
  return isoString.slice(0, 7); // 'YYYY-MM'
}

function breakdownByMonth(closedTrades) {
  const byMonth = {};
  for (const trade of closedTrades) {
    if (!trade.exitedAtUtc) continue;
    const key = monthKey(trade.exitedAtUtc);
    if (!byMonth[key]) byMonth[key] = { tradeCount: 0, totalPnl: 0, winCount: 0 };
    byMonth[key].tradeCount += 1;
    byMonth[key].totalPnl += trade.pnl;
    if (trade.pnl > 0) byMonth[key].winCount += 1;
  }
  for (const key of Object.keys(byMonth)) {
    byMonth[key].winRatePercent = (byMonth[key].winCount / byMonth[key].tradeCount) * 100;
  }
  return byMonth;
}

/** Buckets each trade's ENTRY time into the named session preset(s) it falls within (a trade can
 *  count toward more than one bucket if sessions overlap, e.g. London/New York) plus an 'other'
 *  bucket for entries outside every named preset — every trade is counted at least once. */
function breakdownBySession(closedTrades) {
  const sessionNames = Object.keys(SESSION_PRESETS);
  const bySession = {};
  for (const name of [...sessionNames, 'other']) {
    bySession[name] = { tradeCount: 0, totalPnl: 0, winCount: 0 };
  }
  for (const trade of closedTrades) {
    if (!trade.enteredAtUtc) continue;
    const tsUtc = new Date(trade.enteredAtUtc).getTime();
    const matchedNames = sessionNames.filter((name) => isWithinAnySession(tsUtc, [name]));
    const buckets = matchedNames.length > 0 ? matchedNames : ['other'];
    for (const name of buckets) {
      bySession[name].tradeCount += 1;
      bySession[name].totalPnl += trade.pnl;
      if (trade.pnl > 0) bySession[name].winCount += 1;
    }
  }
  for (const name of Object.keys(bySession)) {
    const b = bySession[name];
    b.winRatePercent = b.tradeCount > 0 ? (b.winCount / b.tradeCount) * 100 : 0;
  }
  return bySession;
}

/**
 * Full report per docs/reversal-strategy/STRATEGY_SPEC.md / the original spec's §12 reporting
 * requirements. Wraps computeMetrics() (net/gross P&L, profit factor, win rate, drawdown %) and
 * adds everything else: expectancy, Sharpe, Sortino, recovery factor, avg trade duration,
 * long/short + monthly + session breakdowns.
 */
function computeExtendedMetrics({ trades, equityCurve, initialCapital, periodsPerYear = 1 }) {
  const base = computeMetrics({ trades, equityCurve, initialCapital });
  const closedTrades = trades.filter((t) => t.exitPrice !== null && t.exitPrice !== undefined);
  const maxDrawdownAbsolute = computeMaxDrawdownAbsolute(equityCurve);

  return {
    ...base,
    expectancy: computeExpectancy(closedTrades),
    sharpeRatio: computeSharpeRatio(equityCurve, periodsPerYear),
    sortinoRatio: computeSortinoRatio(equityCurve, periodsPerYear),
    maxDrawdownAbsolute,
    recoveryFactor: maxDrawdownAbsolute > 0 ? base.totalPnl / maxDrawdownAbsolute : base.totalPnl > 0 ? Infinity : 0,
    avgTradeDurationMs: computeAvgTradeDurationMs(closedTrades),
    bySide: breakdownBySide(closedTrades),
    byMonth: breakdownByMonth(closedTrades),
    bySession: breakdownBySession(closedTrades),
  };
}

module.exports = {
  computeExtendedMetrics,
  computeMaxDrawdown, // re-exported for convenience (percent-based, from the base metrics.js)
  computeMaxDrawdownAbsolute,
  computeSharpeRatio,
  computeSortinoRatio,
};
