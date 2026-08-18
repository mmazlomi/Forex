'use strict';

// Retest & entry-confirmation logic — see docs/reversal-strategy/STRATEGY_SPEC.md §7. Runs on the
// entry timeframe once a CHOCH level exists. Pure functions only; the state machine owns the
// waiting/expiry bookkeeping (this module just answers "does this one bar count as X").

/** The price band around the broken structure level that counts as "the retest". */
function retestZone(level, tolerancePercent) {
  const tolerance = level * (tolerancePercent / 100);
  return { lower: level - tolerance, upper: level + tolerance };
}

/** Whether bar `i`'s trading range (high/low) overlaps the retest zone at all — a simple range
 *  intersection, direction-agnostic (a retest is a retest whichever direction price approaches
 *  the zone from). */
function isRetestTouch(candles, i, level, tolerancePercent) {
  const bar = candles[i];
  const { lower, upper } = retestZone(level, tolerancePercent);
  return bar.low <= upper && bar.high >= lower;
}

/**
 * Whether bar `i` is a valid rejection/confirmation candle: closes in the trade direction (a
 * same-direction candle, i.e. close on the correct side of its own open — not just any close)
 * AND closes clear of the retest zone on the correct side (a genuine bounce away from the level,
 * not a marginal re-cross).
 */
function isConfirmationCandle(candles, i, level, direction, tolerancePercent) {
  const bar = candles[i];
  const { lower, upper } = retestZone(level, tolerancePercent);
  if (direction === 'bullish') {
    return bar.close > bar.open && bar.close > upper;
  }
  return bar.close < bar.open && bar.close < lower;
}

module.exports = { retestZone, isRetestTouch, isConfirmationCandle };
