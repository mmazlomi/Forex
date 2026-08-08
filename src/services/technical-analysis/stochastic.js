'use strict';

const { Stochastic } = require('technicalindicators');

function compute(candles, { period = 14, signalPeriod = 3 } = {}) {
  if (candles.length < period + signalPeriod) {
    return { value: null, status: 'insufficient_history', period, signalPeriod };
  }
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const values = Stochastic.calculate({ high, low, close, period, signalPeriod });
  const last = values[values.length - 1];
  if (!last) {
    return { value: null, status: 'insufficient_history', period, signalPeriod };
  }
  return { value: { k: last.k, d: last.d }, status: 'ok' };
}

module.exports = { compute };
