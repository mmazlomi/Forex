'use strict';

const { ATR } = require('technicalindicators');

/**
 * SuperTrend Indicator
 * Standard formulation:
 * Basic Upperband = (High + Low) / 2 + Multiplier * ATR
 * Basic Lowerband = (High + Low) / 2 - Multiplier * ATR
 *
 * Final bands adjust to prevent widening during prevailing trends.
 */
function compute(candles, { period = 10, multiplier = 3 } = {}) {
  if (!Array.isArray(candles) || candles.length < period + 1) {
    return { value: null, direction: null, status: 'insufficient_history', period, multiplier };
  }

  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);

  const atrValues = ATR.calculate({ period, high, low, close });
  const offset = candles.length - atrValues.length;

  let trend = 1; // 1 = bullish / uptrend, -1 = bearish / downtrend
  let prevUpper = 0;
  let prevLower = 0;
  let supertrendVal = 0;

  for (let i = 0; i < atrValues.length; i++) {
    const candleIdx = offset + i;
    const c = candles[candleIdx];
    const prevC = candles[candleIdx - 1];
    const atr = atrValues[i];

    const hl2 = (c.high + c.low) / 2;
    let basicUpper = hl2 + multiplier * atr;
    let basicLower = hl2 - multiplier * atr;

    let finalUpper = basicUpper;
    let finalLower = basicLower;

    if (i > 0 && prevC) {
      if (basicUpper < prevUpper || prevC.close > prevUpper) {
        finalUpper = basicUpper;
      } else {
        finalUpper = prevUpper;
      }

      if (basicLower > prevLower || prevC.close < prevLower) {
        finalLower = basicLower;
      } else {
        finalLower = prevLower;
      }
    }

    if (trend === 1) {
      if (c.close < finalLower) {
        trend = -1;
        supertrendVal = finalUpper;
      } else {
        supertrendVal = finalLower;
      }
    } else {
      if (c.close > finalUpper) {
        trend = 1;
        supertrendVal = finalLower;
      } else {
        supertrendVal = finalUpper;
      }
    }

    prevUpper = finalUpper;
    prevLower = finalLower;
  }

  return {
    value: Number(supertrendVal.toFixed(6)),
    direction: trend === 1 ? 'up' : 'down',
    trend,
    period,
    multiplier,
    status: 'ok',
  };
}

module.exports = { compute };
