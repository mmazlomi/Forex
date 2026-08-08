'use strict';

// Not covered by the `technicalindicators` package — implemented here as a documented,
// simple pivot-based swing-high/low detector (lookback candles on each side).

function findSwingPoints(candles, lookback) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const current = candles[i];

    if (window.every((c) => c.high <= current.high)) {
      swingHighs.push({ tsUtc: current.tsUtc, price: current.high });
    }
    if (window.every((c) => c.low >= current.low)) {
      swingLows.push({ tsUtc: current.tsUtc, price: current.low });
    }
  }

  return { swingHighs, swingLows };
}

function compute(candles, { lookback = 3 } = {}) {
  const minRequired = lookback * 2 + 1;
  if (candles.length < minRequired) {
    return { value: null, status: 'insufficient_history', minRequired };
  }

  const currentPrice = candles[candles.length - 1].close;
  const { swingHighs, swingLows } = findSwingPoints(candles, lookback);

  const resistanceCandidates = swingHighs.filter((p) => p.price > currentPrice).sort((a, b) => a.price - b.price);
  const supportCandidates = swingLows.filter((p) => p.price < currentPrice).sort((a, b) => b.price - a.price);

  return {
    value: {
      nearestResistance: resistanceCandidates[0]?.price ?? null,
      nearestSupport: supportCandidates[0]?.price ?? null,
      resistanceLevels: resistanceCandidates.slice(0, 3).map((p) => p.price),
      supportLevels: supportCandidates.slice(0, 3).map((p) => p.price),
    },
    status: 'ok',
  };
}

module.exports = { compute };
