'use strict';

// Stop-loss models — see docs/reversal-strategy/STRATEGY_SPEC.md §9. Both models anchor to the
// sweep bar's own extreme (the level liquidity was actually taken from), per the original spec's
// own formula ("SL = Sweep Low - ATR x multiplier").

const atr = require('../technical-analysis/atr');

/**
 * @param {Array} candles oldest-first, windowed to "as of the sweep bar" is NOT required here —
 *        the ATR model windows internally to `sweep.sweepIndex` itself (never later data).
 * @param {object} sweep the confirmed sweep (from liquidity-sweep-detector)
 * @param {'bullish'|'bearish'} direction
 * @param {object} config merged strategy config
 * @returns {number|null} null only for the 'atr' model when there isn't enough ATR history yet
 *          (the setup should be treated as invalid, not silently defaulted, in that case)
 */
function computeStopLoss(candles, sweep, direction, config) {
  if (config.slModel === 'sweep_extreme') {
    return direction === 'bullish'
      ? sweep.sweepLow * (1 - config.slBufferPercent / 100)
      : sweep.sweepHigh * (1 + config.slBufferPercent / 100);
  }

  const window = candles.slice(0, sweep.sweepIndex + 1);
  const result = atr.compute(window, { period: config.atrPeriod });
  if (result.status !== 'ok') return null;

  return direction === 'bullish'
    ? sweep.sweepLow - result.value * config.atrMultiplier
    : sweep.sweepHigh + result.value * config.atrMultiplier;
}

module.exports = { computeStopLoss };
