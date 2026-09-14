'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMarketRegime } = require('../../src/services/technical-analysis/market-regime');

function makeCandles(count, start = 100, step = 1) {
  const candles = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    price += step;
    candles.push({
      open: price - 0.5,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 100,
    });
  }
  return candles;
}

test('marketRegime: handles insufficient data gracefully', () => {
  const result = classifyMarketRegime([], {});
  assert.equal(result.regime, 'INSUFFICIENT_DATA');
});

test('marketRegime: detects strong bullish trend when ADX is high and price is above EMAs', () => {
  const candles = makeCandles(25, 100, 2);
  const result = classifyMarketRegime(candles, {
    adx: { value: 35 },
    ema: { emaShort: 140, emaLong: 120 },
    bollingerBands: { upper: 160, lower: 130, middle: 145 },
  });
  assert.equal(result.regime, 'TRENDING_BULLISH');
  assert.equal(result.recommendedStrategy, 'trend-following');
});

test('marketRegime: detects strong bearish trend when ADX is high and price is below EMAs', () => {
  const candles = makeCandles(25, 200, -2);
  const result = classifyMarketRegime(candles, {
    adx: { value: 32 },
    ema: { emaShort: 160, emaLong: 180 },
    bollingerBands: { upper: 170, lower: 140, middle: 155 },
  });
  assert.equal(result.regime, 'TRENDING_BEARISH');
  assert.equal(result.recommendedStrategy, 'trend-following');
});

test('marketRegime: detects ranging / choppy market when ADX is below 20', () => {
  const candles = makeCandles(25, 100, 0.1);
  const result = classifyMarketRegime(candles, {
    adx: { value: 14 },
    ema: { emaShort: 102, emaLong: 101 },
    bollingerBands: { upper: 105, lower: 98, middle: 101.5 },
  });
  assert.equal(result.regime, 'RANGING_CHOPPY');
  assert.equal(result.recommendedStrategy, 'mean-reversion');
});

test('marketRegime: detects volatility squeeze when Bollinger Bands are exceptionally narrow', () => {
  const candles = makeCandles(25, 100, 0);
  const result = classifyMarketRegime(candles, {
    adx: { value: 18 },
    ema: { emaShort: 100, emaLong: 100 },
    bollingerBands: { upper: 100.8, lower: 99.2, middle: 100 }, // BBW = 1.6 / 100 = 0.016 (< 0.025)
  });
  assert.equal(result.regime, 'VOLATILITY_SQUEEZE');
  assert.equal(result.recommendedStrategy, 'momentum');
});
