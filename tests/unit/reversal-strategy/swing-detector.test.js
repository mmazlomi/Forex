'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSwings, mostRecentSwingLow, mostRecentSwingHigh } = require('../../../src/services/reversal-strategy/swing-detector');

function candle(high, low) {
  return { high, low, open: (high + low) / 2, close: (high + low) / 2 };
}

test('detectSwings finds a simple 5-bar fractal swing high and low', () => {
  // index:  0    1    2    3    4    5    6
  // high:  10   11   15   11   10   ...
  // low:    5    4    3    4    5   ...
  const candles = [
    candle(10, 5), candle(11, 4), candle(15, 3), candle(11, 4), candle(10, 5), candle(9, 6), candle(8, 7),
  ];
  const { highs, lows } = detectSwings(candles, candles.length - 1, 2);
  assert.deepEqual(highs.map((h) => h.index), [2]);
  assert.equal(highs[0].price, 15);
  assert.equal(highs[0].confirmedAtIndex, 4);
  assert.deepEqual(lows.map((l) => l.index), [2]);
  assert.equal(lows[0].price, 3);
});

test('a swing is NOT visible until its confirmation bar has closed (causality)', () => {
  const candles = [
    candle(10, 5), candle(11, 4), candle(15, 3), candle(11, 4), candle(10, 5),
  ];
  // At index 3, bar 2's right side only has 1 confirmed neighbor (bar 3) — not yet 2 — so the
  // swing at index 2 must not appear yet.
  const early = detectSwings(candles, 3, 2);
  assert.deepEqual(early.highs, []);
  // At index 4, bar 2 now has both right-side neighbors (3 and 4) closed — confirmed.
  const confirmed = detectSwings(candles, 4, 2);
  assert.deepEqual(confirmed.highs.map((h) => h.index), [2]);
});

test('equal highs do not count as a swing (strict inequality only)', () => {
  const candles = [
    candle(10, 5), candle(11, 4), candle(15, 3), candle(15, 3), candle(11, 4), candle(10, 5),
  ];
  const { highs } = detectSwings(candles, candles.length - 1, 2);
  assert.deepEqual(highs, []);
});

test('mostRecentSwingLow / mostRecentSwingHigh return the latest confirmed one, or null', () => {
  const candles = [
    candle(10, 5), candle(11, 4), candle(15, 3), candle(11, 4), candle(10, 5), candle(9, 6), candle(8, 7),
  ];
  assert.equal(mostRecentSwingLow(candles, 4, 2)?.price, 3);
  assert.equal(mostRecentSwingLow(candles, 1, 2), null); // not enough history at all
  assert.equal(mostRecentSwingHigh(candles, 4, 2)?.price, 15);
});

test('a larger swingLookback requires more confirming bars on each side', () => {
  const candles = [
    candle(10, 5), candle(11, 4), candle(15, 3), candle(11, 4), candle(10, 5), candle(9, 6), candle(8, 7),
  ];
  // swingLookback=3 needs indices 3..9 on both sides of index 3+ — only 7 candles here, so no
  // swing can be confirmed yet regardless of shape.
  const { highs, lows } = detectSwings(candles, candles.length - 1, 3);
  assert.deepEqual(highs, []);
  assert.deepEqual(lows, []);
});
