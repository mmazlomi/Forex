'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const spotWalkForward = require('../../src/services/backtesting/spot-walk-forward');
const reversalWalkForward = require('../../src/services/backtesting/reversal-walk-forward');
const { compareFixedVsAdaptive, aggregateMetricsForComposite } = require('../../src/services/backtesting/adaptive-tp-comparison');

function fakeWindow(overrides = {}) {
  return {
    startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-02-01T00:00:00.000Z',
    metrics: {
      tradeCount: 20, profitFactor: 1.5, expectancy: 5, maxDrawdownPercent: 10,
      sharpeRatio: 1.2, winRatePercent: 55, totalPnlPercent: 8,
      ...overrides,
    },
    warningCount: 0,
  };
}

test('aggregateMetricsForComposite sums tradeCount across windows and averages every other field', () => {
  const windows = [
    fakeWindow({ tradeCount: 10, profitFactor: 1.0, winRatePercent: 40 }),
    fakeWindow({ tradeCount: 30, profitFactor: 2.0, winRatePercent: 60 }),
  ];
  const agg = aggregateMetricsForComposite(windows);
  assert.equal(agg.tradeCount, 40);
  assert.equal(agg.profitFactor, 1.5);
  assert.equal(agg.winRatePercent, 50);
});

test('aggregateMetricsForComposite excludes Infinity profitFactor windows from the average (matches composite-score.js\'s own convention)', () => {
  const windows = [fakeWindow({ profitFactor: Infinity }), fakeWindow({ profitFactor: 2.0 })];
  const agg = aggregateMetricsForComposite(windows);
  assert.equal(agg.profitFactor, 2.0);
});

test('aggregateMetricsForComposite treats a missing expectancy/sharpeRatio (spot engine\'s plainer metrics) as 0, not NaN', () => {
  const windows = [{ metrics: { tradeCount: 10, profitFactor: 1.2, maxDrawdownPercent: 5, winRatePercent: 50, totalPnlPercent: 3 } }];
  const agg = aggregateMetricsForComposite(windows);
  assert.equal(agg.expectancy, 0);
  assert.equal(agg.sharpeRatio, 0);
});

test('compareFixedVsAdaptive calls the spot walk-forward engine twice — once with no adaptiveTpConfig, once with it — over identical inputs', async (t) => {
  const calls = [];
  t.mock.method(spotWalkForward, 'runSpotWalkForward', async (opts) => {
    calls.push(opts);
    return { windows: [fakeWindow()], aggregate: {} };
  });

  await compareFixedVsAdaptive({
    engine: 'spot', symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-06-01T00:00:00.000Z',
    adaptiveTpConfig: { tp1AtrMultiplier: 1.5 },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].adaptiveTpConfig, undefined, 'the fixed run omits adaptiveTpConfig entirely, not an empty object');
  assert.deepEqual(calls[1].adaptiveTpConfig, { tp1AtrMultiplier: 1.5 });
  assert.equal(calls[0].symbol, 'BTC/USDT');
  assert.equal(calls[1].symbol, 'BTC/USDT');
});

test('compareFixedVsAdaptive routes to the reversal walk-forward engine when engine: "reversal"', async (t) => {
  const spotSpy = t.mock.method(spotWalkForward, 'runSpotWalkForward', async () => { throw new Error('must not be called'); });
  const reversalSpy = t.mock.method(reversalWalkForward, 'runReversalWalkForward', async () => ({ windows: [fakeWindow()], aggregate: {} }));

  await compareFixedVsAdaptive({ engine: 'reversal', symbol: 'BTC/USDT:USDT', exchange: 'kucoin', market: 'futures', startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-06-01T00:00:00.000Z' });

  assert.equal(spotSpy.mock.callCount(), 0);
  assert.equal(reversalSpy.mock.callCount(), 2);
});

test('compareFixedVsAdaptive picks the higher-composite-score run as the winner', async (t) => {
  let call = 0;
  t.mock.method(spotWalkForward, 'runSpotWalkForward', async () => {
    call += 1;
    // First call = fixed (mediocre), second = adaptive (clearly better on every axis).
    return { windows: [fakeWindow(call === 1 ? { profitFactor: 1.1, winRatePercent: 45, totalPnlPercent: 2 } : { profitFactor: 3.0, winRatePercent: 65, totalPnlPercent: 15 })], aggregate: {} };
  });

  const result = await compareFixedVsAdaptive({ engine: 'spot', symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-06-01T00:00:00.000Z' });
  assert.equal(result.winner, 'adaptive');
  assert.equal(result.ranked[0].label, 'adaptive');
});

test('compareFixedVsAdaptive: winner is null when the top-ranked run is disqualified for too few trades', async (t) => {
  t.mock.method(spotWalkForward, 'runSpotWalkForward', async () => ({ windows: [fakeWindow({ tradeCount: 2 })], aggregate: {} }));

  const result = await compareFixedVsAdaptive({ engine: 'spot', symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-06-01T00:00:00.000Z' });
  assert.equal(result.winner, null);
  assert.ok(result.ranked[0].disqualifiedReason);
});
