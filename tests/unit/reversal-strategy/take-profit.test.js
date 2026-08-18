'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTakeProfit } = require('../../../src/services/reversal-strategy/take-profit');
const { mergeConfig } = require('../../../src/services/reversal-strategy/config');

test('bullish TP is entry + riskDistance * RR, above entry', () => {
  const config = mergeConfig({ riskRewardRatio: 2 });
  const tp = computeTakeProfit(100, 90, 'bullish', config); // risk = 10
  assert.equal(tp, 100 + 10 * 2);
});

test('bearish TP is entry - riskDistance * RR, below entry', () => {
  const config = mergeConfig({ riskRewardRatio: 3 });
  const tp = computeTakeProfit(100, 110, 'bearish', config); // risk = 10
  assert.equal(tp, 100 - 10 * 3);
});

test('risk distance is always the absolute difference, sign of (entry - stopLoss) does not matter', () => {
  const config = mergeConfig({ riskRewardRatio: 2 });
  // Passing an "inverted" stopLoss relative to direction should not silently produce a negative-risk TP.
  const tp = computeTakeProfit(100, 105, 'bullish', config); // risk = |100-105| = 5
  assert.equal(tp, 100 + 5 * 2);
});
