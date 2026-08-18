'use strict';

// Causal fractal swing high/low detection — see docs/reversal-strategy/STRATEGY_SPEC.md §3.
//
// A bar at index i is a swing high once `swingLookback` bars have closed on EACH side of it and
// high[i] is strictly greater than every one of those neighbors; swing low is the mirror image
// on `low`. Critically, a swing at index i is only "confirmed" (visible to callers) once bar
// `i + swingLookback` has closed — this is the single mechanism that keeps every downstream
// detector (liquidity sweep, CHOCH) free of lookahead bias, since "as of bar i" always means
// "every swing whose confirmation bar is <= i".

/**
 * Returns every confirmed swing high/low in `candles[0..asOfIndex]`, each tagged with both its
 * own bar index and the index at which it became confirmed. Pure and re-computed from scratch on
 * every call by design (candles arrays in this codebase are already windowed per-bar — see
 * backtest-engine.js's identical `candles.slice(0, i + 1)` convention — so this stays consistent
 * with that pattern rather than introducing a separate incremental/stateful API).
 *
 * @param {Array<{high:number, low:number}>} candles oldest-first
 * @param {number} asOfIndex last index to consider (inclusive) — defaults to candles.length - 1
 * @param {number} swingLookback bars required on each side (a `2*swingLookback + 1`-bar fractal)
 * @returns {{highs: Array<{index:number, price:number, confirmedAtIndex:number}>,
 *            lows: Array<{index:number, price:number, confirmedAtIndex:number}>}}
 */
function detectSwings(candles, asOfIndex, swingLookback) {
  const lastIndex = asOfIndex ?? candles.length - 1;
  const highs = [];
  const lows = [];

  // A candidate at index i needs i - swingLookback >= 0 (enough left-side history) and its
  // confirmation bar i + swingLookback <= lastIndex (enough right-side history already closed
  // as of "now") — this second condition is the causality guarantee.
  for (let i = swingLookback; i + swingLookback <= lastIndex; i += 1) {
    const candidate = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= swingLookback && (isHigh || isLow); offset += 1) {
      const left = candles[i - offset];
      const right = candles[i + offset];
      if (candidate.high <= left.high || candidate.high <= right.high) isHigh = false;
      if (candidate.low >= left.low || candidate.low >= right.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candidate.high, confirmedAtIndex: i + swingLookback });
    if (isLow) lows.push({ index: i, price: candidate.low, confirmedAtIndex: i + swingLookback });
  }

  return { highs, lows };
}

/** Most recent confirmed swing low at or before `beforeIndex` (inclusive), or null. */
function mostRecentSwingLow(candles, beforeIndex, swingLookback) {
  const { lows } = detectSwings(candles, beforeIndex, swingLookback);
  return lows.length > 0 ? lows[lows.length - 1] : null;
}

/** Most recent confirmed swing high at or before `beforeIndex` (inclusive), or null. */
function mostRecentSwingHigh(candles, beforeIndex, swingLookback) {
  const { highs } = detectSwings(candles, beforeIndex, swingLookback);
  return highs.length > 0 ? highs[highs.length - 1] : null;
}

module.exports = { detectSwings, mostRecentSwingLow, mostRecentSwingHigh };
