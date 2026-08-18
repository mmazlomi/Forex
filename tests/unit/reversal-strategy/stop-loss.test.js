'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStopLoss } = require('../../../src/services/reversal-strategy/stop-loss');
const { mergeConfig } = require('../../../src/services/reversal-strategy/config');

function candle(open, high, low, close) {
  return { open, high, low, close };
}

test('sweep_extreme model (bullish): SL is the sweep low with a small buffer below it', () => {
  const config = mergeConfig({ slModel: 'sweep_extreme', slBufferPercent: 1 });
  const sweep = { sweepIndex: 0, sweepLow: 100, sweepHigh: 105 };
  const sl = computeStopLoss([], sweep, 'bullish', config);
  assert.equal(sl, 100 * 0.99);
});

test('sweep_extreme model (bearish): SL is the sweep high with a small buffer above it', () => {
  const config = mergeConfig({ slModel: 'sweep_extreme', slBufferPercent: 1 });
  const sweep = { sweepIndex: 0, sweepLow: 100, sweepHigh: 105 };
  const sl = computeStopLoss([], sweep, 'bearish', config);
  assert.equal(sl, 105 * 1.01);
});

test('atr model (bullish): SL = sweepLow - ATR * multiplier', () => {
  const config = mergeConfig({ slModel: 'atr', atrPeriod: 3, atrMultiplier: 2 });
  // Simple, deterministic high-low range candles so ATR is easy to reason about.
  const candles = [
    candle(10, 12, 8, 10), candle(10, 13, 9, 11), candle(11, 14, 10, 12), candle(12, 15, 11, 13),
  ];
  const sweep = { sweepIndex: 3, sweepLow: 100, sweepHigh: 105 };
  const sl = computeStopLoss(candles, sweep, 'bullish', config);
  assert.ok(typeof sl === 'number' && sl < 100); // must be below the sweep low
});

test('atr model returns null when there is not enough ATR history yet', () => {
  const config = mergeConfig({ slModel: 'atr', atrPeriod: 14 });
  const candles = [candle(10, 11, 9, 10), candle(10, 11, 9, 10)];
  const sweep = { sweepIndex: 1, sweepLow: 100, sweepHigh: 105 };
  assert.equal(computeStopLoss(candles, sweep, 'bullish', config), null);
});

test('atr model never reads candles after the sweep bar', () => {
  const config = mergeConfig({ slModel: 'atr', atrPeriod: 3, atrMultiplier: 2 });
  const before = [candle(10, 12, 8, 10), candle(10, 13, 9, 11), candle(11, 14, 10, 12), candle(12, 15, 11, 13)];
  const after = [...before, candle(13, 100, 1, 50)]; // a wild future candle that would blow up ATR if leaked in
  const sweep = { sweepIndex: 3, sweepLow: 100, sweepHigh: 105 };
  assert.equal(computeStopLoss(before, sweep, 'bullish', config), computeStopLoss(after, sweep, 'bullish', config));
});
