'use strict';

const { EMA } = require('technicalindicators');

function compute(candles, { period = 20 } = {}) {
  if (candles.length < period) {
    return { value: null, status: 'insufficient_history', period };
  }
  const closes = candles.map((c) => c.close);
  const values = EMA.calculate({ period, values: closes });
  return { value: values[values.length - 1], status: 'ok', period };
}

module.exports = { compute };
