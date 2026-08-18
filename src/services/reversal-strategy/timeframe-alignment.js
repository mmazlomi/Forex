'use strict';

// Multi-timeframe no-lookahead alignment — see docs/reversal-strategy/ARCHITECTURE.md §4.2.
// `tsUtc` on every candle in this codebase is the bar's OPEN time (standard ccxt/OHLCV
// convention — confirmed against historical-data.js/candle-validator.js). A candle "closes" at
// `tsUtc + timeframeMs`.

/**
 * Finds the index of the last candle in `higherTimeframeCandles` (assumed oldest-first, sorted)
 * that has FULLY CLOSED by `atTsUtc` — i.e. `candle.tsUtc + timeframeMs <= atTsUtc`. Returns -1
 * if none has closed yet (too early in the data). A linear scan is fine here: this runs once per
 * lower-timeframe bar against a much shorter higher-timeframe array, and the caller always calls
 * it with non-decreasing `atTsUtc` — see `LookaheadSafeCursor` below for the O(1)-amortized
 * version used by the actual backtest loop.
 */
function latestClosedCandleIndexAsOf(higherTimeframeCandles, timeframeMs, atTsUtc) {
  let result = -1;
  for (let i = 0; i < higherTimeframeCandles.length; i += 1) {
    if (higherTimeframeCandles[i].tsUtc + timeframeMs <= atTsUtc) {
      result = i;
    } else {
      break; // sorted ascending — no later candle can close earlier
    }
  }
  return result;
}

/**
 * Stateful cursor that advances forward-only through a higher-timeframe candle array as the
 * caller feeds it non-decreasing timestamps — turns what would be an O(n) rescan per lower-
 * timeframe bar into O(1) amortized, which matters once a backtest is iterating thousands of
 * entry-timeframe bars against a much shorter HTF array. Never moves backward, so a caller
 * feeding a non-monotonic sequence of timestamps would get stale results — that's guarded by the
 * assertion below rather than silently returning wrong data.
 */
function createLookaheadSafeCursor(higherTimeframeCandles, timeframeMs) {
  let index = -1;
  let lastTsUtc = -Infinity;
  return {
    /** @returns {{index:number, candle:object} | null} the latest fully-closed higher-timeframe
     *  candle as of `atTsUtc`, and its index in `higherTimeframeCandles` (callers such as
     *  htf-trend-filter.js need the index, not just the candle, to build their own `candles.slice`
     *  windows) — null if none has closed yet. */
    advanceTo(atTsUtc) {
      if (atTsUtc < lastTsUtc) {
        throw new Error('createLookaheadSafeCursor.advanceTo() called with a timestamp earlier than a previous call — this cursor is forward-only.');
      }
      lastTsUtc = atTsUtc;
      while (index + 1 < higherTimeframeCandles.length && higherTimeframeCandles[index + 1].tsUtc + timeframeMs <= atTsUtc) {
        index += 1;
      }
      return index === -1 ? null : { index, candle: higherTimeframeCandles[index] };
    },
  };
}

module.exports = { latestClosedCandleIndexAsOf, createLookaheadSafeCursor };
