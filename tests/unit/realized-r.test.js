'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRealizedR } = require('../../src/services/risk/realized-r');

test('computeRealizedR: a trade that returns exactly its risk is +1R', () => {
  assert.equal(computeRealizedR(100, 10, 10), 1); // risk = 10*10=100, pnl=100 -> 1R
});

test('computeRealizedR: a trade that returns double its risk is +2R', () => {
  assert.equal(computeRealizedR(200, 10, 10), 2);
});

test('computeRealizedR: a losing trade is negative R', () => {
  assert.equal(computeRealizedR(-50, 10, 10), -0.5);
});

test('computeRealizedR: a partial-fill position uses rMultiple x initialQty, not remaining qty', () => {
  // initial_qty=10 always, even if the position has since partially closed down to e.g. 4 remaining.
  assert.equal(computeRealizedR(50, 5, 10), 1); // risk = 5*10=50
});

test('computeRealizedR: returns null (not NaN/Infinity) when rMultiple is null (non-adaptive position)', () => {
  assert.equal(computeRealizedR(100, null, 10), null);
});

test('computeRealizedR: returns null when initialQty is null', () => {
  assert.equal(computeRealizedR(100, 10, null), null);
});

test('computeRealizedR: returns null when rMultiple is 0 (would be a divide-by-zero)', () => {
  assert.equal(computeRealizedR(100, 0, 10), null);
});

test('computeRealizedR: returns null when any input is a non-number', () => {
  assert.equal(computeRealizedR('100', 10, 10), null);
  assert.equal(computeRealizedR(100, undefined, 10), null);
});

test('computeRealizedR: zero pnl is exactly 0R, not null', () => {
  assert.equal(computeRealizedR(0, 10, 10), 0);
});
