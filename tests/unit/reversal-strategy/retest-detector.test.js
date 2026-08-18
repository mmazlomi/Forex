'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { retestZone, isRetestTouch, isConfirmationCandle } = require('../../../src/services/reversal-strategy/retest-detector');

function candle(open, high, low, close) {
  return { open, high, low, close };
}

test('retestZone computes a symmetric band around the level', () => {
  const zone = retestZone(100, 0.5); // 0.5% -> +/- 0.5
  assert.equal(zone.lower, 99.5);
  assert.equal(zone.upper, 100.5);
});

test('isRetestTouch detects when a bar\'s range overlaps the zone', () => {
  const candles = [candle(102, 103, 99.8, 101)]; // low 99.8 dips into [99.5, 100.5]
  assert.equal(isRetestTouch(candles, 0, 100, 0.5), true);
});

test('isRetestTouch is false when the bar never comes near the zone', () => {
  const candles = [candle(110, 112, 108, 111)];
  assert.equal(isRetestTouch(candles, 0, 100, 0.5), false);
});

test('isConfirmationCandle (bullish) requires a same-direction candle closing clear of the zone', () => {
  const level = 100;
  const rejection = candle(99.8, 101.2, 99.6, 101); // opens inside zone, closes above upper (100.5)
  assert.equal(isConfirmationCandle([rejection], 0, level, 'bullish', 0.5), true);

  const bearishClose = candle(101, 101.2, 99.6, 99.8); // closes below open -> wrong direction
  assert.equal(isConfirmationCandle([bearishClose], 0, level, 'bullish', 0.5), false);

  const weakClose = candle(99.8, 100.3, 99.6, 100.1); // bullish but closes inside the zone, not clear of it
  assert.equal(isConfirmationCandle([weakClose], 0, level, 'bullish', 0.5), false);
});

test('isConfirmationCandle (bearish) requires a same-direction candle closing clear of the zone', () => {
  const level = 100;
  const rejection = candle(100.2, 100.4, 98.8, 99); // opens inside zone, closes below lower (99.5)
  assert.equal(isConfirmationCandle([rejection], 0, level, 'bearish', 0.5), true);

  const bullishClose = candle(99, 100.4, 98.8, 100.2);
  assert.equal(isConfirmationCandle([bullishClose], 0, level, 'bearish', 0.5), false);
});
