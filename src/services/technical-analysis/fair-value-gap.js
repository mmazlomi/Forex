'use strict';

/**
 * Fair Value Gap (FVG) / Price Imbalance Detector
 * Inspired by ICT (Inner Circle Trader) concepts.
 *
 * A 3-candle pattern:
 * - Bullish FVG: Candle 1 High < Candle 3 Low (Gap between high of candle 1 and low of candle 3).
 * - Bearish FVG: Candle 1 Low > Candle 3 High (Gap between low of candle 1 and high of candle 3).
 *
 * Tracks if unmitigated (untouched) FVGs exist near current market price.
 */
function compute(candles, { minGapPercent = 0.1, lookback = 50 } = {}) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return { status: 'insufficient_history', gaps: [], nearestBullishFvg: null, nearestBearishFvg: null };
  }

  const startIdx = Math.max(2, candles.length - lookback);
  const gaps = [];

  for (let i = startIdx; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    // Bullish FVG
    if (c3.low > c1.high) {
      const gapSize = c3.low - c1.high;
      const gapPercent = (gapSize / c1.high) * 100;
      if (gapPercent >= minGapPercent) {
        // Check if subsequently mitigated by candles between i and end
        let mitigated = false;
        let mitigatedAt = null;
        for (let k = i + 1; k < candles.length; k++) {
          if (candles[k].low <= c1.high) {
            mitigated = true;
            mitigatedAt = candles[k].tsUtc;
            break;
          }
        }
        gaps.push({
          type: 'bullish',
          top: c3.low,
          bottom: c1.high,
          midpoint: (c3.low + c1.high) / 2,
          gapPercent: Number(gapPercent.toFixed(3)),
          candleIndex: i - 1,
          tsUtc: c2.tsUtc,
          mitigated,
          mitigatedAt,
        });
      }
    }

    // Bearish FVG
    if (c1.low > c3.high) {
      const gapSize = c1.low - c3.high;
      const gapPercent = (gapSize / c3.high) * 100;
      if (gapPercent >= minGapPercent) {
        let mitigated = false;
        let mitigatedAt = null;
        for (let k = i + 1; k < candles.length; k++) {
          if (candles[k].high >= c1.low) {
            mitigated = true;
            mitigatedAt = candles[k].tsUtc;
            break;
          }
        }
        gaps.push({
          type: 'bearish',
          top: c1.low,
          bottom: c3.high,
          midpoint: (c1.low + c3.high) / 2,
          gapPercent: Number(gapPercent.toFixed(3)),
          candleIndex: i - 1,
          tsUtc: c2.tsUtc,
          mitigated,
          mitigatedAt,
        });
      }
    }
  }

  const currentPrice = candles[candles.length - 1].close;
  const unmitigated = gaps.filter((g) => !g.mitigated);

  // Find nearest active FVGs to current price
  const unmitigatedBullish = unmitigated
    .filter((g) => g.type === 'bullish' && g.top <= currentPrice * 1.02)
    .sort((a, b) => b.top - a.top);

  const unmitigatedBearish = unmitigated
    .filter((g) => g.type === 'bearish' && g.bottom >= currentPrice * 0.98)
    .sort((a, b) => a.bottom - b.bottom);

  const nearestBullishFvg = unmitigatedBullish[0] || null;
  const nearestBearishFvg = unmitigatedBearish[0] || null;

  return {
    status: 'ok',
    totalGapsFound: gaps.length,
    unmitigatedCount: unmitigated.length,
    nearestBullishFvg,
    nearestBearishFvg,
    allUnmitigated: unmitigated.slice(-5),
  };
}

module.exports = { compute };
