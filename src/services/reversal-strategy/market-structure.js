'use strict';

// CHOCH (Change of Character) detection — see docs/reversal-strategy/STRATEGY_SPEC.md §6.
//
// For a bullish setup (targeting LONG), the level to break is the most recent CONFIRMED swing
// high at or before the sweep bar (the "lower high" of the preceding downtrend). For a bearish
// setup, it's the most recent confirmed swing low. Both queries only ever look at
// candles[0..sweepIndex] via swing-detector's existing confirmation-lag guarantee.

const { mostRecentSwingHigh, mostRecentSwingLow } = require('./swing-detector');

/**
 * Resolves the CHOCH target level once, right after divergence is confirmed at `sweepIndex`.
 * @returns {null | {index:number, price:number}} null if no qualifying prior swing exists
 *          (e.g. too close to the start of the data) — the setup is invalidated in that case.
 */
function findChochLevel(candles, sweepIndex, direction, swingLookback) {
  return direction === 'bullish'
    ? mostRecentSwingHigh(candles, sweepIndex, swingLookback)
    : mostRecentSwingLow(candles, sweepIndex, swingLookback);
}

/**
 * Checks whether bar `i` breaks the CHOCH level. `basis: 'close'` (default, conservative) requires
 * the bar's close beyond the level; `'wick'` accepts a high/low touch (faster, noisier).
 */
function isChochBreak(candles, i, level, direction, basis) {
  const bar = candles[i];
  if (direction === 'bullish') {
    const price = basis === 'wick' ? bar.high : bar.close;
    return price > level.price;
  }
  const price = basis === 'wick' ? bar.low : bar.close;
  return price < level.price;
}

module.exports = { findChochLevel, isChochBreak };
