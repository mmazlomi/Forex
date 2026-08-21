'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rankByCompositeScore, minMaxNormalize, DEFAULT_MIN_TRADE_COUNT } = require('../../src/services/backtesting/composite-score');

function metrics(overrides) {
  return {
    expectancy: 0, profitFactor: 1, maxDrawdownPercent: 10, sharpeRatio: 0, winRatePercent: 50, totalPnlPercent: 0, tradeCount: 50,
    ...overrides,
  };
}

test('minMaxNormalize scales a range to [0,1], preserving order', () => {
  const result = minMaxNormalize([10, 20, 30]);
  assert.deepEqual(result, [0, 0.5, 1]);
});

test('minMaxNormalize returns 0.5 for every entry in a flat (zero-range) population', () => {
  const result = minMaxNormalize([5, 5, 5]);
  assert.deepEqual(result, [0.5, 0.5, 0.5]);
});

test('rankByCompositeScore: empty input returns empty output', () => {
  assert.deepEqual(rankByCompositeScore([]), []);
});

test('rankByCompositeScore: a strictly-better-on-every-metric candidate ranks first', () => {
  const better = { label: 'better', metrics: metrics({ expectancy: 10, profitFactor: 2, maxDrawdownPercent: 5, sharpeRatio: 1.5, winRatePercent: 60, totalPnlPercent: 20 }) };
  const worse = { label: 'worse', metrics: metrics({ expectancy: 1, profitFactor: 1.1, maxDrawdownPercent: 30, sharpeRatio: 0.2, winRatePercent: 45, totalPnlPercent: 2 }) };
  const ranked = rankByCompositeScore([worse, better]);
  assert.equal(ranked[0].label, 'better');
  assert.ok(ranked[0].compositeScore > ranked[1].compositeScore);
});

test('rankByCompositeScore: higher maxDrawdownPercent scores WORSE, all else equal (inverted, not just summed)', () => {
  const lowDrawdown = { label: 'low-dd', metrics: metrics({ maxDrawdownPercent: 5 }) };
  const highDrawdown = { label: 'high-dd', metrics: metrics({ maxDrawdownPercent: 50 }) };
  const ranked = rankByCompositeScore([highDrawdown, lowDrawdown]);
  assert.equal(ranked[0].label, 'low-dd');
});

test('rankByCompositeScore: never optimizes purely for net profit — a high-drawdown, low-Sharpe "winner" can lose to a steadier, lower-profit candidate', () => {
  const flashy = { label: 'flashy', metrics: metrics({ totalPnlPercent: 100, maxDrawdownPercent: 80, sharpeRatio: 0.1, profitFactor: 1.05, expectancy: 0.5, winRatePercent: 30 }) };
  const steady = { label: 'steady', metrics: metrics({ totalPnlPercent: 15, maxDrawdownPercent: 8, sharpeRatio: 2.5, profitFactor: 2.2, expectancy: 5, winRatePercent: 65 }) };
  const ranked = rankByCompositeScore([flashy, steady]);
  assert.equal(ranked[0].label, 'steady');
});

test('rankByCompositeScore: a profitFactor of Infinity (zero losers) is treated as excellent, not as a crash/NaN', () => {
  const perfect = { label: 'perfect', metrics: metrics({ profitFactor: Infinity }) };
  const normal = { label: 'normal', metrics: metrics({ profitFactor: 1.5 }) };
  const ranked = rankByCompositeScore([normal, perfect]);
  assert.ok(Number.isFinite(ranked[0].compositeScore));
  assert.ok(Number.isFinite(ranked[1].compositeScore));
  assert.equal(ranked[0].label, 'perfect');
});

test(`rankByCompositeScore: a candidate with fewer than ${DEFAULT_MIN_TRADE_COUNT} trades is always ranked last, regardless of how good its raw numbers look`, () => {
  const tinyButFlashy = { label: 'tiny-sample', metrics: metrics({ tradeCount: 2, totalPnlPercent: 500, profitFactor: 10, expectancy: 50 }) };
  const normal = { label: 'normal-sample', metrics: metrics({ tradeCount: 100, totalPnlPercent: 5 }) };
  const ranked = rankByCompositeScore([tinyButFlashy, normal]);
  assert.equal(ranked[0].label, 'normal-sample');
  assert.equal(ranked[1].label, 'tiny-sample');
  assert.equal(ranked[1].compositeScore, -Infinity);
  assert.ok(ranked[1].disqualifiedReason.includes('2 trade'));
});

test('rankByCompositeScore: does not mutate the input array or its entries', () => {
  const input = [{ label: 'a', metrics: metrics() }];
  const before = JSON.stringify(input);
  rankByCompositeScore(input);
  assert.equal(JSON.stringify(input), before);
});

test('rankByCompositeScore: tolerates plain computeMetrics() output missing expectancy/sharpeRatio (spot engine compatibility)', () => {
  const plainMetrics = { profitFactor: 1.5, maxDrawdownPercent: 10, winRatePercent: 55, totalPnlPercent: 8, tradeCount: 30 };
  const ranked = rankByCompositeScore([{ label: 'plain', metrics: plainMetrics }]);
  assert.ok(Number.isFinite(ranked[0].compositeScore));
});
