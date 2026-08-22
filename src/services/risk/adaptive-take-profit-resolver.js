'use strict';

const marketDataService = require('../market-data/market-data-service');
const technicalAnalysis = require('../technical-analysis');
const adaptiveTakeProfitConfig = require('./adaptive-take-profit-config');
const adaptiveTakeProfitEngine = require('./adaptive-take-profit-engine');
const logger = require('../logging/logger');

/**
 * Bridges an opted-in asset (adaptive_tp_enabled=1 — see schema.js#migrateAddAssetAdaptiveTpColumn)
 * to the pure AdaptiveTakeProfitEngine at position-open time, shared by all 4 live schedulers
 * (auto-trader.js, reversal-spot-auto-trader.js, futures-auto-trader.js, reversal-auto-trader.js).
 *
 * Fetches its own fresh candle set, deliberately independent of whatever indicators the caller's
 * own signal/strategy pipeline already computed — the weighted-strategy signal object only carries
 * summaries (not the raw atr/adx/supportResistance/volumeAnalysis objects this engine needs), and
 * LSR's live-engine has no technical-scorer indicators at all. Same "each module does its own
 * independent fetch" convention as atr-trailing.js and lsr-timeframe-selector.js. This costs one
 * extra candle fetch per actually-opened position (a real BUY/open_long/open_short event, not
 * every scoring cycle), an acceptable, rare cost.
 *
 * Returns undefined (never throws) if the asset isn't opted in, or if the engine couldn't compute
 * usable targets (e.g. ATR unavailable and stopLoss missing/equal to entry) or the fetch/compute
 * itself fails — callers treat that exactly like "adaptive TP not requested," falling back to
 * their existing fixed take-profit. Fail-open, matching every other enrichment lookup in this
 * codebase (e.g. atr-trailing.js#resolveTrailingPercent's identical try/catch-to-null contract).
 */
async function resolveAdaptiveTp({ asset, symbol, exchange, market, timeframe, side, entryPrice, stopLoss }) {
  if (!asset || !asset.adaptive_tp_enabled) return undefined;

  try {
    const candles = await marketDataService.getCandles({ symbol, exchange, timeframe: timeframe || '1h', limit: 200, market });
    if (!candles || candles.length === 0) return undefined;

    const indicators = technicalAnalysis.computeAllIndicators(candles);
    const atr = indicators.atr;
    const atrValue = atr.status === 'ok' ? atr.value : null;
    const atrPercent = atrValue != null && entryPrice > 0 ? (atrValue / entryPrice) * 100 : null;

    let overrides = {};
    if (asset.adaptive_tp_config_json) {
      try {
        overrides = JSON.parse(asset.adaptive_tp_config_json);
      } catch {
        overrides = {};
      }
    }
    const config = adaptiveTakeProfitConfig.mergeConfig(overrides);
    const configErrors = adaptiveTakeProfitConfig.validateConfig(config);
    if (configErrors.length > 0) {
      logger.warn('adaptive-take-profit-resolver', `Invalid adaptive_tp_config_json for ${symbol}@${exchange}: ${configErrors.join('; ')} — falling back to fixed take-profit.`);
      return undefined;
    }

    const result = adaptiveTakeProfitEngine.computeAdaptiveTargets({
      entryPrice,
      currentPrice: entryPrice,
      side,
      atr: atrValue,
      atrPercent,
      stopLoss,
      trendStrength: indicators.adx,
      marketStructure: indicators.supportResistance,
      volumeCondition: indicators.volumeAnalysis,
      config,
    });

    if (result.TP1 == null && result.TP2 == null && result.TP3 == null) return undefined;

    logger.info(
      'adaptive-tp',
      `Adaptive targets computed for ${symbol}@${exchange} (${side}): entry ${entryPrice}, TP1 ${result.TP1}, TP2 ${result.TP2}, TP3 ${result.TP3}, stop ${stopLoss}`,
      {
        symbol, exchange, market, side, entryPrice, stopLoss, atr: atrValue, atrPercent,
        tp1: result.TP1, tp2: result.TP2, tp3: result.TP3,
        recommendedTrailingMultiplier: result.recommendedTrailingMultiplier,
        confidence: result.confidence, reason: result.reason, warnings: result.warnings,
      }
    );

    return {
      entryAtr: atrValue,
      rMultiple: typeof stopLoss === 'number' ? Math.abs(entryPrice - stopLoss) : null,
      entryContextJson: JSON.stringify({
        adx: indicators.adx.status === 'ok' ? indicators.adx.value : null,
        supportResistance: indicators.supportResistance.status === 'ok' ? indicators.supportResistance.value : null,
        volumeAnalysis: indicators.volumeAnalysis.status === 'ok' ? indicators.volumeAnalysis.value : null,
        atrPercent,
      }),
      tp1Price: result.TP1,
      tp2Price: result.TP2,
      tp3Price: result.TP3,
      tp1QtyPercent: config.tp1ClosePercent,
      tp2QtyPercent: config.tp2ClosePercent,
      tp3QtyPercent: config.tp3RemainingPercent,
      recommendedTrailingMultiplier: result.recommendedTrailingMultiplier,
      exitReversalConditionsJson: JSON.stringify(result.exitReversalConditions || []),
      // The classic take_profit column's fallback value for an adaptive position — see
      // position-risk-watcher.js#checkSpotTrigger's comment on why it's skipped for adaptive
      // positions in normal operation; this is purely a display/defense-in-depth ceiling.
      fallbackTakeProfit: result.TP3 ?? result.TP2 ?? result.TP1 ?? null,
    };
  } catch (err) {
    logger.warn('adaptive-take-profit-resolver', `Failed to resolve adaptive TP for ${symbol}@${exchange}: ${err.message}`);
    return undefined;
  }
}

module.exports = { resolveAdaptiveTp };
