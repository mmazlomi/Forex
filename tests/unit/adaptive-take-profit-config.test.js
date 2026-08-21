'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG, mergeConfig, validateConfig } = require('../../src/services/risk/adaptive-take-profit-config');

test('DEFAULT_CONFIG itself is valid', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test('mergeConfig deep-merges the nested volatilityRegimeAtrPercentThreshold without losing unset sub-keys', () => {
  const merged = mergeConfig({ volatilityRegimeAtrPercentThreshold: { low: 2 } });
  assert.equal(merged.volatilityRegimeAtrPercentThreshold.low, 2);
  assert.equal(merged.volatilityRegimeAtrPercentThreshold.high, DEFAULT_CONFIG.volatilityRegimeAtrPercentThreshold.high);
});

test('mergeConfig with no overrides returns DEFAULT_CONFIG values', () => {
  const merged = mergeConfig();
  assert.equal(merged.atrPeriod, DEFAULT_CONFIG.atrPeriod);
  assert.equal(merged.targetMode, DEFAULT_CONFIG.targetMode);
});

test('validateConfig rejects an unknown targetMode', () => {
  const errors = validateConfig(mergeConfig({ targetMode: 'nonsense' }));
  assert.ok(errors.some((e) => e.includes('targetMode')));
});

test('validateConfig rejects partial-exit percentages that do not sum to exactly 100', () => {
  const errors = validateConfig(mergeConfig({ tp1ClosePercent: 25, tp2ClosePercent: 35, tp3RemainingPercent: 30 }));
  assert.ok(errors.some((e) => e.includes('sum to exactly 100')));
});

test('validateConfig accepts partial-exit percentages that sum to exactly 100 with non-default values', () => {
  const errors = validateConfig(mergeConfig({ tp1ClosePercent: 50, tp2ClosePercent: 30, tp3RemainingPercent: 20 }));
  assert.deepEqual(errors, []);
});

test('validateConfig rejects non-strictly-increasing ATR multipliers', () => {
  const errors = validateConfig(mergeConfig({ tp1AtrMultiplier: 2, tp2AtrMultiplier: 2, tp3AtrMultiplier: 3 }));
  assert.ok(errors.some((e) => e.includes('tp1AtrMultiplier < tp2AtrMultiplier < tp3AtrMultiplier')));
});

test('validateConfig rejects non-strictly-increasing R multiples', () => {
  const errors = validateConfig(mergeConfig({ tp1RMultiple: 2, tp2RMultiple: 1.5, tp3RMultiple: 3 }));
  assert.ok(errors.some((e) => e.includes('tp1RMultiple < tp2RMultiple < tp3RMultiple')));
});

test('validateConfig rejects a non-positive multiplier', () => {
  const errors = validateConfig(mergeConfig({ trailingAtrMultiplier: 0 }));
  assert.ok(errors.some((e) => e.includes('trailingAtrMultiplier must be > 0')));
});

test('validateConfig rejects maxRiskRewardRatio below minRiskRewardRatio', () => {
  const errors = validateConfig(mergeConfig({ minRiskRewardRatio: 3, maxRiskRewardRatio: 2 }));
  assert.ok(errors.some((e) => e.includes('maxRiskRewardRatio must be >= minRiskRewardRatio')));
});

test('validateConfig rejects an invalid volatilityRegimeAtrPercentThreshold (high <= low)', () => {
  const errors = validateConfig(mergeConfig({ volatilityRegimeAtrPercentThreshold: { low: 3, high: 1 } }));
  assert.ok(errors.some((e) => e.includes('volatilityRegimeAtrPercentThreshold')));
});

test('validateConfig accumulates multiple independent errors rather than stopping at the first', () => {
  const errors = validateConfig(mergeConfig({ targetMode: 'bogus', trailingAtrMultiplier: -1 }));
  assert.ok(errors.length >= 2);
});
