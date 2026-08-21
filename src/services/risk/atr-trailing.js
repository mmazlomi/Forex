'use strict';

// ATR-based auto trailing-stop distance — the alternative to a user-typed flat trailing_percent
// (see assets-repository.js#setTrailingPercent / schema.js's trailing_mode column). A wider
// distance when the market is genuinely more volatile, tighter when it's calm, instead of one
// fixed number regardless of conditions. Computed fresh each time a position opens from an
// 'atr'-mode asset and then stored on that position's own trailing_percent column — after that it
// behaves exactly like a manually-set trailing stop (position-risk-watcher.js's ratchet logic
// doesn't know or care where the percent came from), matching the existing "fixed for this
// position's lifetime" contract.

const atr = require('../technical-analysis/atr');
const marketDataService = require('../market-data/market-data-service');

const ATR_PERIOD = 14;
// 2x ATR is the standard starting multiplier for a volatility-based trailing stop (wide enough to
// ride out normal noise, tight enough to still protect gains) — not tuned per-asset here, but a
// reasonable single default.
const ATR_MULTIPLIER = 2;
// Sane bounds so a near-zero-volatility read never produces an unusably tight stop that closes on
// the next tick, and a spike never produces a "trailing stop" wider than a typical take-profit.
const MIN_TRAILING_PERCENT = 0.1;
const MAX_TRAILING_PERCENT = 20;

/**
 * Fetches recent candles + live price and returns the ATR(14) x 2 distance as a percent of price,
 * clamped to [MIN_TRAILING_PERCENT, MAX_TRAILING_PERCENT]. Returns null (never throws) if there
 * isn't enough candle history yet or the live price can't be fetched — callers treat null the same
 * as "trailing not enabled" rather than blocking the trade on it.
 */
async function resolveAtrTrailingPercent({ symbol, exchange, market, timeframe }) {
  const effectiveTimeframe = timeframe || '1h';
  const [candles, snapshot] = await Promise.all([
    marketDataService.getCandles({ symbol, exchange, timeframe: effectiveTimeframe, limit: ATR_PERIOD + 10, market }),
    market === 'futures'
      ? marketDataService.getFuturesSnapshot({ symbol, exchange })
      : marketDataService.getSnapshot({ symbol, exchange }),
  ]);

  if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number' || snapshot.price <= 0) return null;

  const result = atr.compute(candles, { period: ATR_PERIOD });
  if (result.status !== 'ok' || typeof result.value !== 'number') return null;

  const rawPercent = (result.value * ATR_MULTIPLIER / snapshot.price) * 100;
  return Math.min(MAX_TRAILING_PERCENT, Math.max(MIN_TRAILING_PERCENT, rawPercent));
}

/**
 * The trailing_percent value a newly-opened position should inherit from its asset config.
 * 'atr' mode computes it fresh from current volatility (falling back to null — trailing simply
 * off for this position — if data isn't available, the same fail-open convention as other
 * display/enrichment-only lookups in this codebase, never blocking the trade itself).
 * 'fixed' mode (or a pre-migration asset with no trailing_mode) returns the stored flat percent
 * unchanged.
 */
async function resolveTrailingPercent(asset, { symbol, exchange, market, timeframe }) {
  if (asset.trailing_mode !== 'atr') return asset.trailing_percent;
  try {
    return await resolveAtrTrailingPercent({ symbol, exchange, market, timeframe });
  } catch {
    return null;
  }
}

module.exports = {
  resolveTrailingPercent,
  resolveAtrTrailingPercent,
  ATR_PERIOD,
  ATR_MULTIPLIER,
  MIN_TRAILING_PERCENT,
  MAX_TRAILING_PERCENT,
};
