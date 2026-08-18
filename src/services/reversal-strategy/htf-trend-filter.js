'use strict';

// Higher-timeframe Ichimoku trend filter — see docs/reversal-strategy/STRATEGY_SPEC.md §2. A
// hard veto (not a bias): if the configured conditions for a direction aren't ALL met, that
// direction is not allowed at all, regardless of what the lower timeframes show.

const ichimoku = require('../technical-analysis/ichimoku');

/**
 * @param {Array} htfCandles the higher-timeframe candles, already truncated to "as of now" by
 *        the caller (see timeframe-alignment.js#latestClosedCandleAsOf for how the caller finds
 *        the right cutoff — this function itself has no timestamp awareness).
 * @param {number} asOfIndex index of the latest closed HTF candle to evaluate from
 * @param {object} config merged strategy config (reads config.htfFilter.*)
 * @returns {{allowedDirections: Array<'bullish'|'bearish'>, price:number|null, conversion:number|null,
 *            base:number|null, cloudTop:number|null, cloudBottom:number|null, kijunSlope:number|null}}
 */
function evaluateTrendFilter(htfCandles, asOfIndex, config) {
  const { requirePriceVsCloud, requireTenkanKijunCross, requireKijunSlope, kijunSlopeLookback, ichimoku: ichimokuParams } = config.htfFilter;

  const window = htfCandles.slice(0, asOfIndex + 1);
  const current = ichimoku.compute(window, ichimokuParams);
  if (current.status !== 'ok') {
    return { allowedDirections: [], price: null, conversion: null, base: null, cloudTop: null, cloudBottom: null, kijunSlope: null };
  }

  const price = htfCandles[asOfIndex].close;
  const { conversion, base, cloudTop, cloudBottom } = current.value;

  let kijunSlope = null;
  if (requireKijunSlope) {
    const priorIndex = asOfIndex - kijunSlopeLookback;
    if (priorIndex >= 0) {
      const prior = ichimoku.compute(htfCandles.slice(0, priorIndex + 1), ichimokuParams);
      if (prior.status === 'ok') kijunSlope = base - prior.value.base;
    }
  }

  const longConditions = [];
  if (requirePriceVsCloud) longConditions.push(price > cloudTop);
  if (requireTenkanKijunCross) longConditions.push(conversion > base);
  if (requireKijunSlope) longConditions.push(kijunSlope !== null && kijunSlope > 0);

  const shortConditions = [];
  if (requirePriceVsCloud) shortConditions.push(price < cloudBottom);
  if (requireTenkanKijunCross) shortConditions.push(conversion < base);
  if (requireKijunSlope) shortConditions.push(kijunSlope !== null && kijunSlope < 0);

  const allowedDirections = [];
  // An empty condition list means every sub-check was configured off — treated as "the filter
  // itself is disabled", i.e. permissive, rather than vacuously denying everything.
  if (longConditions.length === 0 || longConditions.every(Boolean)) allowedDirections.push('bullish');
  if (shortConditions.length === 0 || shortConditions.every(Boolean)) allowedDirections.push('bearish');

  return { allowedDirections, price, conversion, base, cloudTop, cloudBottom, kijunSlope };
}

module.exports = { evaluateTrendFilter };
