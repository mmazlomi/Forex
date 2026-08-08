'use strict';

const { IchimokuCloud } = require('technicalindicators');

// Standard Ichimoku Kinko Hyo periods. The library computes conversion/base/spanA/spanB at
// every bar, but on a real Ichimoku chart spanA/spanB are plotted `displacement` bars AHEAD of
// where they're calculated — so "the cloud actually overhead right now" is the spanA/spanB pair
// computed `displacement` bars ago, not the most recently computed pair. Reading the latest
// pair directly (the naive approach) silently misreads where price sits relative to the cloud.
function compute(candles, { conversionPeriod = 9, basePeriod = 26, spanPeriod = 52, displacement = 26 } = {}) {
  const warmupPeriod = Math.max(conversionPeriod, basePeriod, spanPeriod, displacement);
  if (candles.length < warmupPeriod + displacement) {
    return { value: null, status: 'insufficient_history', conversionPeriod, basePeriod, spanPeriod, displacement };
  }

  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const values = IchimokuCloud.calculate({ high, low, conversionPeriod, basePeriod, spanPeriod, displacement });
  if (values.length <= displacement) {
    return { value: null, status: 'insufficient_history', conversionPeriod, basePeriod, spanPeriod, displacement };
  }

  const latest = values[values.length - 1];
  const currentCloud = values[values.length - 1 - displacement]; // see displacement note above
  return {
    value: {
      conversion: latest.conversion,
      base: latest.base,
      spanA: currentCloud.spanA,
      spanB: currentCloud.spanB,
      cloudTop: Math.max(currentCloud.spanA, currentCloud.spanB),
      cloudBottom: Math.min(currentCloud.spanA, currentCloud.spanB),
    },
    status: 'ok',
  };
}

module.exports = { compute };
