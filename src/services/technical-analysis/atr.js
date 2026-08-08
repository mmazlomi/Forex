'use strict';

const { ATR } = require('technicalindicators');

function compute(candles, { period = 14 } = {}) {
  if (candles.length < period + 1) {
    return { value: null, status: 'insufficient_history', period };
  }
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const values = ATR.calculate({ period, high, low, close });
  return { value: values[values.length - 1], status: 'ok', period };
}

module.exports = { compute };
