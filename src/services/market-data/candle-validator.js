'use strict';

const TIMEFRAME_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

function timeframeToMs(timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  if (!ms) throw new Error(`Unsupported timeframe: "${timeframe}"`);
  return ms;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Validates normalized OHLCV candles: finite values, correct high/low bounds, strictly
 * increasing timestamps, and gap detection. Invalid candles are dropped, not silently used.
 * Returns { valid, errors } — errors describe what was rejected and why.
 */
function validateCandles(candles, timeframe) {
  const errors = [];
  const valid = [];
  const gapThresholdMs = timeframeToMs(timeframe) * 1.5;
  let previousTs = null;

  for (const candle of candles) {
    const { tsUtc, open, high, low, close, volume } = candle;

    if (![tsUtc, open, high, low, close, volume].every(isFiniteNumber)) {
      errors.push({ tsUtc, reason: 'non_finite_value' });
      continue;
    }
    if (high < Math.max(open, close)) {
      errors.push({ tsUtc, reason: 'high_below_open_close' });
      continue;
    }
    if (low > Math.min(open, close)) {
      errors.push({ tsUtc, reason: 'low_above_open_close' });
      continue;
    }
    if (volume < 0) {
      errors.push({ tsUtc, reason: 'negative_volume' });
      continue;
    }
    if (previousTs !== null) {
      if (tsUtc <= previousTs) {
        errors.push({ tsUtc, reason: 'non_monotonic_timestamp' });
        continue;
      }
      if (tsUtc - previousTs > gapThresholdMs) {
        errors.push({ tsUtc, reason: 'data_gap', gapMs: tsUtc - previousTs });
        // Gap is a warning, not a rejection — the candle itself may still be valid.
      }
    }

    valid.push(candle);
    previousTs = tsUtc;
  }

  return { valid, errors };
}

module.exports = { validateCandles, timeframeToMs, TIMEFRAME_MS };
