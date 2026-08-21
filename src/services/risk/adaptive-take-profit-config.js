'use strict';

// Every tunable parameter for AdaptiveTakeProfitEngine (adaptive-take-profit-engine.js), in one
// place — mirrors reversal-strategy/config.js's exact DEFAULT_CONFIG/mergeConfig/validateConfig
// shape. Nothing in the engine hardcodes any of these values directly; they always come from a
// config object built by mergeConfig().

const DEFAULT_CONFIG = {
  atrPeriod: 14,

  // How TP1/TP2/TP3 are computed. 'atr': entry +/- ATR x multiplier. 'r_multiple': entry +/-
  // |entry - stopLoss| x multiple. 'blend': the average of both. All three multiplier sets below
  // are always computed regardless of targetMode, so callers/backtests can compare them.
  targetMode: 'atr', // 'atr' | 'r_multiple' | 'blend'

  tp1AtrMultiplier: 1.0,
  tp2AtrMultiplier: 2.0,
  tp3AtrMultiplier: 3.0,

  tp1RMultiple: 1.0,
  tp2RMultiple: 2.0,
  tp3RMultiple: 3.0,

  // Partial-exit sizing, all as a percent of the ORIGINAL position size (not the shrinking
  // remainder) — must sum to exactly 100.
  tp1ClosePercent: 25,
  tp2ClosePercent: 35,
  tp3RemainingPercent: 40,

  trailingAtrMultiplier: 1.5,

  // How close (as a percent of price) a computed TP may sit to a support/resistance level before
  // it gets snapped to the level itself (minus/plus this same buffer) instead of overshooting it.
  supportResistanceBufferPercent: 0.15,

  minRiskRewardRatio: 1.0,
  maxRiskRewardRatio: 6.0,

  // Trend strength: reuses technical-scorer.js#scoreAdx's exact ADX>25 convention rather than
  // inventing a new threshold scheme.
  trendStrengthAdxThreshold: 25,
  trendWideningFactor: 1.25, // multiplier applied to TP distance when trend agrees & is strong
  trendTighteningFactor: 0.85, // multiplier applied when trend is weak/absent

  // ATR as a percent of price, used to classify the volatility regime for logging/confidence —
  // does not itself change targets, only the recommended trailing multiplier's confidence.
  volatilityRegimeAtrPercentThreshold: { low: 1.0, high: 3.0 },

  // Volume is a confidence/reason modifier only (see applyVolumeModifier) — per spec, it must
  // never gate or veto a target on its own.
  volumeConfirmationRelativeVolumeThreshold: 1.2,

  reversalExitEnabled: true,
};

/** Deep-merges a partial override onto DEFAULT_CONFIG, same one-level-deep-nesting shape as
 *  reversal-strategy/config.js's mergeConfig (this config's only nested key is
 *  volatilityRegimeAtrPercentThreshold). */
function mergeConfig(overrides = {}) {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  merged.volatilityRegimeAtrPercentThreshold = {
    ...DEFAULT_CONFIG.volatilityRegimeAtrPercentThreshold,
    ...overrides.volatilityRegimeAtrPercentThreshold,
  };
  return merged;
}

const VALID_TARGET_MODES = ['atr', 'r_multiple', 'blend'];
const PARTIAL_PERCENT_SUM_EPSILON = 1e-9;

/** Fails fast on an invalid config rather than letting a typo silently produce nonsensical
 *  targets or an over-100%-of-position partial close. Returns an array of error strings (empty =
 *  valid), same convention as reversal-strategy/config.js#validateConfig. */
function validateConfig(config) {
  const errors = [];
  if (!VALID_TARGET_MODES.includes(config.targetMode)) {
    errors.push(`targetMode must be one of ${VALID_TARGET_MODES.join(', ')}, got "${config.targetMode}"`);
  }
  if (!(config.atrPeriod >= 1)) errors.push('atrPeriod must be >= 1');
  for (const key of ['tp1AtrMultiplier', 'tp2AtrMultiplier', 'tp3AtrMultiplier', 'tp1RMultiple', 'tp2RMultiple', 'tp3RMultiple', 'trailingAtrMultiplier']) {
    if (!(config[key] > 0)) errors.push(`${key} must be > 0`);
  }
  if (!(config.tp1AtrMultiplier < config.tp2AtrMultiplier && config.tp2AtrMultiplier < config.tp3AtrMultiplier)) {
    errors.push('tp1AtrMultiplier < tp2AtrMultiplier < tp3AtrMultiplier must hold (targets must be strictly increasing)');
  }
  if (!(config.tp1RMultiple < config.tp2RMultiple && config.tp2RMultiple < config.tp3RMultiple)) {
    errors.push('tp1RMultiple < tp2RMultiple < tp3RMultiple must hold (targets must be strictly increasing)');
  }
  const percentSum = config.tp1ClosePercent + config.tp2ClosePercent + config.tp3RemainingPercent;
  if (Math.abs(percentSum - 100) > PARTIAL_PERCENT_SUM_EPSILON) {
    errors.push(`tp1ClosePercent + tp2ClosePercent + tp3RemainingPercent must sum to exactly 100, got ${percentSum}`);
  }
  for (const key of ['tp1ClosePercent', 'tp2ClosePercent', 'tp3RemainingPercent']) {
    if (!(config[key] >= 0)) errors.push(`${key} must be >= 0`);
  }
  if (!(config.minRiskRewardRatio > 0)) errors.push('minRiskRewardRatio must be > 0');
  if (!(config.maxRiskRewardRatio >= config.minRiskRewardRatio)) {
    errors.push('maxRiskRewardRatio must be >= minRiskRewardRatio');
  }
  if (!(config.supportResistanceBufferPercent >= 0)) errors.push('supportResistanceBufferPercent must be >= 0');
  if (!(config.trendStrengthAdxThreshold >= 0)) errors.push('trendStrengthAdxThreshold must be >= 0');
  if (!(config.trendWideningFactor > 0)) errors.push('trendWideningFactor must be > 0');
  if (!(config.trendTighteningFactor > 0)) errors.push('trendTighteningFactor must be > 0');
  const { low, high } = config.volatilityRegimeAtrPercentThreshold || {};
  if (!(low >= 0) || !(high > low)) {
    errors.push('volatilityRegimeAtrPercentThreshold must be {low, high} with 0 <= low < high');
  }
  if (!(config.volumeConfirmationRelativeVolumeThreshold > 0)) {
    errors.push('volumeConfirmationRelativeVolumeThreshold must be > 0');
  }
  return errors;
}

module.exports = { DEFAULT_CONFIG, mergeConfig, validateConfig };
