'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeAdaptiveTargets, normalizeSide, computeAtrTargets, computeRMultipleTargets, blendTargets,
  scaleTargets, snapToStructure, applyStructureSnap, classifyTrendStrength, applyTrendAdjustment,
  applyVolumeModifier, deriveVolatilityRegime, buildReversalConditions,
} = require('../../src/services/risk/adaptive-take-profit-engine');
const { DEFAULT_CONFIG, mergeConfig } = require('../../src/services/risk/adaptive-take-profit-config');

const CONFIG = mergeConfig();

function adx(value, status = 'ok') { return { value, status }; }
function structure(value, status = 'ok') { return { value, status }; }
function volume(value, status = 'ok') { return { value, status }; }

// ---------- normalizeSide ----------

test('normalizeSide maps buy->long and sell->short, plus long/short verbatim', () => {
  assert.equal(normalizeSide('buy'), 'long');
  assert.equal(normalizeSide('BUY'), 'long');
  assert.equal(normalizeSide('long'), 'long');
  assert.equal(normalizeSide('sell'), 'short');
  assert.equal(normalizeSide('short'), 'short');
  assert.equal(normalizeSide('sideways'), null);
  assert.equal(normalizeSide(undefined), null);
});

// ---------- computeAtrTargets ----------

test('computeAtrTargets: LONG targets are entry + ATR*multiplier, strictly increasing', () => {
  const t = computeAtrTargets(100, 'long', 10, CONFIG);
  assert.equal(t.TP1, 100 + 10 * CONFIG.tp1AtrMultiplier);
  assert.equal(t.TP2, 100 + 10 * CONFIG.tp2AtrMultiplier);
  assert.equal(t.TP3, 100 + 10 * CONFIG.tp3AtrMultiplier);
  assert.ok(t.TP1 < t.TP2 && t.TP2 < t.TP3);
});

test('computeAtrTargets: SHORT targets are entry - ATR*multiplier, strictly decreasing (mirror of long)', () => {
  const t = computeAtrTargets(100, 'short', 10, CONFIG);
  assert.equal(t.TP1, 100 - 10 * CONFIG.tp1AtrMultiplier);
  assert.equal(t.TP2, 100 - 10 * CONFIG.tp2AtrMultiplier);
  assert.equal(t.TP3, 100 - 10 * CONFIG.tp3AtrMultiplier);
  assert.ok(t.TP1 > t.TP2 && t.TP2 > t.TP3);
});

test('computeAtrTargets: ATR = 0 or null returns null (never divides/multiplies into a degenerate target)', () => {
  assert.equal(computeAtrTargets(100, 'long', 0, CONFIG), null);
  assert.equal(computeAtrTargets(100, 'long', null, CONFIG), null);
  assert.equal(computeAtrTargets(100, 'long', -5, CONFIG), null);
});

// ---------- computeRMultipleTargets ----------

test('computeRMultipleTargets: LONG targets are entry + R*multiple where R = |entry-stopLoss|', () => {
  const t = computeRMultipleTargets(100, 'long', 90, CONFIG); // R = 10
  assert.equal(t.TP1, 100 + 10 * CONFIG.tp1RMultiple);
  assert.equal(t.TP2, 100 + 10 * CONFIG.tp2RMultiple);
  assert.equal(t.TP3, 100 + 10 * CONFIG.tp3RMultiple);
});

test('computeRMultipleTargets: SHORT mirrors long', () => {
  const t = computeRMultipleTargets(100, 'short', 110, CONFIG); // R = 10
  assert.equal(t.TP1, 100 - 10 * CONFIG.tp1RMultiple);
  assert.equal(t.TP2, 100 - 10 * CONFIG.tp2RMultiple);
  assert.equal(t.TP3, 100 - 10 * CONFIG.tp3RMultiple);
});

test('computeRMultipleTargets: missing or entry-equal stopLoss (R=0) returns null', () => {
  assert.equal(computeRMultipleTargets(100, 'long', null, CONFIG), null);
  assert.equal(computeRMultipleTargets(100, 'long', 100, CONFIG), null);
});

