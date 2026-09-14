'use strict';

/**
 * Volume Profile & VPOC (Volume Point of Control) Calculator
 *
 * Distributes trading volume into discrete price bins across a lookback window.
 * Computes:
 * - VPOC: The price level with the highest traded volume.
 * - Value Area High (VAH) & Value Area Low (VAL): The price range containing 70% of total volume.
 */
function compute(candles, { lookback = 100, binsCount = 24, valueAreaPercent = 0.70 } = {}) {
  if (!Array.isArray(candles) || candles.length < 10) {
    return {
      status: 'insufficient_history',
      vpoc: null,
      vah: null,
      val: null,
      bins: [],
    };
  }

  const window = candles.slice(-lookback);
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let totalVolume = 0;

  for (const c of window) {
    if (c.low < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
    totalVolume += (c.volume || 0);
  }

  if (minPrice >= maxPrice || totalVolume <= 0) {
    const lastClose = candles[candles.length - 1].close;
    return {
      status: 'ok',
      vpoc: lastClose,
      vah: lastClose * 1.01,
      val: lastClose * 0.99,
      bins: [],
    };
  }

  const binStep = (maxPrice - minPrice) / binsCount;
  const bins = Array.from({ length: binsCount }, (_, idx) => ({
    binIndex: idx,
    low: minPrice + idx * binStep,
    high: minPrice + (idx + 1) * binStep,
    mid: minPrice + (idx + 0.5) * binStep,
    volume: 0,
  }));

  // Distribute candle volume across bins it spans
  for (const c of window) {
    const vol = c.volume || 0;
    if (vol <= 0) continue;
    const candleSpan = Math.max(0.000001, c.high - c.low);

    for (const bin of bins) {
      const overlapLow = Math.max(bin.low, c.low);
      const overlapHigh = Math.min(bin.high, c.high);
      if (overlapHigh > overlapLow) {
        const fraction = (overlapHigh - overlapLow) / candleSpan;
        bin.volume += vol * fraction;
      }
    }
  }

  // Identify VPOC (highest volume bin)
  let maxBin = bins[0];
  for (const bin of bins) {
    if (bin.volume > maxBin.volume) {
      maxBin = bin;
    }
  }
  const vpoc = Number(maxBin.mid.toFixed(4));

  // Determine Value Area (70% of total volume expanding outward from VPOC)
  const targetAreaVolume = totalVolume * valueAreaPercent;
  let currentAreaVolume = maxBin.volume;
  let leftIdx = maxBin.binIndex;
  let rightIdx = maxBin.binIndex;

  while (currentAreaVolume < targetAreaVolume && (leftIdx > 0 || rightIdx < binsCount - 1)) {
    const leftVol = leftIdx > 0 ? bins[leftIdx - 1].volume : -1;
    const rightVol = rightIdx < binsCount - 1 ? bins[rightIdx + 1].volume : -1;

    if (leftVol >= rightVol && leftIdx > 0) {
      leftIdx--;
      currentAreaVolume += leftVol;
    } else if (rightIdx < binsCount - 1) {
      rightIdx++;
      currentAreaVolume += rightVol;
    } else if (leftIdx > 0) {
      leftIdx--;
      currentAreaVolume += leftVol;
    } else {
      break;
    }
  }

  const val = Number(bins[leftIdx].low.toFixed(4));
  const vah = Number(bins[rightIdx].high.toFixed(4));
  const currentPrice = candles[candles.length - 1].close;

  return {
    status: 'ok',
    vpoc,
    vah,
    val,
    isAboveVpoc: currentPrice > vpoc,
    isInsideValueArea: currentPrice >= val && currentPrice <= vah,
    bins: bins.map((b) => ({
      mid: Number(b.mid.toFixed(4)),
      volume: Number(b.volume.toFixed(2)),
    })),
  };
}

module.exports = { compute };
