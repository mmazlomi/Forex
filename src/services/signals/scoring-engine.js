'use strict';

const { computeTechnicalScore } = require('./technical-scorer');
const { computeFundamentalScore } = require('./fundamental-scorer');
const { computeRiskRewardRatio } = require('../risk/position-sizing');

const DEFAULT_SCORING_CONFIG = {
  technicalWeight: 0.6,
  fundamentalWeight: 0.4,
  buyThreshold: 0.3,
  sellThreshold: -0.3,
  atrMultiplier: 2,
  minRiskRewardRatio: 1.5,
};

function clip(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function assessDataQuality(indicators, candleCount) {
  const majorIndicators = ['rsi', 'macd', 'ema', 'adx', 'bollingerBands', 'stochastic'];
  const okCount = majorIndicators.filter((key) => indicators[key].status === 'ok').length;
  if (okCount === 0 || candleCount < 15) return 'insufficient';
  if (okCount === majorIndicators.length) return 'good';
  return 'degraded';
}

/**
 * Combines technical + fundamental analysis into a full signal record.
 * Final Score = (Technical Score × Technical Weight) + (Fundamental Score × Fundamental Weight)
 * — both documented in docs/phase2-requirements-architecture.md §1.4.
 */
function computeSignal({ candles, indicators, fundamentals, config = {}, strategyVersion = '1.0.0' }) {
  const cfg = { ...DEFAULT_SCORING_CONFIG, ...config };
  const warnings = [];

  const strategyId = cfg.id || 'custom';
  const strategyName = cfg.name || 'Custom';

  if (!candles || candles.length === 0) {
    return buildNoDataSignal({ warnings: ['No candle data available.'], strategyVersion, dataQuality: 'insufficient', strategyId, strategyName });
  }

  const lastCandle = candles[candles.length - 1];
  const price = lastCandle.close;
  const candleAgeMs = Date.now() - lastCandle.tsUtc;

  const dataQuality = assessDataQuality(indicators, candles.length);
  const { technicalScore, reasons: technicalReasons, summary: technicalSummary } = computeTechnicalScore(indicators, price, cfg.indicatorWeights);
  const { fundamentalScore, reasons: fundamentalReasons, summary: fundamentalSummary } = computeFundamentalScore(fundamentals);

  if (technicalScore === null) {
    warnings.push('No indicator had enough candle history to contribute a technical score.');
    return buildNoDataSignal({ price, warnings, strategyVersion, dataQuality: 'insufficient', technicalSummary, fundamentalSummary, strategyId, strategyName });
  }

  if (cfg.fundamentalWeight > 0 && fundamentalScore === null) {
    warnings.push(
      `Fundamental weight is ${cfg.fundamentalWeight} (> 0) but fundamental data is unavailable (${fundamentalSummary.reason}); refusing to generate BUY/SELL without it. Configure fundamental data access, or set fundamentalWeight to 0 for technical-only signals.`
    );
    return buildNoDataSignal({ price, warnings, strategyVersion, dataQuality, technicalScore, technicalSummary, fundamentalSummary, strategyId, strategyName });
  }

  const effectiveFundamentalScore = fundamentalScore ?? 0;
  const finalScore = clip(technicalScore * cfg.technicalWeight + effectiveFundamentalScore * cfg.fundamentalWeight, -1, 1);

  let status = 'HOLD';
  if (finalScore >= cfg.buyThreshold) status = 'BUY';
  else if (finalScore <= cfg.sellThreshold) status = 'SELL';

  let entry = null;
  let stopLoss = null;
  let takeProfit = null;
  let riskRewardRatio = null;

  if (status === 'BUY' || status === 'SELL') {
    const atr = indicators.atr;
    if (atr.status !== 'ok') {
      warnings.push(`${status} signal computed (score ${finalScore.toFixed(2)}) but ATR is unavailable to size a stop-loss; downgraded to HOLD.`);
      status = 'HOLD';
    } else {
      entry = price;
      const stopDistance = atr.value * cfg.atrMultiplier;
      if (status === 'BUY') {
        stopLoss = entry - stopDistance;
        takeProfit = entry + stopDistance * cfg.minRiskRewardRatio;
      } else {
        stopLoss = entry + stopDistance;
        takeProfit = entry - stopDistance * cfg.minRiskRewardRatio;
      }
      riskRewardRatio = computeRiskRewardRatio(entry, stopLoss, takeProfit);
    }
  }

  const confidenceBase = Math.abs(finalScore);
  const confidence = dataQuality === 'good' ? confidenceBase : dataQuality === 'degraded' ? confidenceBase * 0.7 : 0;

  if (candleAgeMs > 0) {
    // Freshness is enforced by the caller (market-data staleness check); recorded here for transparency.
  }

  return {
    price,
    technicalScore,
    fundamentalScore: effectiveFundamentalScore,
    finalScore,
    status,
    confidence: clip(confidence, 0, 1),
    reasons: [...technicalReasons, ...fundamentalReasons],
    technicalSummary,
    fundamentalSummary,
    entry,
    stopLoss,
    takeProfit,
    riskRewardRatio,
    dataQuality,
    warnings,
    strategyVersion,
    strategyId,
    strategyName,
  };
}

function buildNoDataSignal({ price = null, warnings, strategyVersion, dataQuality, technicalScore = null, technicalSummary = {}, fundamentalSummary = {}, strategyId = 'custom', strategyName = 'Custom' }) {
  return {
    price,
    technicalScore,
    fundamentalScore: null,
    finalScore: null,
    status: 'NO_DATA',
    confidence: 0,
    reasons: [],
    technicalSummary,
    fundamentalSummary,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskRewardRatio: null,
    dataQuality,
    warnings,
    strategyVersion,
    strategyId,
    strategyName,
  };
}

module.exports = { computeSignal, DEFAULT_SCORING_CONFIG };