// ---------- blendTargets ----------

test('blendTargets averages two target sets, and passes through unchanged if one side is null', () => {
  const a = { TP1: 10, TP2: 20, TP3: 30 };
  const b = { TP1: 20, TP2: 40, TP3: 60 };
  assert.deepEqual(blendTargets(a, b), { TP1: 15, TP2: 30, TP3: 45 });
  assert.deepEqual(blendTargets(null, b), b);
  assert.deepEqual(blendTargets(a, null), a);
  assert.equal(blendTargets(null, null), null);
});

// ---------- scaleTargets ----------

test('scaleTargets widens/tightens distance-from-entry symmetrically for long and short', () => {
  const longTargets = { TP1: 110, TP2: 120, TP3: 130 };
  const widened = scaleTargets(longTargets, 100, 2);
  assert.deepEqual(widened, { TP1: 120, TP2: 140, TP3: 160 });

  const shortTargets = { TP1: 90, TP2: 80, TP3: 70 };
  const tightened = scaleTargets(shortTargets, 100, 0.5);
  assert.deepEqual(tightened, { TP1: 95, TP2: 90, TP3: 85 });
});

// ---------- snapToStructure ----------

test('snapToStructure (long): a TP already within the buffer of resistance snaps to (resistance - buffer)', () => {
  const result = snapToStructure(119.99, 'long', 120, 0.5); // buffer = 0.6 (0.5% of 120)
  assert.equal(result.snapped, true);
  assert.equal(result.price, 120 - 120 * 0.005);
});

test('snapToStructure (long): a TP overshooting past resistance also gets pulled back to (resistance - buffer)', () => {
  const result = snapToStructure(150, 'long', 120, 0.5);
  assert.equal(result.snapped, true);
  assert.equal(result.price, 120 - 120 * 0.005);
});

test('snapToStructure (long): a TP comfortably clear of resistance is left unchanged', () => {
  const result = snapToStructure(100, 'long', 120, 0.5);
  assert.equal(result.snapped, false);
  assert.equal(result.price, 100);
});

test('snapToStructure (short) mirrors long against support', () => {
  const nearSupport = snapToStructure(80.01, 'short', 80, 0.5);
  assert.equal(nearSupport.snapped, true);
  assert.equal(nearSupport.price, 80 + 80 * 0.005);

  const clear = snapToStructure(100, 'short', 80, 0.5);
  assert.equal(clear.snapped, false);
});

test('snapToStructure: missing level or tp is a no-op', () => {
  assert.deepEqual(snapToStructure(100, 'long', null, 0.5), { price: 100, snapped: false });
  assert.deepEqual(snapToStructure(null, 'long', 120, 0.5), { price: null, snapped: false });
});

// ---------- applyStructureSnap ----------

test('applyStructureSnap: skips entirely when market structure status is not "ok"', () => {
  const targets = { TP1: 119.99, TP2: 125, TP3: 130 };
  const { targets: result, snappedTiers } = applyStructureSnap(targets, 'long', structure(null, 'insufficient_history'), CONFIG);
  assert.deepEqual(result, targets);
  assert.deepEqual(snappedTiers, []);
});

test('applyStructureSnap: reports which tiers were snapped', () => {
  const targets = { TP1: 105, TP2: 119.99, TP3: 150 };
  const { snappedTiers } = applyStructureSnap(targets, 'long', structure({ nearestResistance: 120, nearestSupport: 90, resistanceLevels: [120], supportLevels: [90] }), CONFIG);
  assert.deepEqual(snappedTiers, ['TP2', 'TP3']);
});

// ---------- classifyTrendStrength ----------

test('classifyTrendStrength: strong ADX with agreeing DI is "strong" for a long', () => {
  const result = classifyTrendStrength(adx({ adx: 30, pdi: 25, mdi: 10 }), 'long', CONFIG);
  assert.equal(result.strong, true);
  assert.equal(result.agrees, true);
});

