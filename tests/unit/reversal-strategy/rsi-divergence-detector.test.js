'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectDivergence, rsiValueAtIndex } = require('../../../src/services/reversal-strategy/rsi-divergence-detector');
const { mergeConfig } = require('../../../src/services/reversal-strategy/config');

function candlesFromCloses(closes) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { open, close, high: Math.max(open, close) + 0.01, low: Math.min(open, close) - 0.01 };
  });
}

function makeSweep({ sweepIndex, sweptSwingIndex, direction }) {
  return { sweepIndex, sweptSwingIndex, direction, sweptLevel: 100, sweepLow: 90, sweepHigh: 110, sweepClose: 95 };
}

// Both generators below were verified against the real `technicalindicators` RSI implementation
// (not hand-computed) — see the git history of this file for the throwaway script used to check
// RSI(19) vs RSI(39) and close(19) vs close(39) before pinning these exact step sizes.
function buildBullishDivergenceCloses() {
  const closes = [200];
  for (let i = 0; i < 9; i += 1) {
    closes.push(closes[closes.length - 1] - 3); // steep leg down (indices 1-18, alternating)
    closes.push(closes[closes.length - 1] + 0.5);
  }
  closes.push(closes[closes.length - 1] - 3); // index 19: sharp, low-RSI swing low
  for (let i = 0; i < 10; i += 1) {
    closes.push(closes[closes.length - 1] - 1); // choppier, more-balanced leg to a marginal new low
    closes.push(closes[closes.length - 1] + 0.85);
  }
  return closes; // length 40; close[39] < close[19] (genuine lower low), RSI[39] > RSI[19]
}

function buildBearishDivergenceCloses() {
  const closes = [200];
  for (let i = 0; i < 9; i += 1) {
    closes.push(closes[closes.length - 1] + 3);
    closes.push(closes[closes.length - 1] - 0.5);
  }
  closes.push(closes[closes.length - 1] + 3); // index 19: sharp, high-RSI swing high
  for (let i = 0; i < 10; i += 1) {
    closes.push(closes[closes.length - 1] + 1);
    closes.push(closes[closes.length - 1] - 0.85);
  }
  return closes; // close[39] > close[19] (genuine higher high), RSI[39] < RSI[19]
}

test('confirms bullish divergence when RSI at the sweep bar is higher than RSI at the swept swing bar', () => {
  const config = mergeConfig({ rsiPeriod: 14, maxDivergenceDistanceBars: 50 });
  const candles = candlesFromCloses(buildBullishDivergenceCloses());
  assert.ok(candles[39].close < candles[19].close, 'sanity: sweep bar must be a genuine lower low');

  const sweep = makeSweep({ sweepIndex: 39, sweptSwingIndex: 19, direction: 'bullish' });
  const result = detectDivergence(candles, sweep, config);
  assert.ok(result, 'expected bullish divergence to be confirmed');
  assert.equal(result.direction, 'bullish');
  assert.ok(result.rsiAtSweep > result.rsiAtSwing);
});

test('confirms bearish divergence when RSI at the sweep bar is lower than RSI at the swept swing bar', () => {
  const config = mergeConfig({ rsiPeriod: 14, maxDivergenceDistanceBars: 50 });
  const candles = candlesFromCloses(buildBearishDivergenceCloses());
  assert.ok(candles[39].close > candles[19].close, 'sanity: sweep bar must be a genuine higher high');

  const sweep = makeSweep({ sweepIndex: 39, sweptSwingIndex: 19, direction: 'bearish' });
  const result = detectDivergence(candles, sweep, config);
  assert.ok(result, 'expected bearish divergence to be confirmed');
  assert.equal(result.direction, 'bearish');
  assert.ok(result.rsiAtSweep < result.rsiAtSwing);
});

test('does NOT confirm divergence when momentum simply confirms the new price extreme (no divergence)', () => {
  const config = mergeConfig({ rsiPeriod: 14, maxDivergenceDistanceBars: 50 });
  // Uniformly steep decline the whole way — momentum stays low/steep at the new low too, so RSI
  // at the sweep bar should NOT be meaningfully higher than at the swing bar.
  const closes = [];
  for (let i = 0; i < 40; i += 1) closes.push(200 - i * 3);
  const candles = candlesFromCloses(closes);

  const sweep = makeSweep({ sweepIndex: 39, sweptSwingIndex: 19, direction: 'bullish' });
  const result = detectDivergence(candles, sweep, config);
  assert.equal(result, null);
});

test('rejects when the swept swing is farther back than maxDivergenceDistanceBars', () => {
  const config = mergeConfig({ rsiPeriod: 14, maxDivergenceDistanceBars: 10 });
  const closes = [];
  for (let i = 0; i < 40; i += 1) closes.push(100 - i);
  const candles = candlesFromCloses(closes);
  const sweep = makeSweep({ sweepIndex: 39, sweptSwingIndex: 19, direction: 'bullish' }); // distance 20 > 10
  assert.equal(detectDivergence(candles, sweep, config), null);
});

test('returns null when there is not enough history for RSI at either compared index', () => {
  const config = mergeConfig({ rsiPeriod: 14, maxDivergenceDistanceBars: 50 });
  const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
  const candles = candlesFromCloses(closes);
  const sweep = makeSweep({ sweepIndex: 15, sweptSwingIndex: 2, direction: 'bullish' }); // index 2 < rsiPeriod(14)
  assert.equal(detectDivergence(candles, sweep, config), null);
});

test('rsiValueAtIndex never reads candles after `index` (causal)', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 10);
  const candles = candlesFromCloses(closes);
  const truncated = candles.slice(0, 20); // only candles up to index 19 exist
  const full = candles; // same data, but with future candles appended
  assert.equal(rsiValueAtIndex(truncated, 19, 14), rsiValueAtIndex(full, 19, 14));
});
