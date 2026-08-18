'use strict';

// RSI divergence, evaluated at the liquidity-sweep bar — see docs/reversal-strategy/STRATEGY_SPEC.md
// §5 for the design decision behind this (the sweep bar's own extreme IS the "lower low"/"higher
// high" side of the comparison; the swept swing's bar is the other side).

const { RSI } = require('technicalindicators');

/** RSI value exactly at `index`, computed from candles[0..index] only (causal — never uses a
 *  close after `index`). Returns null if there isn't enough history yet. Recomputes per call
 *  rather than caching a full series, mirroring technical-analysis/rsi.js's own "windowed
 *  recompute" convention (this is only ever called twice per sweep event, not once per bar). */
function rsiValueAtIndex(candles, index, period) {
  if (index < period || index >= candles.length) return null;
  const closes = candles.slice(0, index + 1).map((c) => c.close);
  const values = RSI.calculate({ period, values: closes });
  if (values.length === 0) return null;
  return values[values.length - 1];
}

/**
 * @param {Array} candles oldest-first, windowed to "as of now" by the caller
 * @param {object} sweep result of liquidity-sweep-detector.detectSweep (non-null)
 * @param {object} config merged strategy config (rsiPeriod, maxDivergenceDistanceBars)
 * @returns {null | {confirmed:true, direction:'bullish'|'bearish', rsiAtSweep:number, rsiAtSwing:number}}
 */
function detectDivergence(candles, sweep, config) {
  if (!sweep) return null;
  if (sweep.sweepIndex - sweep.sweptSwingIndex > config.maxDivergenceDistanceBars) return null;

  const rsiAtSweep = rsiValueAtIndex(candles, sweep.sweepIndex, config.rsiPeriod);
  const rsiAtSwing = rsiValueAtIndex(candles, sweep.sweptSwingIndex, config.rsiPeriod);
  if (rsiAtSweep === null || rsiAtSwing === null) return null;

  // Bullish: price made a lower low (guaranteed by the sweep itself); divergence requires RSI to
  // make a HIGHER low instead of confirming the new price extreme.
  if (sweep.direction === 'bullish' && rsiAtSweep > rsiAtSwing) {
    return { confirmed: true, direction: 'bullish', rsiAtSweep, rsiAtSwing };
  }
  // Bearish: price made a higher high; divergence requires RSI to make a LOWER high.
  if (sweep.direction === 'bearish' && rsiAtSweep < rsiAtSwing) {
    return { confirmed: true, direction: 'bearish', rsiAtSweep, rsiAtSwing };
  }
  return null;
}

module.exports = { detectDivergence, rsiValueAtIndex };
