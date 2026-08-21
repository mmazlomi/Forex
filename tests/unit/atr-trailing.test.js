'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const marketDataService = require('../../src/services/market-data/market-data-service');
const {
  resolveAtrTrailingPercent, resolveTrailingPercent, MIN_TRAILING_PERCENT, MAX_TRAILING_PERCENT,
} = require('../../src/services/risk/atr-trailing');

// Constant-range candles (no gaps between candles, so true range == high - low every bar) give a
// predictable, quickly-converging ATR — makes the expected percent easy to reason about without
// pinning to technicalindicators' exact Wilder-smoothing internals.
function buildConstantRangeCandles(price, range, count = 20) {
  const candles = [];
  for (let i = 0; i < count; i += 1) {
    candles.push({ high: price + range / 2, low: price - range / 2, close: price, open: price, volume: 1 });
  }
  return candles;
}

function mockMarketData(t, { candles, price, market = 'spot' }) {
  t.mock.method(marketDataService, 'getCandles', async () => candles);
  const snapshot = { status: 'ok', price };
  if (market === 'futures') {
    t.mock.method(marketDataService, 'getFuturesSnapshot', async () => snapshot);
  } else {
    t.mock.method(marketDataService, 'getSnapshot', async () => snapshot);
  }
}

test('resolveAtrTrailingPercent computes ~2x ATR as a percent of price for a mid-range case', async (t) => {
  // price 1000, constant range 10 -> ATR converges to 10 -> raw percent = 10*2/1000*100 = 2%.
  mockMarketData(t, { candles: buildConstantRangeCandles(1000, 10), price: 1000 });
  const percent = await resolveAtrTrailingPercent({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.ok(percent > 1.9 && percent < 2.1, `expected ~2%, got ${percent}`);
});

test('resolveAtrTrailingPercent clamps down to MAX_TRAILING_PERCENT when volatility is extreme relative to price', async (t) => {
  // price 100, range 1000 -> raw percent would be 2000%, way past the sane cap.
  mockMarketData(t, { candles: buildConstantRangeCandles(100, 1000), price: 100 });
  const percent = await resolveAtrTrailingPercent({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.equal(percent, MAX_TRAILING_PERCENT);
});

test('resolveAtrTrailingPercent clamps up to MIN_TRAILING_PERCENT when volatility is negligible relative to price', async (t) => {
  // price 100000, range 0.001 -> raw percent would be a hair above zero.
  mockMarketData(t, { candles: buildConstantRangeCandles(100000, 0.001), price: 100000 });
  const percent = await resolveAtrTrailingPercent({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.equal(percent, MIN_TRAILING_PERCENT);
});

test('resolveAtrTrailingPercent returns null when there is not enough candle history for ATR yet', async (t) => {
  mockMarketData(t, { candles: buildConstantRangeCandles(1000, 10, 5), price: 1000 }); // fewer than period(14)+1
  const percent = await resolveAtrTrailingPercent({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.equal(percent, null);
});

test('resolveAtrTrailingPercent returns null when the live price snapshot is unavailable', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => buildConstantRangeCandles(1000, 10));
  t.mock.method(marketDataService, 'getSnapshot', async () => ({ status: 'unavailable' }));
  const percent = await resolveAtrTrailingPercent({ symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.equal(percent, null);
});

test('resolveAtrTrailingPercent routes through getFuturesSnapshot for market "futures"', async (t) => {
  mockMarketData(t, { candles: buildConstantRangeCandles(1000, 10), price: 1000, market: 'futures' });
  const percent = await resolveAtrTrailingPercent({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', market: 'futures', timeframe: '1h' });
  assert.ok(percent > 1.9 && percent < 2.1, `expected ~2%, got ${percent}`);
});

test('resolveTrailingPercent returns the stored fixed percent unchanged for a "fixed"-mode asset, without touching market data', async () => {
  const asset = { trailing_mode: 'fixed', trailing_percent: 3.5 };
  const percent = await resolveTrailingPercent(asset, { symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.equal(percent, 3.5);
});

test('resolveTrailingPercent returns the stored (possibly null) percent unchanged for a pre-migration asset with no trailing_mode', async () => {
  const asset = { trailing_percent: null };
  const percent = await resolveTrailingPercent(asset, { symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.equal(percent, null);
});

test('resolveTrailingPercent computes fresh from ATR for an "atr"-mode asset, ignoring its stored trailing_percent', async (t) => {
  mockMarketData(t, { candles: buildConstantRangeCandles(1000, 10), price: 1000 });
  const asset = { trailing_mode: 'atr', trailing_percent: null };
  const percent = await resolveTrailingPercent(asset, { symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.ok(percent > 1.9 && percent < 2.1, `expected ~2%, got ${percent}`);
});

test('resolveTrailingPercent falls back to null (never throws) if the market-data lookup fails for an "atr"-mode asset', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => { throw new Error('exchange unreachable'); });
  t.mock.method(marketDataService, 'getSnapshot', async () => ({ status: 'ok', price: 1000 }));
  const asset = { trailing_mode: 'atr', trailing_percent: null };
  const percent = await resolveTrailingPercent(asset, { symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h' });
  assert.equal(percent, null);
});
