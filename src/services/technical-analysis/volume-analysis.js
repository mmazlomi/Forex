'use strict';

const { SMA } = require('technicalindicators');

// Not covered by the `technicalindicators` package — volume SMA + relative volume,
// documented here as the definition used throughout the app: relativeVolume =
// currentVolume / volumeSMA(period). > 1 means above-average participation.

function compute(candles, { period = 20 } = {}) {
  if (candles.length < period) {
    return { value: null, status: 'insufficient_history', period };
  }
  const volumes = candles.map((c) => c.volume);
  const volumeSmaValues = SMA.calculate({ period, values: volumes });
  const volumeSma = volumeSmaValues[volumeSmaValues.length - 1];
  const currentVolume = volumes[volumes.length - 1];
  const relativeVolume = volumeSma > 0 ? currentVolume / volumeSma : null;

  return {
    value: { currentVolume, volumeSma, relativeVolume },
    status: 'ok',
    period,
  };
}

module.exports = { compute };