test('classifyTrendStrength: strong ADX with disagreeing DI is not "strong" for a long (counter-trend)', () => {
  const result = classifyTrendStrength(adx({ adx: 30, pdi: 10, mdi: 25 }), 'long', CONFIG);
  assert.equal(result.strong, false);
  assert.equal(result.agrees, false);
});

test('classifyTrendStrength: weak ADX (<=25) is never "strong" regardless of DI', () => {
  const result = classifyTrendStrength(adx({ adx: 15, pdi: 25, mdi: 10 }), 'long', CONFIG);
  assert.equal(result.strong, false);
});

test('classifyTrendStrength: short side requires mdi > pdi to agree', () => {
  const agrees = classifyTrendStrength(adx({ adx: 30, pdi: 10, mdi: 25 }), 'short', CONFIG);
  assert.equal(agrees.strong, true);
  const disagrees = classifyTrendStrength(adx({ adx: 30, pdi: 25, mdi: 10 }), 'short', CONFIG);
  assert.equal(disagrees.strong, false);
});

test('classifyTrendStrength: missing/degraded ADX is treated as neutral (never strong)', () => {
  assert.equal(classifyTrendStrength(adx(null, 'insufficient_history'), 'long', CONFIG).strong, false);
  assert.equal(classifyTrendStrength(undefined, 'long', CONFIG).strong, false);
});

// ---------- applyTrendAdjustment ----------

test('applyTrendAdjustment: widens targets in a strong agreeing trend', () => {
  const targets = { TP1: 110, TP2: 120, TP3: 130 };
  const { targets: result } = applyTrendAdjustment(targets, 100, 'long', adx({ adx: 30, pdi: 25, mdi: 10 }), CONFIG);
  assert.equal(result.TP1, 100 + (110 - 100) * CONFIG.trendWideningFactor);
});

test('applyTrendAdjustment: tightens targets in a weak/absent trend', () => {
  const targets = { TP1: 110, TP2: 120, TP3: 130 };
  const { targets: result } = applyTrendAdjustment(targets, 100, 'long', adx({ adx: 10, pdi: 25, mdi: 10 }), CONFIG);
  assert.equal(result.TP1, 100 + (110 - 100) * CONFIG.trendTighteningFactor);
});

test('applyTrendAdjustment: null targets pass through as null', () => {
  const { targets: result, trendInfo } = applyTrendAdjustment(null, 100, 'long', adx({ adx: 30, pdi: 25, mdi: 10 }), CONFIG);
  assert.equal(result, null);
  assert.equal(trendInfo, null);
});

// ---------- applyVolumeModifier ----------

test('applyVolumeModifier: never returns a target/price field, only confidence/reason (volume is never a sole gate)', () => {
  const result = applyVolumeModifier(volume({ currentVolume: 100, volumeSma: 50, relativeVolume: 2 }), { strong: true }, CONFIG);
  assert.ok(!('TP1' in result) && !('targets' in result));
  assert.equal(result.confidenceDelta, 0.15);
});

test('applyVolumeModifier: weak volume + weak trend lowers confidence', () => {
  const result = applyVolumeModifier(volume({ currentVolume: 10, volumeSma: 50, relativeVolume: 0.2 }), { strong: false }, CONFIG);
  assert.equal(result.confidenceDelta, -0.1);
});

test('applyVolumeModifier: missing volume data is a no-op', () => {
  const result = applyVolumeModifier(volume(null, 'insufficient_history'), { strong: true }, CONFIG);
  assert.equal(result.confidenceDelta, 0);
});

// ---------- deriveVolatilityRegime ----------

test('deriveVolatilityRegime classifies low/normal/high against configured thresholds', () => {
  assert.equal(deriveVolatilityRegime(0.5, CONFIG), 'low');
  assert.equal(deriveVolatilityRegime(2, CONFIG), 'normal');
  assert.equal(deriveVolatilityRegime(5, CONFIG), 'high');
  assert.equal(deriveVolatilityRegime(null, CONFIG), 'unknown');
});

