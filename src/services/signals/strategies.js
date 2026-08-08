'use strict';

// Freqtrade-style pluggable strategies: each is a named, complete scoring configuration
// (per-indicator weights, technical/fundamental balance, BUY/SELL thresholds, and the
// ATR stop-loss multiplier). Swapping strategies never changes the underlying indicator
// direction logic (technical-scorer.js) — only how much each indicator's vote counts and
// where the decision thresholds sit. `minRiskRewardRatio` and position sizing stay
// account-level (risk-settings), not strategy-level, since those are risk-tolerance
// decisions independent of which signals you trust.

const STRATEGIES = {
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    description: 'The default — every indicator contributes at its standard weight, technical 60% / fundamental 40%. A reasonable all-purpose starting point.',
    indicatorWeights: { rsi: 1, macd: 1, ema: 1, bollingerBands: 0.7, stochastic: 0.7, adx: 0.6, ichimoku: 0.6, supportResistance: 0.6, volumeAnalysis: 0.3 },
    technicalWeight: 0.6,
    fundamentalWeight: 0.4,
    buyThreshold: 0.3,
    sellThreshold: -0.3,
    atrMultiplier: 2,
  },
  'trend-following': {
    id: 'trend-following',
    name: 'Trend Following',
    description: 'Leans on EMA direction and ADX trend strength; mutes oscillators (RSI/Stochastic) that tend to flash contrarian "overbought" signals during strong trends — the classic "the trend is your friend" principle. Wider stops to ride out pullbacks.',
    indicatorWeights: { rsi: 0.2, macd: 1.2, ema: 1.8, bollingerBands: 0.2, stochastic: 0.1, adx: 1.8, ichimoku: 1.5, supportResistance: 0.5, volumeAnalysis: 0.4 },
    technicalWeight: 0.8,
    fundamentalWeight: 0.2,
    buyThreshold: 0.35,
    sellThreshold: -0.35,
    atrMultiplier: 2.5,
  },
  'mean-reversion': {
    id: 'mean-reversion',
    name: 'Mean Reversion',
    description: 'Leans on RSI and Bollinger Band extremes to catch overbought/oversold bounces; mutes trend indicators (EMA/ADX) since this strategy often trades against the prevailing trend at its extremes. Tighter stops for shorter-duration trades.',
    indicatorWeights: { rsi: 1.8, macd: 0.3, ema: 0.2, bollingerBands: 1.8, stochastic: 1.2, adx: 0.1, ichimoku: 0.2, supportResistance: 0.8, volumeAnalysis: 0.2 },
    technicalWeight: 0.75,
    fundamentalWeight: 0.25,
    buyThreshold: 0.25,
    sellThreshold: -0.25,
    atrMultiplier: 1.5,
  },
  momentum: {
    id: 'momentum',
    name: 'Momentum',
    description: 'Leans on MACD and volume confirmation — wants to see both price momentum and above-average participation before acting, moderate weight on trend context.',
    indicatorWeights: { rsi: 0.5, macd: 1.8, ema: 1.0, bollingerBands: 0.4, stochastic: 0.6, adx: 1.0, ichimoku: 0.6, supportResistance: 0.4, volumeAnalysis: 1.2 },
    technicalWeight: 0.7,
    fundamentalWeight: 0.3,
    buyThreshold: 0.3,
    sellThreshold: -0.3,
    atrMultiplier: 2,
  },
  'fundamentals-driven': {
    id: 'fundamentals-driven',
    name: 'Fundamentals-Driven',
    description: 'Same technical indicator emphasis as Balanced, but weighs the underlying asset’s fundamental health far more heavily than short-term technical noise (65% fundamental / 35% technical).',
    indicatorWeights: { rsi: 1, macd: 1, ema: 1, bollingerBands: 0.7, stochastic: 0.7, adx: 0.6, ichimoku: 0.6, supportResistance: 0.6, volumeAnalysis: 0.3 },
    technicalWeight: 0.35,
    fundamentalWeight: 0.65,
    buyThreshold: 0.3,
    sellThreshold: -0.3,
    atrMultiplier: 2,
  },
};

const DEFAULT_STRATEGY_ID = 'balanced';

function listStrategies() {
  return Object.values(STRATEGIES).map(({ id, name, description }) => ({ id, name, description }));
}

function getStrategy(id) {
  return STRATEGIES[id] || STRATEGIES[DEFAULT_STRATEGY_ID];
}

module.exports = { listStrategies, getStrategy, DEFAULT_STRATEGY_ID };
