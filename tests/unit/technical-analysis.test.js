'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ta = require('../../src/services/technical-analysis');

function makeCandles(count, { start = 100, step = 1 } = {}) {
  const now = Date.now();
  const candles = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    price += step;
    candles.push({
      tsUtc: now - (count - i) * 3600_000,
      open: price - 0.2,
      high: price + 0.3,
      low: price - 0.3,
      close: price,
      volume: 10 + i,
    });
  }
  return candles;
}

test('SMA returns insufficient_history below the period', () => {
  const result = ta.sma.compute(makeCandles(5), { period: 20 });
  assert.equal(result.status, 'insufficient_history');
  assert.equal(result.value, null);
});

test('SMA computes a correct average once there is enough history', () => {
  const candles = [1, 2, 3, 4, 5].map((c, i) => ({ tsUtc: i, open: c, high: c, low: c, close: c, volume: 1 }));
  const result = ta.sma.compute(candles, { period: 5 });
  assert.equal(result.status, 'ok');
  assert.equal(result.value, 3);
});

test('RSI requires period + 1 candles and returns a value in [0, 100]', () => {
  const insufficient = ta.rsi.compute(makeCandles(10), { period: 14 });
  assert.equal(insufficient.status, 'insufficient_history');

  const sufficient = ta.rsi.compute(makeCandles(30), { period: 14 });
  assert.equal(sufficient.status, 'ok');
  assert.ok(sufficient.value >= 0 && sufficient.value <= 100);
});

test('MACD requires slowPeriod + signalPeriod candles', () => {
  const result = ta.macd.compute(makeCandles(30), {});
  assert.equal(result.status, 'insufficient_history');
  assert.equal(result.minRequired, 35);

  const ok = ta.macd.compute(makeCandles(60), {});
  assert.equal(ok.status, 'ok');
  assert.ok('macd' in ok.value && 'signal' in ok.value && 'histogram' in ok.value);
});

test('Bollinger Bands upper is always >= middle >= lower', () => {
  const result = ta.bollingerBands.compute(makeCandles(40), { period: 20 });
  assert.equal(result.status, 'ok');
  assert.ok(result.value.upper >= result.value.middle);
  assert.ok(result.value.middle >= result.value.lower);
});

test('ATR is non-negative once computed', () => {
  const result = ta.atr.compute(makeCandles(30), { period: 14 });
  assert.equal(result.status, 'ok');
  assert.ok(result.value >= 0);
});

test('Ichimoku requires spanPeriod + displacement candles (78 with default periods) before reporting ok', () => {
  const tooFew = ta.ichimoku.compute(makeCandles(77));
  assert.equal(tooFew.status, 'insufficient_history');
  assert.equal(tooFew.value, null);

  const justEnough = ta.ichimoku.compute(makeCandles(78));
  assert.equal(justEnough.status, 'ok');
});

test('Ichimoku cloudTop is always >= cloudBottom, and reads the cloud from `displacement` bars back (not the latest raw spanA/spanB)', () => {
  // A monotonically rising series: the most-recently-computed spanA/spanB (using the latest,
  // highest highs) would be strictly greater than the displaced (26-bars-ago) pair this
  // indicator is supposed to use — asserting against the manually-shifted expectation catches a
  // regression back to the naive "just use the latest value" bug.
  const candles = makeCandles(90);
  const result = ta.ichimoku.compute(candles);
  assert.equal(result.status, 'ok');
  assert.ok(result.value.cloudTop >= result.value.cloudBottom);

  const { IchimokuCloud } = require('technicalindicators');
  const raw = IchimokuCloud.calculate({
    high: candles.map((c) => c.high), low: candles.map((c) => c.low),
    conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26,
  });
  const expectedCloud = raw[raw.length - 1 - 26];
  assert.equal(result.value.spanA, expectedCloud.spanA);
  assert.equal(result.value.spanB, expectedCloud.spanB);
  assert.notEqual(result.value.spanA, raw[raw.length - 1].spanA); // must not be the naive "latest" value
});

test('Support/Resistance flags insufficient history correctly', () => {
  const result = ta.supportResistance.compute(makeCandles(3), { lookback: 3 });
  assert.equal(result.status, 'insufficient_history');
});

test('Volume analysis computes relative volume against the SMA of volume', () => {
  const candles = makeCandles(25);
  const result = ta.volumeAnalysis.compute(candles, { period: 20 });
  assert.equal(result.status, 'ok');
  assert.ok(result.value.relativeVolume > 0);
});

test('computeAllIndicators never throws and returns a status for every indicator', () => {
  const result = ta.computeAllIndicators(makeCandles(80));
  for (const [key, indicator] of Object.entries(result)) {
    assert.ok('status' in indicator, `${key} is missing a status field`);
  }
});

test('all indicators report NO_DATA-equivalent status on empty candles instead of throwing', () => {
  const result = ta.computeAllIndicators([]);
  for (const [key, indicator] of Object.entries(result)) {
    assert.equal(indicator.status, 'insufficient_history', `${key} should report insufficient_history on empty input`);
  }
});
