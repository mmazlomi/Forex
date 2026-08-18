'use strict';

// Every tunable parameter for the Liquidity Sweep -> RSI Divergence -> CHOCH -> Retest -> Entry
// strategy, in one place, with the defaults chosen in docs/reversal-strategy/STRATEGY_SPEC.md
// (reasoning for each default lives there, not here). Nothing in the detector modules hardcodes
// any of these values directly — they always come from a config object built by mergeConfig().

const DEFAULT_CONFIG = {
  htfTimeframe: '4h',
  signalTimeframe: '15m',
  entryTimeframe: '5m',

  htfFilter: {
    requirePriceVsCloud: true,
    requireTenkanKijunCross: true,
    requireKijunSlope: true,
    kijunSlopeLookback: 3,
    ichimoku: { conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26 },
  },

  swingLookback: 2,

  sweepLookbackBars: 50,
  sweepMinPenetrationPercent: 0.05,

  rsiPeriod: 14,
  maxDivergenceDistanceBars: 50,

  chochConfirmationBasis: 'close', // 'close' | 'wick'
  chochExpiryBars: 30,

  entryMode: 'retest_confirmation', // 'immediate' | 'retest' | 'retest_confirmation'
  retestTolerancePercent: 0.1,
  retestExpiryBars: 40,
  confirmationExpiryBars: 10,

  slModel: 'sweep_extreme', // 'sweep_extreme' | 'atr'
  slBufferPercent: 0.05,
  atrPeriod: 14,
  atrMultiplier: 1.5,

  riskRewardRatio: 2,

  riskPerTradePercent: 0.5,
  maxDailyLossPercent: 3,
  maxConsecutiveLosses: 4,
  maxOpenTrades: 1,
  minRiskRewardRatio: 1.5,

  sessionFilter: {
    enabled: false,
    allowedSessions: ['asian', 'london', 'newYork'],
    excludeWeekends: false,
    excludeFriday: false,
  },

  feePercent: 0.1,
  slippagePercent: 0.05,
};

const SESSION_PRESETS = {
  asian: { startHourUtc: 0, endHourUtc: 8 },
  london: { startHourUtc: 8, endHourUtc: 16 },
  newYork: { startHourUtc: 13, endHourUtc: 21 },
};

/** Deep-merges a partial override onto DEFAULT_CONFIG — every module receives a fully-populated
 *  config regardless of how few keys the caller actually overrode. Two levels deep is enough for
 *  every nested key this config actually has (htfFilter.*, htfFilter.ichimoku.*, sessionFilter.*). */
function mergeConfig(overrides = {}) {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  merged.htfFilter = { ...DEFAULT_CONFIG.htfFilter, ...overrides.htfFilter };
  merged.htfFilter.ichimoku = { ...DEFAULT_CONFIG.htfFilter.ichimoku, ...overrides.htfFilter?.ichimoku };
  merged.sessionFilter = { ...DEFAULT_CONFIG.sessionFilter, ...overrides.sessionFilter };
  return merged;
}

const VALID_ENTRY_MODES = ['immediate', 'retest', 'retest_confirmation'];
const VALID_SL_MODELS = ['sweep_extreme', 'atr'];
const VALID_CHOCH_BASES = ['close', 'wick'];

/** Fails fast on an invalid config rather than letting a typo silently fall back to undefined
 *  behavior deep inside a detector. Returns an array of error strings (empty = valid). */
function validateConfig(config) {
  const errors = [];
  if (!VALID_ENTRY_MODES.includes(config.entryMode)) {
    errors.push(`entryMode must be one of ${VALID_ENTRY_MODES.join(', ')}, got "${config.entryMode}"`);
  }
  if (!VALID_SL_MODELS.includes(config.slModel)) {
    errors.push(`slModel must be one of ${VALID_SL_MODELS.join(', ')}, got "${config.slModel}"`);
  }
  if (!VALID_CHOCH_BASES.includes(config.chochConfirmationBasis)) {
    errors.push(`chochConfirmationBasis must be one of ${VALID_CHOCH_BASES.join(', ')}, got "${config.chochConfirmationBasis}"`);
  }
  if (!(config.swingLookback >= 1)) errors.push('swingLookback must be >= 1');
  if (!(config.riskRewardRatio > 0)) errors.push('riskRewardRatio must be > 0');
  if (!(config.riskPerTradePercent > 0)) errors.push('riskPerTradePercent must be > 0');
  for (const name of config.sessionFilter.allowedSessions) {
    if (typeof name === 'string' && !SESSION_PRESETS[name]) {
      errors.push(`Unknown session preset "${name}" — must be one of ${Object.keys(SESSION_PRESETS).join(', ')} or a {startHourUtc, endHourUtc} object`);
    }
  }
  return errors;
}

module.exports = { DEFAULT_CONFIG, SESSION_PRESETS, mergeConfig, validateConfig };
