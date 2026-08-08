'use strict';

/** Maximum Risk Amount = Portfolio Balance × Maximum Risk Percentage */
function computeMaxRiskAmount(balance, maxRiskPercent) {
  return balance * (maxRiskPercent / 100);
}

/** Position Size = Maximum Risk Amount / |Entry Price − Stop-Loss Price| */
function computePositionSize(maxRiskAmount, entryPrice, stopLossPrice) {
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice);
  if (riskPerUnit === 0) return null; // stop-loss equals entry — cannot size a position
  return maxRiskAmount / riskPerUnit;
}

function computeRiskRewardRatio(entryPrice, stopLossPrice, takeProfitPrice) {
  const risk = Math.abs(entryPrice - stopLossPrice);
  const reward = Math.abs(takeProfitPrice - entryPrice);
  if (risk === 0) return null;
  return reward / risk;
}

module.exports = { computeMaxRiskAmount, computePositionSize, computeRiskRewardRatio };
