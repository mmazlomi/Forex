'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG, SESSION_PRESETS, mergeConfig, validateConfig } = require('../../../src/services/reversal-strategy/config');

test('mergeConfig with no overrides returns the defaults', () => {
  const merged = mergeConfig();
  assert.deepEqual(merged, DEFAULT_CONFIG);
});

test('mergeConfig deep-merges nested htfFilter/htfFilter.ichimoku/sessionFilter objects rather than replacing them wholesale', () => {
  const merged = mergeConfig({ htfFilter: { requireKijunSlope: false } });
  assert.equal(merged.htfFilter.requireKijunSlope, false);
  // Every other htfFilter key (and the nested ichimoku sub-object) must survive untouched.
  assert.equal(merged.htfFilter.requirePriceVsCloud, true);
  assert.deepEqual(merged.htfFilter.ichimoku, DEFAULT_CONFIG.htfFilter.ichimoku);
});

test('mergeConfig top-level overrides do not leak into unrelated keys', () => {
  const merged = mergeConfig({ riskRewardRatio: 5 });
  assert.equal(merged.riskRewardRatio, 5);
  assert.equal(merged.rsiPeriod, DEFAULT_CONFIG.rsiPeriod);
});

test('validateConfig accepts the defaults with no errors', () => {
  assert.deepEqual(validateConfig(mergeConfig()), []);
});

test('validateConfig rejects an invalid entryMode/slModel/chochConfirmationBasis', () => {
  assert.ok(validateConfig(mergeConfig({ entryMode: 'nope' })).length > 0);
  assert.ok(validateConfig(mergeConfig({ slModel: 'nope' })).length > 0);
  assert.ok(validateConfig(mergeConfig({ chochConfirmationBasis: 'nope' })).length > 0);
});

test('validateConfig rejects non-positive numeric parameters', () => {
  assert.ok(validateConfig(mergeConfig({ swingLookback: 0 })).length > 0);
  assert.ok(validateConfig(mergeConfig({ riskRewardRatio: 0 })).length > 0);
  assert.ok(validateConfig(mergeConfig({ riskPerTradePercent: -1 })).length > 0);
});

test('validateConfig rejects an unknown named session preset', () => {
  const errors = validateConfig(mergeConfig({ sessionFilter: { allowedSessions: ['tokyo'] } }));
  assert.ok(errors.some((e) => e.includes('tokyo')));
});

test('validateConfig accepts a custom {startHourUtc, endHourUtc} session object', () => {
  const errors = validateConfig(mergeConfig({ sessionFilter: { allowedSessions: [{ startHourUtc: 1, endHourUtc: 5 }] } }));
  assert.deepEqual(errors, []);
});

test('SESSION_PRESETS has exactly the three named presets documented in STRATEGY_SPEC.md', () => {
  assert.deepEqual(Object.keys(SESSION_PRESETS).sort(), ['asian', 'london', 'newYork'].sort());
});
