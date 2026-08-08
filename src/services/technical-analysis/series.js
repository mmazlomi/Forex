'use strict';

const { SMA, EMA, RSI, BollingerBands } = require('technicalindicators');

/**
 * Time-aligns an indicator's output array (which is always shorter than the input candle
 * array, by the indicator's warm-up period) back to the corresponding candle timestamps.
 * `technicalindicators` doesn't return timestamps itself — its Nth output value always
 * corresponds to the Nth-from-the-end input candle, so slicing candles down to the same
 * length and zipping them in order is correct regardless of the exact per-indicator offset.
 */
function alignToCandles(candles, values, extractValue = (v) => v) {
  const offset = candles.length - values.length;
  if (offset < 0) return [];
  return values.map((v, i) => ({
    time: Math.floor(candles[offset + i].tsUtc / 1000),
    value: extractValue(v),
  }));
}

/**
 * Full historical series (not just the latest value) for the indicators worth charting as
 * overlays: SMA, EMA, Bollinger Bands, and RSI. Used by the chart's indicator toggles —
 * separate from computeAllIndicators(), which only needs the latest value for the TA panel.
 */
function computeIndicatorSeries(candles, params = {}) {
  const closes = candles.map((c) => c.close);

  const smaPeriod = params.sma?.period ?? 20;
  const emaPeriod = params.ema?.period ?? 20;
  const rsiPeriod = params.rsi?.period ?? 14;
  const bbPeriod = params.bollingerBands?.period ?? 20;
  const bbStdDev = params.bollingerBands?.stdDev ?? 2;

  const smaValues = closes.length >= smaPeriod ? SMA.calculate({ period: smaPeriod, values: closes }) : [];
  const emaValues = closes.length >= emaPeriod ? EMA.calculate({ period: emaPeriod, values: closes }) : [];
  const rsiValues = closes.length >= rsiPeriod + 1 ? RSI.calculate({ period: rsiPeriod, values: closes }) : [];
  const bbValues = closes.length >= bbPeriod ? BollingerBands.calculate({ period: bbPeriod, values: closes, stdDev: bbStdDev }) : [];

  return {
    sma: alignToCandles(candles, smaValues),
    ema: alignToCandles(candles, emaValues),
    rsi: alignToCandles(candles, rsiValues),
    bollingerUpper: alignToCandles(candles, bbValues, (v) => v.upper),
    bollingerMiddle: alignToCandles(candles, bbValues, (v) => v.middle),
    bollingerLower: alignToCandles(candles, bbValues, (v) => v.lower),
  };
}

module.exports = { computeIndicatorSeries };
