'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { latestClosedCandleIndexAsOf, createLookaheadSafeCursor } = require('../../../src/services/reversal-strategy/timeframe-alignment');

const HOUR = 60 * 60 * 1000;

function htfCandles(openTimes) {
  return openTimes.map((tsUtc) => ({ tsUtc, open: 1, high: 1, low: 1, close: 1 }));
}

test('latestClosedCandleIndexAsOf returns the last candle whose close time (open + timeframeMs) has passed', () => {
  const candles = htfCandles([0, HOUR, 2 * HOUR, 3 * HOUR]); // closes at 1h, 2h, 3h, 4h respectively
  assert.equal(latestClosedCandleIndexAsOf(candles, HOUR, HOUR), 0); // candle 0 just closed exactly now
  assert.equal(latestClosedCandleIndexAsOf(candles, HOUR, HOUR - 1), -1); // candle 0 not closed yet
  assert.equal(latestClosedCandleIndexAsOf(candles, HOUR, 3 * HOUR + 1), 2); // candle 2 closed, candle 3 (closes at 4h) has not
  assert.equal(latestClosedCandleIndexAsOf(candles, HOUR, 100 * HOUR), 3); // far in the future -> last candle
});

test('latestClosedCandleIndexAsOf never returns a candle that has not fully closed (no lookahead)', () => {
  const candles = htfCandles([0, HOUR, 2 * HOUR]);
  // Exactly at candle 1's open time — candle 1 is still forming, must not be visible.
  const idx = latestClosedCandleIndexAsOf(candles, HOUR, HOUR + 1);
  assert.equal(idx, 0);
  assert.ok(candles[idx].tsUtc + HOUR <= HOUR + 1);
});

test('createLookaheadSafeCursor advances monotonically and matches the linear-scan result', () => {
  const candles = htfCandles([0, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]);
  const cursor = createLookaheadSafeCursor(candles, HOUR);

  const queryTimes = [HOUR - 1, HOUR, 2 * HOUR + 500, 3 * HOUR + 1, 10 * HOUR];
  for (const t of queryTimes) {
    const viaCursor = cursor.advanceTo(t);
    const expectedIndex = latestClosedCandleIndexAsOf(candles, HOUR, t);
    if (expectedIndex === -1) {
      assert.equal(viaCursor, null, `mismatch at t=${t}`);
    } else {
      assert.deepEqual(viaCursor, { index: expectedIndex, candle: candles[expectedIndex] }, `mismatch at t=${t}`);
    }
  }
});

test('createLookaheadSafeCursor throws if fed a timestamp earlier than a previous call (forward-only contract)', () => {
  const candles = htfCandles([0, HOUR, 2 * HOUR]);
  const cursor = createLookaheadSafeCursor(candles, HOUR);
  cursor.advanceTo(2 * HOUR);
  assert.throws(() => cursor.advanceTo(HOUR), /forward-only/);
});
