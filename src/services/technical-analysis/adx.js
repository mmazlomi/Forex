'use strict';

const { ADX } = require('technicalindicators');

function compute(candles, { period = 14 } = {}) {
  if (candles.length < period * 2) {
    return { value: null, status: 'insufficient_history', period };
  }
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const values = ADX.calculate({ period, high, low, close });
  const last = values[values.length - 1];
  if (!last) {
    return { value: null, status: 'insufficient_history', period };
  }
  return { value: { adx: last.adx, pdi: last.pdi, mdi: last.mdi }, status: 'ok' };
}

module.exports = { compute };
