'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTrendFilter } = require('../../../src/services/reversal-strategy/htf-trend-filter');
const { mergeConfig } = require('../../../src/services/reversal-strategy/config');

// Ichimoku needs warmupPeriod(52) + displacement(26) = 78 candles minimum to report 'ok' with
// default periods — see technical-analysis/ichimoku.js.
function trendCandles(startPrice, stepPerBar, count) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price += stepPerBar;
    const close = price;
    candles.push({ open, close, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5 });
  }
  return candles;
}

test('a steady uptrend allows LONG and not SHORT under the default (all-conditions-required) filter', () => {
  const candles = trendCandles(100, 1, 120);
  const config = mergeConfig();
  const result = evaluateTrendFilter(candles, candles.length - 1, config);
  assert.ok(result.allowedDirections.includes('bullish'));
  assert.ok(!result.allowedDirections.includes('bearish'));
  assert.ok(result.kijunSlope > 0);
});

test('a steady downtrend allows SHORT and not LONG under the default filter', () => {
  const candles = trendCandles(500, -1, 120);
  const config = mergeConfig();
  const result = evaluateTrendFilter(candles, candles.length - 1, config);
  assert.ok(result.allowedDirections.includes('bearish'));
  assert.ok(!result.allowedDirections.includes('bullish'));
  assert.ok(result.kijunSlope < 0);
});

test('insufficient HTF history vetoes both directions regardless of config', () => {
  const candles = trendCandles(100, 1, 30); // well short of the 78-candle Ichimoku warmup
  const config = mergeConfig();
  const result = evaluateTrendFilter(candles, candles.length - 1, config);
  assert.deepEqual(result.allowedDirections, []);
});

test('disabling every sub-condition allows both directions once there is enough history (filter effectively off)', () => {
  const candles = trendCandles(100, 1, 120);
  const config = mergeConfig({
    htfFilter: { requirePriceVsCloud: false, requireTenkanKijunCross: false, requireKijunSlope: false },
  });
  const result = evaluateTrendFilter(candles, candles.length - 1, config);
  assert.deepEqual(result.allowedDirections.sort(), ['bearish', 'bullish']);
});

test('a choppy/flat market with no clear structure denies at least one direction under the default filter', () => {
  const candles = [];
  let price = 100;
  for (let i = 0; i < 120; i += 1) {
    price += (i % 2 === 0 ? 1 : -1) * 0.5; // oscillates, no net trend
    candles.push({ open: price, close: price, high: price + 0.3, low: price - 0.3 });
  }
  const config = mergeConfig();
  const result = evaluateTrendFilter(candles, candles.length - 1, config);
  // A flat/choppy market shouldn't cleanly satisfy BOTH direction's full condition sets at once.
  assert.ok(result.allowedDirections.length < 2);
});
