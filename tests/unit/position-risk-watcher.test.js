'use strict';

// checkSpotTrigger/checkFuturesTrigger are the core stop-loss/take-profit trigger-direction logic
// position-risk-watcher.js uses for every open position — pure and side-effect-free, tested
// directly here rather than only indirectly through the slower integration tests, matching the
// convention pending-orders-watcher.test.js already established for checkFillCondition.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkSpotTrigger, checkFuturesTrigger, computeSpotTrailingUpdate, computeFuturesTrailingUpdate,
} = require('../../src/services/scheduler/position-risk-watcher');

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

test('computeSpotTrailingUpdate: no update when trailing_percent is not set', () => {
  const position = { trailing_percent: null, entry_price: 100, stop_loss: 90 };
  assert.equal(computeSpotTrailingUpdate(position, 150), null);
});

test('computeSpotTrailingUpdate: seeds the high-water-mark from entry_price on the first favorable tick', () => {
  const position = { trailing_percent: 2, entry_price: 100, stop_loss: 90, trailing_high_water_mark: null };
  const update = computeSpotTrailingUpdate(position, 110);
  assert.deepEqual(update, { stopLoss: 110 * 0.98, highWaterMark: 110 });
});

test('computeSpotTrailingUpdate: no update when price has not made a new high since the last check', () => {
  const position = { trailing_percent: 2, entry_price: 100, stop_loss: 107.8, trailing_high_water_mark: 110 };
  assert.equal(computeSpotTrailingUpdate(position, 105), null, 'price pulled back but stayed below the recorded high — nothing to ratchet');
  assert.equal(computeSpotTrailingUpdate(position, 110), null, 'exactly matching the prior high is not a NEW high');
});

test('computeSpotTrailingUpdate: ratchets the stop up (never down) as price makes new highs', () => {
  const position = { trailing_percent: 2, entry_price: 100, stop_loss: 107.8, trailing_high_water_mark: 110 };
  const update = computeSpotTrailingUpdate(position, 120);
  assert.deepEqual(update, { stopLoss: 120 * 0.98, highWaterMark: 120 });
  assert.ok(update.stopLoss > position.stop_loss, 'the new stop must be strictly higher than the old one');
});

test('computeFuturesTrailingUpdate long: behaves exactly like spot — high-water-mark and stop both rise with price', () => {
  const position = { side: 'long', trailing_percent: 2, entry_price: 60000, stop_loss: 58800, trailing_high_water_mark: 60000 };
  assert.equal(computeFuturesTrailingUpdate(position, 60000), null, 'no new high, no update');
  const update = computeFuturesTrailingUpdate(position, 65000);
  assert.deepEqual(update, { stopLoss: 65000 * 0.98, highWaterMark: 65000 });
});

test('computeFuturesTrailingUpdate short: high-water-mark and stop both fall as price falls (mirror image of long)', () => {
  const position = { side: 'short', trailing_percent: 2, entry_price: 60000, stop_loss: 61200, trailing_high_water_mark: 60000 };
  assert.equal(computeFuturesTrailingUpdate(position, 61000), null, 'price rose — unfavorable for a short, no update');
  const update = computeFuturesTrailingUpdate(position, 55000);
  assert.deepEqual(update, { stopLoss: 55000 * 1.02, highWaterMark: 55000 });
  assert.ok(update.stopLoss < position.stop_loss, 'a short\'s new stop must be strictly lower (tighter) than the old one');
});