// ---------- buildReversalConditions ----------

test('buildReversalConditions: returns empty when reversalExitEnabled is false', () => {
  const conditions = buildReversalConditions('long', structure({ nearestSupport: 90 }), mergeConfig({ reversalExitEnabled: false }));
  assert.deepEqual(conditions, []);
});

test('buildReversalConditions: includes a structure_break condition referencing nearestSupport for a long', () => {
  const conditions = buildReversalConditions('long', structure({ nearestResistance: 120, nearestSupport: 90 }), CONFIG);
  const structureBreak = conditions.find((c) => c.type === 'structure_break');
  assert.ok(structureBreak);
  assert.equal(structureBreak.level, 90);
});

// ---------- computeAdaptiveTargets (integration of all the above) ----------

const BASE_INPUT = {
  entryPrice: 100,
  currentPrice: 101,
  side: 'long',
  atr: 5,
  atrPercent: 2,
  stopLoss: 95,
  currentRMultiple: 0.2,
  trendStrength: adx({ adx: 30, pdi: 25, mdi: 10 }),
  marketStructure: structure({ nearestResistance: 130, nearestSupport: 92, resistanceLevels: [130], supportLevels: [92] }),
  volumeCondition: volume({ currentVolume: 100, volumeSma: 50, relativeVolume: 2 }),
};

test('computeAdaptiveTargets: LONG happy path returns strictly increasing TP1<TP2<TP3 above entry', () => {
  const result = computeAdaptiveTargets(BASE_INPUT);
  assert.ok(result.TP1 > BASE_INPUT.entryPrice);
  assert.ok(result.TP1 < result.TP2);
  assert.ok(result.TP2 < result.TP3);
  assert.deepEqual(result.warnings, []);
});

test('computeAdaptiveTargets: SHORT happy path mirrors long — TP1>TP2>TP3 below entry', () => {
  const result = computeAdaptiveTargets({
    ...BASE_INPUT, side: 'short', stopLoss: 105,
    marketStructure: structure({ nearestResistance: 108, nearestSupport: 70, resistanceLevels: [108], supportLevels: [70] }),
  });
  assert.ok(result.TP1 < BASE_INPUT.entryPrice);
  assert.ok(result.TP1 > result.TP2);
  assert.ok(result.TP2 > result.TP3);
});

test('computeAdaptiveTargets: partialExitPercentages always sum to 100', () => {
  const result = computeAdaptiveTargets(BASE_INPUT);
  const { tp1, tp2, tp3 } = result.partialExitPercentages;
  assert.equal(tp1 + tp2 + tp3, 100);
});

test('computeAdaptiveTargets: ATR unavailable falls back to R-multiple targets with a warning, never throws', () => {
  const result = computeAdaptiveTargets({ ...BASE_INPUT, atr: null });
  assert.ok(result.TP1 !== null);
  assert.ok(result.warnings.some((w) => w.includes('ATR unavailable')));
});

test('computeAdaptiveTargets: both ATR and stopLoss unavailable fails safely (null targets, explicit warning, no throw)', () => {
  const result = computeAdaptiveTargets({ ...BASE_INPUT, atr: null, stopLoss: null });
  assert.equal(result.TP1, null);
  assert.equal(result.TP2, null);
  assert.equal(result.TP3, null);
  assert.ok(result.warnings.length > 0);
});

test('computeAdaptiveTargets: missing market structure does not throw and simply skips snapping', () => {
  const result = computeAdaptiveTargets({ ...BASE_INPUT, marketStructure: structure(null, 'insufficient_history') });
  assert.ok(result.TP1 !== null);
});

test('computeAdaptiveTargets: missing volume data does not throw and does not affect targets', () => {
  const withVolume = computeAdaptiveTargets(BASE_INPUT);
  const withoutVolume = computeAdaptiveTargets({ ...BASE_INPUT, volumeCondition: volume(null, 'insufficient_history') });
  assert.equal(withVolume.TP1, withoutVolume.TP1);
});

