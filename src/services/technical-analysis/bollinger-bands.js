'use strict';

const { BollingerBands } = require('technicalindicators');

function compute(candles, { period = 20, stdDev = 2 } = {}) {
  if (candles.length < period) {
    return { value: null, status: 'insufficient_history', period };
  }
  const closes = candles.map((c) => c.close);
  const values = BollingerBands.calculate({ period, values: closes, stdDev });
  const last = values[values.length - 1];
  return {
    value: { upper: last.upper, middle: last.middle, lower: last.lower, pb: last.pb },
    status: 'ok',
  };
}

module.exports = { compute };
