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

/**
 * Resolves a position/signal's stored strategy_id — a single id, or (for combined/auto-mode
 * signals) a "id1+id2" joined string, per buildSignalRecord's convention in signals/index.js —
 * plus the optional combined_strategy_ids_json sidecar, into a list of {id, name} pairs for
 * display: "which strategy/strategies opened this position". Returns [] for a position with no
 * strategy_id (opened without ever going through a signal, e.g. a bare manual order). Unlike
 * getStrategy(), an id that isn't a known strategy falls back to itself rather than silently
 * mislabeling it "Balanced" — this is a display path, not a scoring lookup.
 */
function describeStrategyIds(strategyId, combinedStrategyIdsJson) {
  if (!strategyId) return [];
  let ids = null;
  if (combinedStrategyIdsJson) {
    try {
      const parsed = JSON.parse(combinedStrategyIdsJson);
      if (Array.isArray(parsed) && parsed.length > 0) ids = parsed;
    } catch {
      ids = null;
    }
  }
  if (!ids) ids = strategyId.split('+');
  return ids.map((id) => ({ id, name: STRATEGIES[id] ? STRATEGIES[id].name : (EXTENDED_STRATEGY_NAMES[id] || id) }));
}

// Liquidity Sweep Reversal (see src/services/reversal-strategy/) is a strategy id in the same
// "which strategy is this asset trading with" sense as everything above, but it is NOT a
// per-candle weighted-score config — it's a stateful, multi-timeframe sequence, driven by its own
// scheduler (reversal-auto-trader.js/reversal-spot-auto-trader.js), never by
// scoreWithStrategy()/computeSignal(). Deliberately kept OUT of the STRATEGIES map above:
// optimizer.js/strategy-selector.js both default their candidate set to
// listStrategies().map(s => s.id) for real backtesting/ranking, and scoring an LSR-tagged asset
// as if it were a weighted config would silently fall back to "balanced" and corrupt that
// ranking (this exact bug shipped to production once — see scoringRejectionReason below).
// EXTENDED_STRATEGY_IDS/EXTENDED_STRATEGY_NAMES exist so id VALIDATION (addAsset/setStrategy) and
// DISPLAY (describeStrategyIds above) can recognize it as legitimate without ever routing it
// through getStrategy()/scoring. Kept as a local name map rather than importing
// LSR_STRATEGY_NAME from reversal-backtest-engine.js, so this file (required by many unrelated
// controllers) never needs to know that module exists.
const STRATEGY_ID_LSR = 'liquidity-sweep-reversal';
const EXTENDED_STRATEGY_IDS = [STRATEGY_ID_LSR];
const EXTENDED_STRATEGY_NAMES = { [STRATEGY_ID_LSR]: 'Liquidity Sweep Reversal (LSR)' };

/**
 * Validates/normalizes a strategy id for STORAGE (an asset's strategy_id column) — accepts any
 * real STRATEGIES key OR an extended (non-scoring) id like LSR's, unlike getStrategy() which only
 * ever knows about STRATEGIES and silently falls back to the default for anything else. Use this
 * at every id-accepting API boundary (addAsset/setStrategy); use getStrategy() only where the
 * caller genuinely needs a weighted scoring config back.
 */
function resolveStrategyId(id) {
  if (EXTENDED_STRATEGY_IDS.includes(id)) return id;
  return getStrategy(id).id;
}

/**
 * Guards every on-demand SCORING entry point (manual "Generate Signal", the legacy single-
 * timeframe "Run Backtest"/"Optimize" — anything that ends up calling getStrategy()/
 * scoreWithStrategy()) against being handed an extended id like LSR's. Without this, those paths
 * would silently fall through getStrategy()'s STRATEGIES-only lookup to "balanced" and produce a
 * signal/backtest result that has nothing to do with the strategy the caller actually asked for —
 * exactly the bug class that produced a spurious SELL signal for an LSR-tagged asset in
 * production (2026-08-14). Returns an error message string if `strategyId` is an extended id
 * that shouldn't reach a scoring path, or null if it's fine to proceed.
 */
function scoringRejectionReason(strategyId) {
  if (!EXTENDED_STRATEGY_IDS.includes(strategyId)) return null;
  return `"${EXTENDED_STRATEGY_NAMES[strategyId] || strategyId}" is a stateful, multi-timeframe strategy — it doesn't support on-demand signal generation or the single-timeframe backtest/optimizer here. It runs continuously via its own scheduler once enabled on the Watchlist tab; see docs/reversal-strategy/ for its dedicated backtest tooling.`;
}

module.exports = {
  listStrategies, getStrategy, describeStrategyIds, resolveStrategyId, scoringRejectionReason,
  EXTENDED_STRATEGY_IDS, DEFAULT_STRATEGY_ID,
};
