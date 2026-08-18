'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findChochLevel, isChochBreak } = require('../../../src/services/reversal-strategy/market-structure');

function candle(open, high, low, close) {
  return { open, high, low, close };
}

test('findChochLevel (bullish) resolves the most recent confirmed swing high at or before the sweep bar', () => {
  const candles = [
    candle(10, 12, 10, 11), // 0
    candle(11, 13, 11, 12), // 1
    candle(12, 20, 12, 13), // 2 swing high @20, confirmed at index 4
    candle(13, 14, 13, 13), // 3
    candle(13, 15, 12, 12), // 4 confirmation bar
    candle(12, 16, 11, 11), // 5 sweep bar (arbitrary for this test)
  ];
  const level = findChochLevel(candles, 5, 'bullish', 2);
  assert.ok(level);
  assert.equal(level.index, 2);
  assert.equal(level.price, 20);
});

test('findChochLevel (bearish) resolves the most recent confirmed swing low at or before the sweep bar', () => {
  const candles = [
    candle(20, 20, 18, 19), candle(19, 19, 17, 18), candle(18, 18, 10, 17),
    candle(17, 17, 15, 16), candle(16, 16, 14, 15), candle(15, 15, 13, 14),
  ];
  const level = findChochLevel(candles, 5, 'bearish', 2);
  assert.ok(level);
  assert.equal(level.index, 2);
  assert.equal(level.price, 10);
});

test('findChochLevel returns null when no qualifying prior swing exists', () => {
  const candles = [candle(10, 11, 9, 10), candle(10, 11, 9, 10)];
  assert.equal(findChochLevel(candles, 1, 'bullish', 2), null);
});

test('isChochBreak (close basis, default): requires the close beyond the level, not just a wick touch', () => {
  const level = { index: 0, price: 100 };
  const wickOnly = candle(95, 101, 94, 96); // high pokes above 100 but closes back below
  assert.equal(isChochBreak([wickOnly], 0, level, 'bullish', 'close'), false);
  assert.equal(isChochBreak([wickOnly], 0, level, 'bullish', 'wick'), true);

  const trueBreak = candle(99, 102, 98, 101); // closes above 100
  assert.equal(isChochBreak([trueBreak], 0, level, 'bullish', 'close'), true);
});

test('isChochBreak bearish direction mirrors bullish using lows/close-below', () => {
  const level = { index: 0, price: 100 };
  const wickOnly = candle(105, 106, 99, 104); // low pokes below 100 but closes back above
  assert.equal(isChochBreak([wickOnly], 0, level, 'bearish', 'close'), false);
  assert.equal(isChochBreak([wickOnly], 0, level, 'bearish', 'wick'), true);

  const trueBreak = candle(101, 102, 97, 98); // closes below 100
  assert.equal(isChochBreak([trueBreak], 0, level, 'bearish', 'close'), true);
});
