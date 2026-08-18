'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSweep } = require('../../../src/services/reversal-strategy/liquidity-sweep-detector');
const { mergeConfig } = require('../../../src/services/reversal-strategy/config');

function candle(open, high, low, close) {
  return { open, high, low, close };
}

test('detects a bullish sweep: price trades below a confirmed swing low then closes back above it', () => {
  const config = mergeConfig({ swingLookback: 2, sweepMinPenetrationPercent: 0.05, sweepLookbackBars: 50 });
  const candles = [
    candle(20, 20, 18, 19), // 0
    candle(19, 19, 17, 18), // 1
    candle(18, 18, 10, 17), // 2 swing low @10, confirmed at index 4
    candle(17, 17, 15, 16), // 3
    candle(16, 16, 14, 15), // 4 swing confirmed here
    candle(15, 15, 13, 14), // 5
    candle(14, 14, 9.9, 10.5), // 6 sweeps below 10 (penetration), closes back above 10 -> bullish sweep
  ];
  const result = detectSweep(candles, 6, config);
  assert.ok(result);
  assert.equal(result.direction, 'bullish');
  assert.equal(result.sweptSwingIndex, 2);
  assert.equal(result.sweptLevel, 10);
  assert.equal(result.sweepLow, 9.9);
});

test('detects a bearish sweep: price trades above a confirmed swing high then closes back below it', () => {
  const config = mergeConfig({ swingLookback: 2, sweepMinPenetrationPercent: 0.05, sweepLookbackBars: 50 });
  const candles = [
    candle(10, 12, 10, 11),
    candle(11, 13, 11, 12),
    candle(12, 20, 12, 13), // swing high @20, confirmed at index 4
    candle(13, 14, 13, 13),
    candle(13, 15, 12, 12),
    candle(12, 16, 11, 11),
    candle(11, 20.5, 10, 18), // sweeps above 20, closes back below 20 -> bearish sweep
  ];
  const result = detectSweep(candles, 6, config);
  assert.ok(result);
  assert.equal(result.direction, 'bearish');
  assert.equal(result.sweptSwingIndex, 2);
  assert.equal(result.sweptLevel, 20);
});

test('no sweep when price penetrates but does NOT reclaim (close stays beyond the level)', () => {
  const config = mergeConfig({ swingLookback: 2 });
  const candles = [
    candle(20, 20, 18, 19), candle(19, 19, 17, 18), candle(18, 18, 10, 17),
    candle(17, 17, 15, 16), candle(16, 16, 14, 15), candle(15, 15, 13, 14),
    candle(14, 14, 9, 9.5), // penetrates below 10 but closes at 9.5, still below the level -> no reclaim
  ];
  assert.equal(detectSweep(candles, 6, config), null);
});

test('no sweep when penetration is below the configured minimum threshold', () => {
  const config = mergeConfig({ swingLookback: 2, sweepMinPenetrationPercent: 5 }); // demand a big 5% penetration
  const candles = [
    candle(20, 20, 18, 19), candle(19, 19, 17, 18), candle(18, 18, 10, 17),
    candle(17, 17, 15, 16), candle(16, 16, 14, 15), candle(15, 15, 13, 14),
    candle(14, 14, 9.9, 10.2), // only ~1% penetration, threshold demands 5%
  ];
  assert.equal(detectSweep(candles, 6, config), null);
});

test('no sweep when the swing being tested is older than sweepLookbackBars', () => {
  const config = mergeConfig({ swingLookback: 1, sweepLookbackBars: 2 });
  const candles = [
    candle(18, 18, 10, 17), // 0
    candle(17, 17, 15, 16), // 1
    candle(16, 16, 14, 15), // 2 swing low @10 at index 0 confirmed here (lookback 1)
    candle(15, 15, 13, 14), // 3
    candle(14, 14, 13, 13.5), // 4
    candle(13.5, 13.5, 12, 13), // 5
    candle(13, 13, 9.5, 10.5), // 6 -> distance from swing (index 0) is 6, exceeds sweepLookbackBars=2
  ];
  assert.equal(detectSweep(candles, 6, config), null);
});

test('no sweep at all when there is no confirmed swing yet', () => {
  const config = mergeConfig();
  const candles = [candle(10, 11, 9, 10), candle(10, 11, 9, 10)];
  assert.equal(detectSweep(candles, 1, config), null);
});
