'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, byStrategyBreakdown } = require('../../src/services/portfolio/trading-statistics-service');

function pos(overrides) {
  return { realized_pnl: 0, strategy_id: null, combined_strategy_ids_json: null, ...overrides };
}

test('summarize: empty list gives zero counts and null rates, not NaN/division-by-zero garbage', () => {
  const s = summarize([]);
  assert.equal(s.count, 0);
  assert.equal(s.wins, 0);
  assert.equal(s.losses, 0);
  assert.equal(s.winRatePercent, null);
  assert.equal(s.totalRealizedPnl, 0);
  assert.equal(s.avgWin, null);
  assert.equal(s.avgLoss, null);
  assert.equal(s.profitFactor, null);
});

test('summarize: win rate denominator excludes breakeven trades', () => {
  const s = summarize([pos({ realized_pnl: 10 }), pos({ realized_pnl: -10 }), pos({ realized_pnl: 0 })]);
  assert.equal(s.count, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.breakeven, 1);
  assert.equal(s.winRatePercent, 50); // 1/(1+1), not 1/3
});

test('summarize: totals, averages, and profit factor are computed correctly', () => {
  const s = summarize([pos({ realized_pnl: 30 }), pos({ realized_pnl: 10 }), pos({ realized_pnl: -20 })]);
  assert.equal(s.totalRealizedPnl, 20);
  assert.equal(s.avgWin, 20); // (30+10)/2
  assert.equal(s.avgLoss, -20);
  assert.equal(s.profitFactor, 2); // 40 gross win / 20 gross loss
});

test('summarize: profit factor is the string "∞" (not the number Infinity) when every closed trade won, since JSON.stringify silently turns Infinity into null over the API', () => {
  const s = summarize([pos({ realized_pnl: 5 }), pos({ realized_pnl: 15 })]);
  assert.equal(s.profitFactor, '∞');
  assert.equal(JSON.parse(JSON.stringify(s)).profitFactor, '∞');
});

test('byStrategyBreakdown: groups a combined-vote trade as one bucket, not split across component strategies', () => {
  const combined = pos({ realized_pnl: 10, strategy_id: 'rsi_reversal', combined_strategy_ids_json: JSON.stringify(['rsi_reversal', 'macd_momentum']) });
  const solo = pos({ realized_pnl: -5, strategy_id: 'rsi_reversal', combined_strategy_ids_json: null });
  const groups = byStrategyBreakdown([combined, solo, solo]);
  // "rsi_reversal" alone and "rsi_reversal+macd_momentum" combined must be separate buckets.
  assert.equal(groups.length, 2);
  const soloGroup = groups.find((g) => g.strategyId === 'rsi_reversal');
  const comboGroup = groups.find((g) => g.strategyId.includes('+'));
  assert.ok(soloGroup && comboGroup);
  assert.equal(soloGroup.count, 2);
  assert.equal(comboGroup.count, 1);
});

test('byStrategyBreakdown: a null strategy_id (manual trade) groups under "No Strategy (Manual)"', () => {
  const groups = byStrategyBreakdown([pos({ realized_pnl: 5, strategy_id: null }), pos({ realized_pnl: -5, strategy_id: null })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].strategyId, 'none');
  assert.equal(groups[0].strategyName, 'No Strategy (Manual)');
  assert.equal(groups[0].count, 2);
});

test('byStrategyBreakdown: sorted by trade count descending', () => {
  const a = pos({ strategy_id: 'a' });
  const b = pos({ strategy_id: 'b' });
  const groups = byStrategyBreakdown([a, b, b, b]);
  assert.equal(groups[0].strategyId, 'b');
  assert.equal(groups[0].count, 3);
  assert.equal(groups[1].strategyId, 'a');
  assert.equal(groups[1].count, 1);
});
