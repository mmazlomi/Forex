'use strict';

// Risk guards — see docs/reversal-strategy/STRATEGY_SPEC.md §11. Pure state object + functions
// (no globals) so a backtest run and, later, a live engine can each hold their own independent
// instance. maxDailyLossPercent is measured against equity AT THE TIME OF THE CHECK (not a fixed
// start-of-day snapshot) — simpler and slightly more conservative (a shrinking equity base makes
// the same dollar loss trip the guard sooner as the day gets worse).

function createRiskGuardState() {
  return {
    dailyLossByDate: new Map(), // 'YYYY-MM-DD' (UTC) -> cumulative realized loss that day (positive number)
    consecutiveLosses: 0,
    openTradesCount: 0,
  };
}

function dateKey(tsUtc) {
  return new Date(tsUtc).toISOString().slice(0, 10);
}

/** Call once per closed trade to update the guard state. */
function recordTradeResult(state, { pnl, closedAtTsUtc }) {
  if (pnl < 0) {
    state.consecutiveLosses += 1;
    const key = dateKey(closedAtTsUtc);
    state.dailyLossByDate.set(key, (state.dailyLossByDate.get(key) || 0) + Math.abs(pnl));
  } else {
    state.consecutiveLosses = 0;
  }
}

/**
 * @returns {{allowed:boolean, reason:string|null}} reason is one of MAX_OPEN_TRADES,
 *          MAX_CONSECUTIVE_LOSSES, MAX_DAILY_LOSS, or null when allowed.
 */
function canOpenNewTrade(state, { tsUtc, equity, config }) {
  if (state.openTradesCount >= config.maxOpenTrades) return { allowed: false, reason: 'MAX_OPEN_TRADES' };
  if (state.consecutiveLosses >= config.maxConsecutiveLosses) return { allowed: false, reason: 'MAX_CONSECUTIVE_LOSSES' };

  const lossToday = state.dailyLossByDate.get(dateKey(tsUtc)) || 0;
  const maxLossAmount = equity * (config.maxDailyLossPercent / 100);
  if (lossToday >= maxLossAmount) return { allowed: false, reason: 'MAX_DAILY_LOSS' };

  return { allowed: true, reason: null };
}

module.exports = { createRiskGuardState, recordTradeResult, canOpenNewTrade };
