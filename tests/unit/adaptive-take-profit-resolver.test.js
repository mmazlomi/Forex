'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const marketDataService = require('../../src/services/market-data/market-data-service');
const { resolveAdaptiveTp } = require('../../src/services/risk/adaptive-take-profit-resolver');

function makeCandles(count, { start = 100, step = 0.5 } = {}) {
  const now = Date.now();
  const candles = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    price += step;
    candles.push({ tsUtc: now - (count - i) * 3600_000, open: price - 0.2, high: price + 1, low: price - 1, close: price, volume: 10 + i });
  }
  return candles;
}

test('resolveAdaptiveTp returns undefined when the asset is not opted in — never fetches candles', async (t) => {
  const getCandles = t.mock.method(marketDataService, 'getCandles', async () => makeCandles(200));
  const result = await resolveAdaptiveTp({ asset: { adaptive_tp_enabled: 0 }, symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', side: 'buy', entryPrice: 100, stopLoss: 90 });
  assert.equal(result, undefined);
  assert.equal(getCandles.mock.calls.length, 0);
});

test('resolveAdaptiveTp returns undefined for a null/undefined asset (defensive)', async () => {
  const result = await resolveAdaptiveTp({ asset: null, symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', side: 'buy', entryPrice: 100, stopLoss: 90 });
  assert.equal(result, undefined);
});

test('resolveAdaptiveTp returns a full adaptiveTp payload for an opted-in asset with usable candle data (long)', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => makeCandles(200, { start: 100, step: 0.3 }));
  const result = await resolveAdaptiveTp({
    asset: { adaptive_tp_enabled: 1 }, symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', timeframe: '1h', side: 'buy', entryPrice: 160, stopLoss: 150,
  });

  assert.ok(result);
  assert.ok(typeof result.tp1Price === 'number' && result.tp1Price > 160, 'TP1 above entry for a long');
  assert.ok(result.tp2Price > result.tp1Price);
  assert.ok(result.tp3Price > result.tp2Price);
  assert.equal(result.tp1QtyPercent + result.tp2QtyPercent + result.tp3QtyPercent, 100);
  assert.equal(result.rMultiple, 10); // |160-150|
  assert.ok(typeof result.entryAtr === 'number' && result.entryAtr > 0);
  assert.ok(typeof result.recommendedTrailingMultiplier === 'number');
  assert.ok(Array.isArray(JSON.parse(result.exitReversalConditionsJson)));
  assert.equal(result.fallbackTakeProfit, result.tp3Price);
  const context = JSON.parse(result.entryContextJson);
  assert.ok('adx' in context && 'supportResistance' in context && 'volumeAnalysis' in context);
});

test('resolveAdaptiveTp mirrors direction correctly for a short position', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => makeCandles(200, { start: 200, step: -0.3 }));
  const result = await resolveAdaptiveTp({
    asset: { adaptive_tp_enabled: 1 }, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', market: 'futures', side: 'short', entryPrice: 140, stopLoss: 150,
  });
  assert.ok(result);
  assert.ok(result.tp1Price < 140, 'TP1 below entry for a short');
  assert.ok(result.tp2Price < result.tp1Price);
  assert.ok(result.tp3Price < result.tp2Price);
});

test('resolveAdaptiveTp respects a per-asset adaptive_tp_config_json override', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => makeCandles(200, { start: 100, step: 0.3 }));
  const result = await resolveAdaptiveTp({
    asset: { adaptive_tp_enabled: 1, adaptive_tp_config_json: JSON.stringify({ tp1ClosePercent: 50, tp2ClosePercent: 30, tp3RemainingPercent: 20 }) },
    symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', side: 'buy', entryPrice: 160, stopLoss: 150,
  });
  assert.ok(result);
  assert.equal(result.tp1QtyPercent, 50);
  assert.equal(result.tp2QtyPercent, 30);
  assert.equal(result.tp3QtyPercent, 20);
});

test('resolveAdaptiveTp falls back to undefined (never throws) on an invalid config override', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => makeCandles(200));
  const result = await resolveAdaptiveTp({
    asset: { adaptive_tp_enabled: 1, adaptive_tp_config_json: JSON.stringify({ tp1ClosePercent: 10, tp2ClosePercent: 10, tp3RemainingPercent: 10 }) }, // sums to 30, invalid
    symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', side: 'buy', entryPrice: 160, stopLoss: 150,
  });
  assert.equal(result, undefined);
});

test('resolveAdaptiveTp returns undefined (fail-open) when the candle fetch throws', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => { throw new Error('network down'); });
  const result = await resolveAdaptiveTp({
    asset: { adaptive_tp_enabled: 1 }, symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', side: 'buy', entryPrice: 160, stopLoss: 150,
  });
  assert.equal(result, undefined);
});

test('resolveAdaptiveTp returns undefined when the engine cannot compute usable targets (no ATR, no stopLoss)', async (t) => {
  // Very short candle history — ATR needs 15 candles (period 14 + 1); with none, and no stopLoss
  // given here either, the engine has nothing to size targets from.
  t.mock.method(marketDataService, 'getCandles', async () => makeCandles(3));
  const result = await resolveAdaptiveTp({
    asset: { adaptive_tp_enabled: 1 }, symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', side: 'buy', entryPrice: 160, stopLoss: null,
  });
  assert.equal(result, undefined);
});

test('resolveAdaptiveTp returns undefined when getCandles resolves an empty array', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => []);
  const result = await resolveAdaptiveTp({
    asset: { adaptive_tp_enabled: 1 }, symbol: 'BTC/USDT', exchange: 'kucoin', market: 'spot', side: 'buy', entryPrice: 160, stopLoss: 150,
  });
  assert.equal(result, undefined);
});
