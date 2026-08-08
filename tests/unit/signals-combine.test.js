'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { combineByMajorityVote } = require('../../src/services/signals');

// Minimal synthetic per-strategy result — only the fields combineByMajorityVote actually reads.
function result(status, finalScore, overrides = {}) {
  return {
    status, finalScore, price: 100,
    entry: status !== 'HOLD' && status !== 'NO_DATA' ? 100 : null,
    stopLoss: null, takeProfit: null, riskRewardRatio: null,
    technicalSummary: { from: 'shared-inputs' }, fundamentalSummary: {},
    dataQuality: 'good', warnings: [], strategyVersion: '1.0.0', strategyName: null,
    ...overrides,
  };
}

test('2-of-3 majority: the winning status is the one with strictly more than half the votes', () => {
  const { status, votes } = combineByMajorityVote([
    { strategyId: 'a', result: result('BUY', 0.5) },
    { strategyId: 'b', result: result('BUY', 0.3) },
    { strategyId: 'c', result: result('HOLD', 0.1) },
  ]);
  assert.equal(status, 'BUY');
  assert.deepEqual(votes, { a: 'BUY', b: 'BUY', c: 'HOLD' });
});

test('representative fields come from the agreeing strategy with the highest |finalScore|, not the first one', () => {
  const { representative } = combineByMajorityVote([
    { strategyId: 'a', result: result('BUY', 0.3) },
    { strategyId: 'b', result: result('BUY', 0.9) }, // strongest conviction on the winning side
    { strategyId: 'c', result: result('SELL', -0.2) },
  ]);
  assert.equal(representative.finalScore, 0.9);
});

test('2-of-2 agreement wins (majority threshold scales with the number of selected strategies)', () => {
  const { status } = combineByMajorityVote([
    { strategyId: 'a', result: result('BUY', 0.2) },
    { strategyId: 'b', result: result('BUY', 0.6) },
  ]);
  assert.equal(status, 'BUY');
});

test('1-1 tie (2 strategies) resolves to HOLD with null entry/stop/take — never trades on ambiguity', () => {
  const { status, representative } = combineByMajorityVote([
    { strategyId: 'a', result: result('BUY', 0.2) },
    { strategyId: 'b', result: result('SELL', -0.6) },
  ]);
  assert.equal(status, 'HOLD');
  assert.equal(representative.entry, null);
  assert.equal(representative.stopLoss, null);
  assert.equal(representative.takeProfit, null);
});

test('1-1-1 three-way split resolves to HOLD, not to whichever status happened to have 1 vote', () => {
  const { status, representative } = combineByMajorityVote([
    { strategyId: 'a', result: result('BUY', 0.5) },
    { strategyId: 'b', result: result('SELL', -0.4) },
    { strategyId: 'c', result: result('HOLD', 0.1) },
  ]);
  assert.equal(status, 'HOLD');
  assert.equal(representative.entry, null, 'a manufactured HOLD must not borrow a directional strategy\'s entry/stop/take');
});

test('a manufactured HOLD (no strategy actually voted HOLD) still carries a usable price/dataQuality for display', () => {
  const { representative } = combineByMajorityVote([
    { strategyId: 'a', result: result('BUY', 0.5, { price: 42000 }) },
    { strategyId: 'b', result: result('SELL', -0.5, { price: 42000 }) },
  ]);
  assert.equal(representative.price, 42000);
  assert.equal(representative.dataQuality, 'good');
});

test('all strategies returning NO_DATA propagates NO_DATA rather than being reinterpreted as a no-majority HOLD', () => {
  const { status } = combineByMajorityVote([
    { strategyId: 'a', result: result('NO_DATA', null) },
    { strategyId: 'b', result: result('NO_DATA', null) },
  ]);
  assert.equal(status, 'NO_DATA');
});

test('3-of-3 unanimous agreement wins cleanly', () => {
  const { status, votes } = combineByMajorityVote([
    { strategyId: 'a', result: result('SELL', -0.3) },
    { strategyId: 'b', result: result('SELL', -0.5) },
    { strategyId: 'c', result: result('SELL', -0.2) },
  ]);
  assert.equal(status, 'SELL');
  assert.deepEqual(votes, { a: 'SELL', b: 'SELL', c: 'SELL' });
});
