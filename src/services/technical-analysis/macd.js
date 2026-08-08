'use strict';

const { MACD } = require('technicalindicators');

function compute(candles, { fastPeriod = 12, slowPeriod = 26, signalPeriod = 9 } = {}) {
  const minRequired = slowPeriod + signalPeriod;
  if (candles.length < minRequired) {
    return { value: null, status: 'insufficient_history', minRequired };
  }
  const closes = candles.map((c) => c.close);
  const values = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const last = values[values.length - 1];
  if (!last || last.MACD === undefined) {
    return { value: null, status: 'insufficient_history', minRequired };
  }
  return {
    value: { macd: last.MACD, signal: last.signal, histogram: last.histogram },
    status: 'ok',
  };
}

module.exports = { compute };
