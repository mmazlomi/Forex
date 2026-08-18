'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRiskGuardState, recordTradeResult, canOpenNewTrade } = require('../../../src/services/reversal-strategy/risk-guards');
const { mergeConfig } = require('../../../src/services/reversal-strategy/config');

const DAY1 = Date.UTC(2026, 0, 1, 10);
const DAY2 = Date.UTC(2026, 0, 2, 10);

test('allows a new trade with fresh state', () => {
  const state = createRiskGuardState();
  const config = mergeConfig();
  assert.deepEqual(canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config }), { allowed: true, reason: null });
});

test('blocks once maxOpenTrades is reached', () => {
  const state = createRiskGuardState();
  state.openTradesCount = 1;
  const config = mergeConfig({ maxOpenTrades: 1 });
  const result = canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'MAX_OPEN_TRADES');
});

test('blocks after maxConsecutiveLosses losing trades in a row, resets on a win', () => {
  const state = createRiskGuardState();
  const config = mergeConfig({ maxConsecutiveLosses: 2 });
  recordTradeResult(state, { pnl: -10, closedAtTsUtc: DAY1 });
  assert.equal(canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config }).allowed, true);
  recordTradeResult(state, { pnl: -10, closedAtTsUtc: DAY1 });
  const blocked = canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'MAX_CONSECUTIVE_LOSSES');

  recordTradeResult(state, { pnl: 50, closedAtTsUtc: DAY1 }); // a win resets the streak
  assert.equal(state.consecutiveLosses, 0);
  assert.equal(canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config }).allowed, true);
});

test('blocks once cumulative same-UTC-day loss reaches maxDailyLossPercent of current equity', () => {
  const state = createRiskGuardState();
  const config = mergeConfig({ maxDailyLossPercent: 3, maxConsecutiveLosses: 100 });
  recordTradeResult(state, { pnl: -250, closedAtTsUtc: DAY1 }); // 2.5% of 10000
  assert.equal(canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config }).allowed, true);
  recordTradeResult(state, { pnl: -100, closedAtTsUtc: DAY1 }); // total 3.5% of 10000
  const blocked = canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'MAX_DAILY_LOSS');
});

test('daily loss guard resets on a new UTC day', () => {
  const state = createRiskGuardState();
  const config = mergeConfig({ maxDailyLossPercent: 3 });
  recordTradeResult(state, { pnl: -500, closedAtTsUtc: DAY1 }); // 5% of 10000, breaches on DAY1
  assert.equal(canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config }).allowed, false);
  assert.equal(canOpenNewTrade(state, { tsUtc: DAY2, equity: 10000, config }).allowed, true);
});

test('wins do not count toward the daily loss total', () => {
  const state = createRiskGuardState();
  const config = mergeConfig({ maxDailyLossPercent: 3 });
  recordTradeResult(state, { pnl: 10000, closedAtTsUtc: DAY1 });
  assert.equal(canOpenNewTrade(state, { tsUtc: DAY1, equity: 10000, config }).allowed, true);
});
