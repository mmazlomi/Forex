'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCandles, timeframeToMs } = require('../../src/services/market-data/candle-validator');

function candle(overrides = {}) {
  return { tsUtc: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 10, ...overrides };
}

test('accepts a well-formed, monotonically increasing series', () => {
  const c1 = candle({ tsUtc: 0 });
  const c2 = candle({ tsUtc: timeframeToMs('1h') });
  const { valid, errors } = validateCandles([c1, c2], '1h');
  assert.equal(valid.length, 2);
  assert.equal(errors.length, 0);
});

test('rejects non-finite values', () => {
  const c = candle({ close: NaN });
  const { valid, errors } = validateCandles([c], '1h');
  assert.equal(valid.length, 0);
  assert.equal(errors[0].reason, 'non_finite_value');
});

test('rejects a candle whose high is below open/close', () => {
  const c = candle({ high: 50, open: 100, close: 100.5 });
  const { valid, errors } = validateCandles([c], '1h');
  assert.equal(valid.length, 0);
  assert.equal(errors[0].reason, 'high_below_open_close');
});

test('rejects a candle whose low is above open/close', () => {
  const c = candle({ low: 200, open: 100, close: 100.5 });
  const { valid, errors } = validateCandles([c], '1h');
  assert.equal(valid.length, 0);
  assert.equal(errors[0].reason, 'low_above_open_close');
});

test('rejects negative volume', () => {
  const c = candle({ volume: -5 });
  const { valid, errors } = validateCandles([c], '1h');
  assert.equal(valid.length, 0);
  assert.equal(errors[0].reason, 'negative_volume');
});

test('rejects non-monotonic (out-of-order or duplicate) timestamps', () => {
  const c1 = candle({ tsUtc: 1000 });
  const c2 = candle({ tsUtc: 1000 }); // duplicate
  const { valid, errors } = validateCandles([c1, c2], '1h');
  assert.equal(valid.length, 1);
  assert.equal(errors[0].reason, 'non_monotonic_timestamp');
});

test('flags a data gap as a warning but still accepts the candle', () => {
  const c1 = candle({ tsUtc: 0 });
  const c2 = candle({ tsUtc: timeframeToMs('1h') * 10 }); // huge gap
  const { valid, errors } = validateCandles([c1, c2], '1h');
  assert.equal(valid.length, 2); // both accepted
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'data_gap');
});

test('timeframeToMs throws on an unsupported timeframe', () => {
  assert.throws(() => timeframeToMs('3h'));
});
