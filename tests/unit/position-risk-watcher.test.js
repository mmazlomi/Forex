'use strict';

// checkSpotTrigger/checkFuturesTrigger are the core stop-loss/take-profit trigger-direction logic
// position-risk-watcher.js uses for every open position — pure and side-effect-free, tested
// directly here rather than only indirectly through the slower integration tests, matching the
// convention pending-orders-watcher.test.js already established for checkFillCondition.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSpotTrigger, checkFuturesTrigger } = require('../../src/services/scheduler/position-risk-watcher');

test('spot (long-only): stop-loss triggers at-or-below the stored level', () => {
  const position = { stop_loss: 90, take_profit: 130 };
  assert.equal(checkSpotTrigger(position, 91), null);
  assert.equal(checkSpotTrigger(position, 90), 'stop_loss');
  assert.equal(checkSpotTrigger(position, 80), 'stop_loss');
});

test('spot (long-only): take-profit triggers at-or-above the stored level', () => {
  const position = { stop_loss: 90, take_profit: 130 };
  assert.equal(checkSpotTrigger(position, 129), null);
  assert.equal(checkSpotTrigger(position, 130), 'take_profit');
  assert.equal(checkSpotTrigger(position, 200), 'take_profit');
});

test('spot: a position with only one of the two levels set only checks that one', () => {
  assert.equal(checkSpotTrigger({ stop_loss: 90, take_profit: null }, 80), 'stop_loss');
  assert.equal(checkSpotTrigger({ stop_loss: null, take_profit: 130 }, 200), 'take_profit');
  assert.equal(checkSpotTrigger({ stop_loss: null, take_profit: null }, 1), null);
});

test('futures long: same direction as spot — stop-loss below entry, take-profit above', () => {
  const position = { side: 'long', stop_loss: 50000, take_profit: 80000 };
  assert.equal(checkFuturesTrigger(position, 50001), null);
  assert.equal(checkFuturesTrigger(position, 50000), 'stop_loss');
  assert.equal(checkFuturesTrigger(position, 80000), 'take_profit');
});

test('futures short: direction is inverted — stop-loss ABOVE entry, take-profit BELOW (the case most likely to be gotten backwards)', () => {
  const position = { side: 'short', stop_loss: 65000, take_profit: 50000 };
  assert.equal(checkFuturesTrigger(position, 64999), null, 'not triggered yet, still between take-profit and stop-loss');
  assert.equal(checkFuturesTrigger(position, 65000), 'stop_loss', 'price rising through a short\'s stop-loss must trigger it');
  assert.equal(checkFuturesTrigger(position, 50000), 'take_profit', 'price falling through a short\'s take-profit must trigger it');
});

test('futures: stop-loss is checked before take-profit when (implausibly) both conditions hold', () => {
  // Not a realistic price (stop below take for a long implies stop > take is impossible given a
  // valid entry), but pins the tie-break behavior: stop-loss wins if both ever somehow match.
  const position = { side: 'long', stop_loss: 100, take_profit: 90 };
  assert.equal(checkFuturesTrigger(position, 100), 'stop_loss');
});
