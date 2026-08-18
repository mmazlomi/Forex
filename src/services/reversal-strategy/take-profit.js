'use strict';

// Take-profit — Phase 1 Model A only (fixed R multiple). See
// docs/reversal-strategy/STRATEGY_SPEC.md §10 and IMPLEMENTATION_PLAN.md for Models B/C
// (partial exits, trailing stop), deferred to Phase 2.

/** @returns {number} TP = entry +/- (entry - stopLoss) * riskRewardRatio, sign per direction */
function computeTakeProfit(entryPrice, stopLoss, direction, config) {
  const riskDistance = Math.abs(entryPrice - stopLoss);
  return direction === 'bullish'
    ? entryPrice + riskDistance * config.riskRewardRatio
    : entryPrice - riskDistance * config.riskRewardRatio;
}

module.exports = { computeTakeProfit };
