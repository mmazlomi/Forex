'use strict';

function computeMaxDrawdown(equityCurve) {
  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      const drawdownPercent = ((peak - point.equity) / peak) * 100;
      maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPercent);
    }
  }
  return maxDrawdownPercent;
}

function computeMetrics({ trades, equityCurve, initialCapital }) {
  const closedTrades = trades.filter((t) => t.exitPrice !== null && t.exitPrice !== undefined);
  const wins = closedTrades.filter((t) => t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl <= 0);

  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;
  const totalPnl = finalEquity - initialCapital;
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  return {
    initialCapital,
    finalEquity,
    totalPnl,
    totalPnlPercent: initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0,
    maxDrawdownPercent: computeMaxDrawdown(equityCurve),
    tradeCount: closedTrades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePercent: closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
  };
}

module.exports = { computeMetrics, computeMaxDrawdown };