test('computeAdaptiveTargets: an unrecognized side fails safely with null targets and a warning instead of throwing', () => {
  const result = computeAdaptiveTargets({ ...BASE_INPUT, side: 'sideways' });
  assert.equal(result.TP1, null);
  assert.ok(result.warnings.length > 0);
});

test('computeAdaptiveTargets: a strong agreeing trend produces wider targets than a weak one, all else equal', () => {
  const strong = computeAdaptiveTargets({ ...BASE_INPUT, trendStrength: adx({ adx: 35, pdi: 30, mdi: 10 }) });
  const weak = computeAdaptiveTargets({ ...BASE_INPUT, trendStrength: adx({ adx: 10, pdi: 30, mdi: 10 }) });
  assert.ok(strong.TP1 - BASE_INPUT.entryPrice > weak.TP1 - BASE_INPUT.entryPrice);
});

test('computeAdaptiveTargets: tiny R distance (stop very close to entry) still produces valid, non-NaN targets', () => {
  const result = computeAdaptiveTargets({ ...BASE_INPUT, stopLoss: 99.999, config: { targetMode: 'r_multiple' } });
  assert.ok(Number.isFinite(result.TP1));
});

test('computeAdaptiveTargets: config overrides propagate (e.g. a custom targetMode changes the result)', () => {
  // ATR distance (5) and R distance (|100-95|=5) are equal in BASE_INPUT, so use a wider stop
  // here specifically so the two modes diverge and this test actually exercises targetMode.
  const input = { ...BASE_INPUT, stopLoss: 80 }; // R = 20, vs. ATR = 5
  const atrOnly = computeAdaptiveTargets({ ...input, config: { targetMode: 'atr' } });
  const rOnly = computeAdaptiveTargets({ ...input, config: { targetMode: 'r_multiple' } });
  assert.notEqual(atrOnly.TP1, rOnly.TP1);
});

test('computeAdaptiveTargets: same input always produces the same output (deterministic, no hidden state/randomness)', () => {
  const first = computeAdaptiveTargets(BASE_INPUT);
  const second = computeAdaptiveTargets(BASE_INPUT);
  assert.deepEqual(first, second);
});

test('computeAdaptiveTargets: confidence is always clamped to [0, 1]', () => {
  const result = computeAdaptiveTargets(BASE_INPUT);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
});

// ---------- Regression: a stale market-structure level from before entry must never invert a target ----------
// Caught via the LSR backtest integration test: marketStructure is computed as of the SIGNAL/setup
// decision, which can be several bars before the actual fill. If price already moved past a
// "resistance" level by fill time, that level is behind the position, not an obstacle ahead of it —
// snapping against it pulled every TP tier below entry on a long, turning "take profit" into a loss.

test('computeAdaptiveTargets (regression): a resistance level BELOW entry (already passed, stale) never pulls a long\'s targets below entry', () => {
  const result = computeAdaptiveTargets({
    ...BASE_INPUT,
    entryPrice: 110,
    marketStructure: structure({ nearestResistance: 100, nearestSupport: 92, resistanceLevels: [100], supportLevels: [92] }), // resistance < entry
  });
  assert.ok(result.TP1 > 110, `TP1 (${result.TP1}) must be above entry (110)`);
  assert.ok(result.TP2 > result.TP1);
  assert.ok(result.TP3 > result.TP2);
});

test('computeAdaptiveTargets (regression): a support level ABOVE entry (already passed, stale) never pulls a short\'s targets above entry', () => {
  const result = computeAdaptiveTargets({
    ...BASE_INPUT,
    side: 'short',
    entryPrice: 90,
    stopLoss: 95,
    marketStructure: structure({ nearestResistance: 108, nearestSupport: 100, resistanceLevels: [108], supportLevels: [100] }), // support > entry
  });
  assert.ok(result.TP1 < 90, `TP1 (${result.TP1}) must be below entry (90)`);
  assert.ok(result.TP2 < result.TP1);
  assert.ok(result.TP3 < result.TP2);
});
