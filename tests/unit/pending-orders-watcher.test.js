'use strict';

// checkFillCondition is the core trigger-direction logic pending-orders-watcher.js uses for
// every demo order type — pure and side-effect-free, so tested directly here rather than only
// indirectly through the slower HTTP-level integration tests (tests/integration/pending-orders.test.js,
// tests/integration/oco-orders.test.js), which exercise it end to end but are more expensive to
// run and harder to pin exact boundary conditions with.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkFillCondition } = require('../../src/services/scheduler/pending-orders-watcher');

test('limit buy fills at-or-below the limit price, not above it', () => {
  const order = { side: 'buy', order_type: 'limit', limit_price: 48000 };
  assert.equal(checkFillCondition(order, 48001).shouldFill, false);
  assert.equal(checkFillCondition(order, 48000).shouldFill, true);
  assert.equal(checkFillCondition(order, 47000).shouldFill, true);
  assert.equal(checkFillCondition(order, 47000).fillPrice, 48000); // fills at the limit price, not the (better) current price
});

test('limit sell (take-profit exit) fills at-or-above the limit price, not below it', () => {
  const order = { side: 'sell', order_type: 'limit', limit_price: 55000 };
  assert.equal(checkFillCondition(order, 54999).shouldFill, false);
  assert.equal(checkFillCondition(order, 55000).shouldFill, true);
  assert.equal(checkFillCondition(order, 56000).shouldFill, true);
});

test('stop-market buy (breakout entry) triggers on price rising through it, fills at the current price', () => {
  const order = { side: 'buy', order_type: 'stop_market', trigger_price: 52000 };
  assert.equal(checkFillCondition(order, 51999).shouldFill, false);
  const result = checkFillCondition(order, 52500);
  assert.equal(result.shouldFill, true);
  assert.equal(result.fillPrice, 52500); // current price, not the trigger price
});

test('stop-market sell (stop-loss exit) triggers on price falling through it — the direction that matters most to get right', () => {
  const order = { side: 'sell', order_type: 'stop_market', trigger_price: 45000 };
  assert.equal(checkFillCondition(order, 45001).shouldFill, false);
  assert.equal(checkFillCondition(order, 45000).shouldFill, true);
  assert.equal(checkFillCondition(order, 44000).shouldFill, true);
});

test('stop-limit buy only fills once BOTH triggered and within the limit, in the same or a later cycle', () => {
  const order = { side: 'buy', order_type: 'stop_limit', trigger_price: 52000, limit_price: 52200 };
  assert.equal(checkFillCondition(order, 51000).shouldFill, false); // not triggered yet
  assert.equal(checkFillCondition(order, 52500).shouldFill, false); // triggered, but past the limit already
  const result = checkFillCondition(order, 52100);
  assert.equal(result.shouldFill, true);
  assert.equal(result.fillPrice, 52200); // fills at the limit price once both conditions hold
});

test('an unrecognized order_type never fills (fails closed, not open)', () => {
  const order = { side: 'buy', order_type: 'something_unexpected', limit_price: 48000 };
  assert.equal(checkFillCondition(order, 1).shouldFill, false);
});
