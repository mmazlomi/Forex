'use strict';

/**
 * Market Regime Classifier (inspired by Hummingbot & quantitative trend-filter systems)
 *
 * Classifies market conditions into 4 actionable regimes:
 * - TRENDING_BULLISH: Strong uptrend (ADX >= 25, price above EMAs). Favors Trend Following / Momentum.
 * - TRENDING_BEARISH: Strong downtrend (ADX >= 25, price below EMAs). Favors Shorting / Cash.
 * - VOLATILITY_SQUEEZE: Bollinger Bands contracting to historical narrowness. Breakout imminent.
 * - RANGING_CHOPPY: Low directional momentum (ADX < 20). Favors Mean Reversion / Grid.
 */

function classifyMarketRegime(candles, indicators = {}) {
  if (!Array.isArray(candles) || candles.length < 20) {
    return {
      status: 'insufficient_history',
      regime: 'INSUFFICIENT_DATA',
      regimeName: 'Insufficient Data',
      description: 'Need at least 20 closed candles to classify market regime.',
      recommendedStrategy: 'balanced',
      adx: null,
      trendStrength: 'unknown',
    };
  }

  const latestCandle = candles[candles.length - 1];
  const closePrice = latestCandle.close;

  const adxValue = typeof indicators.adx?.value === 'number' ? indicators.adx.value : null;
  const emaShort = typeof indicators.ema?.emaShort === 'number' ? indicators.ema.emaShort : null;
  const emaLong = typeof indicators.ema?.emaLong === 'number' ? indicators.ema.emaLong : null;
  const bb = indicators.bollingerBands;

  // 1. Calculate Bollinger Band Width (BBW)
  let bbw = null;
  if (bb && typeof bb.upper === 'number' && typeof bb.lower === 'number' && typeof bb.middle === 'number' && bb.middle > 0) {
    bbw = (bb.upper - bb.lower) / bb.middle;
  }

  // 2. Check for Volatility Squeeze (very narrow BBW, e.g. < 0.02 or 2%)
  const isSqueeze = bbw !== null && bbw < 0.025;

  // 3. Evaluate ADX trend strength
  const isStrongTrend = adxValue !== null && adxValue >= 25;
  const isWeakTrend = adxValue !== null && adxValue < 20;

  // 4. Directional bias
  const isAboveEmas = emaShort && emaLong ? closePrice > emaShort && emaShort > emaLong : false;
  const isBelowEmas = emaShort && emaLong ? closePrice < emaShort && emaShort < emaLong : false;

  // 5. Determine Regime
  if (isSqueeze) {
    return {
      status: 'ok',
      regime: 'VOLATILITY_SQUEEZE',
      regimeName: 'Volatility Squeeze',
      description: 'Volatility is heavily compressed. A high-momentum breakout is building up.',
      recommendedStrategy: 'momentum',
      alternativeStrategies: ['ict-fvg', 'momentum'],
      trendStrength: isStrongTrend ? 'strong' : 'building',
      adx: adxValue,
      bandwidth: bbw ? Number((bbw * 100).toFixed(2)) : null,
      confidence: 0.85,
    };
  }

  if (isStrongTrend && isAboveEmas) {
    return {
      status: 'ok',
      regime: 'TRENDING_BULLISH',
      regimeName: 'Strong Bullish Trend',
      description: 'Strong upward momentum confirmed by ADX and EMA alignment. "Trend is your friend."',
      recommendedStrategy: 'trend-following',
      alternativeStrategies: ['supertrend-pullback', 'trend-following'],
      trendStrength: 'strong',
      adx: adxValue,
      bandwidth: bbw ? Number((bbw * 100).toFixed(2)) : null,
      confidence: 0.9,
    };
  }

  if (isStrongTrend && isBelowEmas) {
    return {
      status: 'ok',
      regime: 'TRENDING_BEARISH',
      regimeName: 'Strong Bearish Trend',
      description: 'Strong downward momentum confirmed by ADX and EMA alignment.',
      recommendedStrategy: 'trend-following',
      alternativeStrategies: ['supertrend-pullback', 'trend-following'],
      trendStrength: 'strong',
      adx: adxValue,
      bandwidth: bbw ? Number((bbw * 100).toFixed(2)) : null,
      confidence: 0.9,
    };
  }

  if (isWeakTrend) {
    return {
      status: 'ok',
      regime: 'RANGING_CHOPPY',
      regimeName: 'Ranging / Choppy',
      description: 'Market lacks directional conviction. Oscillators (RSI / Bollinger bounces) dominate.',
      recommendedStrategy: 'mean-reversion',
      alternativeStrategies: ['volume-profile-confluence', 'mean-reversion'],
      trendStrength: 'weak',
      adx: adxValue,
      bandwidth: bbw ? Number((bbw * 100).toFixed(2)) : null,
      confidence: 0.75,
    };
  }

  // Default transitional regime
  return {
    status: 'ok',
    regime: 'TRANSITIONAL',
    regimeName: 'Transitional / Neutral',
    description: 'Market is transitioning between trend and range phases.',
    recommendedStrategy: 'balanced',
    trendStrength: 'moderate',
    adx: adxValue,
    bandwidth: bbw ? Number((bbw * 100).toFixed(2)) : null,
    confidence: 0.65,
  };
}

module.exports = { classifyMarketRegime };
