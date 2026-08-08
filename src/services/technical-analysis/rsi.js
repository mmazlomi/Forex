'use strict';

const { RSI } = require('technicalindicators');

function compute(candles, { period = 14 } = {}) {
  if (candles.length < period + 1) {
    return { value: null, status: 'insufficient_history', period };
  }
  const closes = candles.map((c) => c.close);
  const values = RSI.calculate({ period, values: closes });
  return { value: values[values.length - 1], status: 'ok', period };
}

module.exports = { compute };
