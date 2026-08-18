'use strict';

// Bullish/bearish liquidity sweep detection — see docs/reversal-strategy/STRATEGY_SPEC.md §4.
//
// Both directions require: (1) the current bar's own low/high trades meaningfully beyond a
// recent CONFIRMED swing low/high, and (2) the SAME bar closes back on the other side of that
// level (a same-bar reclaim — see the STRATEGY_SPEC.md §4 note on this simplification). Only
// candles[0..i] and the confirmed-swings list are ever read, so this is lookahead-free by
// construction (the swing detector already enforces confirmation lag).

const { mostRecentSwingLow, mostRecentSwingHigh } = require('./swing-detector');

/**
 * @param {Array} candles oldest-first, windowed to "as of now" by the caller
 * @param {number} i index of the bar being evaluated (the potential sweep bar)
 * @param {object} config merged strategy config (swingLookback, sweepLookbackBars, sweepMinPenetrationPercent)
 * @returns {null | {direction: 'bullish'|'bearish', sweepIndex:number, sweptSwingIndex:number,
 *                    sweptLevel:number, sweepLow:number, sweepHigh:number, sweepClose:number}}
 */
function detectSweep(candles, i, config) {
  const bar = candles[i];
  if (!bar) return null;

  const bullish = detectBullishSweep(candles, i, config, bar);
  if (bullish) return bullish;
  return detectBearishSweep(candles, i, config, bar);
}

function detectBullishSweep(candles, i, config, bar) {
  const swingLow = mostRecentSwingLow(candles, i - 1, config.swingLookback);
  if (!swingLow) return null;
  if (i - swingLow.index > config.sweepLookbackBars) return null;

  const penetrationThreshold = swingLow.price * (1 - config.sweepMinPenetrationPercent / 100);
  const penetrated = bar.low < penetrationThreshold;
  const reclaimed = bar.close > swingLow.price;
  if (!penetrated || !reclaimed) return null;

  return {
    direction: 'bullish',
    sweepIndex: i,
    sweptSwingIndex: swingLow.index,
    sweptLevel: swingLow.price,
    sweepLow: bar.low,
    sweepHigh: bar.high,
    sweepClose: bar.close,
  };
}

function detectBearishSweep(candles, i, config, bar) {
  const swingHigh = mostRecentSwingHigh(candles, i - 1, config.swingLookback);
  if (!swingHigh) return null;
  if (i - swingHigh.index > config.sweepLookbackBars) return null;

  const penetrationThreshold = swingHigh.price * (1 + config.sweepMinPenetrationPercent / 100);
  const penetrated = bar.high > penetrationThreshold;
  const reclaimed = bar.close < swingHigh.price;
  if (!penetrated || !reclaimed) return null;

  return {
    direction: 'bearish',
    sweepIndex: i,
    sweptSwingIndex: swingHigh.index,
    sweptLevel: swingHigh.price,
    sweepLow: bar.low,
    sweepHigh: bar.high,
    sweepClose: bar.close,
  };
}

module.exports = { detectSweep };
