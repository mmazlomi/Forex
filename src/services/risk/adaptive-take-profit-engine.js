'use strict';

// AdaptiveTakeProfitEngine — pure, deterministic TP1/TP2/TP3 + trailing-multiplier + partial-exit
// selection, replacing the fixed `entry +/- ATR*2` / `entry +/- R*ratio` math used today
// (scoring-engine.js, reversal-strategy/take-profit.js). No network/DB access, no randomness —
// same inputs always produce the same outputs, so this is fully unit-testable and safe to call
// from both live schedulers and backtest loops without divergence between the two.
//
// Every indicator input is taken VERBATIM in its producing module's own {value, status} shape
// (adx.js, support-resistance.js, volume-analysis.js) — no reshaping at the call site. A
// `status !== 'ok'` (or a missing input entirely) degrades gracefully rather than throwing: ATR
// unavailable falls back to R-multiple targets, missing ADX is treated as neutral trend, missing
// S/R skips structure snapping, missing volume skips the confidence modifier. Nothing here ever
// executes an order or a close — evaluateReversalConditions() only describes what WOULD trigger
// one; position-risk-watcher.js is what actually acts on live price against these outputs.

const { mergeConfig } = require('./adaptive-take-profit-config');

function normalizeSide(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'long' || s === 'buy') return 'long';
  if (s === 'short' || s === 'sell') return 'short';
  return null;
}

/** entry +/- atr*multiplier per tier, signed by side. Null if ATR isn't usable. */
function computeAtrTargets(entryPrice, side, atrValue, config) {
  if (typeof atrValue !== 'number' || !(atrValue > 0)) return null;
  const sign = side === 'long' ? 1 : -1;
  return {
    TP1: entryPrice + sign * atrValue * config.tp1AtrMultiplier,
    TP2: entryPrice + sign * atrValue * config.tp2AtrMultiplier,
    TP3: entryPrice + sign * atrValue * config.tp3AtrMultiplier,
  };
}

/** entry +/- |entry-stopLoss|*multiple per tier, signed by side. Null if stopLoss isn't usable
 *  (missing, or equal to entry — R would be zero). */
function computeRMultipleTargets(entryPrice, side, stopLoss, config) {
  if (typeof stopLoss !== 'number') return null;
  const r = Math.abs(entryPrice - stopLoss);
  if (!(r > 0)) return null;
  const sign = side === 'long' ? 1 : -1;
  return {
    TP1: entryPrice + sign * r * config.tp1RMultiple,
    TP2: entryPrice + sign * r * config.tp2RMultiple,
    TP3: entryPrice + sign * r * config.tp3RMultiple,
  };
}

function blendTargets(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { TP1: (a.TP1 + b.TP1) / 2, TP2: (a.TP2 + b.TP2) / 2, TP3: (a.TP3 + b.TP3) / 2 };
}

/** Scales each tier's distance-from-entry by `factor`, preserving side/sign — used to widen
 *  targets in a strong agreeing trend or tighten them when the trend is weak/absent. */
function scaleTargets(targets, entryPrice, factor) {
  if (!targets) return null;
  const scaled = {};
  for (const key of ['TP1', 'TP2', 'TP3']) {
    scaled[key] = entryPrice + (targets[key] - entryPrice) * factor;
  }
  return scaled;
}

/**
 * If a tier's target already sits within `bufferPercent` of (or beyond) a market-structure level
 * that's in its path, pull it back to just inside that level instead of leaving it to overshoot
 * or sit awkwardly short — see the module doc comment and STRATEGY_SPEC-style reasoning: a TP
 * placed just short of strong resistance is likely to never fill because price reverses at the
 * wall first; snapping it to (level - buffer) makes it far more likely to actually fill.
 * Returns { price, snapped: boolean }.
 */
function snapToStructure(tp, side, nearestLevel, bufferPercent, entryPrice) {
  if (typeof tp !== 'number' || typeof nearestLevel !== 'number') return { price: tp, snapped: false };
  // A level on the WRONG side of entry (resistance at/below entry for a long, support at/above
  // entry for a short) is already behind the position, not an obstacle ahead of it — this matters
  // because marketStructure is computed from the window as of entry DECISION time, which can be
  // several bars before the actual fill; price may have already cleared the level by fill time.
  // Snapping against a stale, already-passed level was a real bug caught by the LSR integration
  // test: it pulled every TP tier below entry on a long, turning "take profit" into a loss.
  if (side === 'long' && typeof entryPrice === 'number' && nearestLevel <= entryPrice) return { price: tp, snapped: false };
  if (side === 'short' && typeof entryPrice === 'number' && nearestLevel >= entryPrice) return { price: tp, snapped: false };

  const bufferAbs = nearestLevel * (bufferPercent / 100);
  if (side === 'long') {
    const cappedPrice = nearestLevel - bufferAbs;
    if (tp >= cappedPrice) return { price: cappedPrice, snapped: true };
  } else {
    const cappedPrice = nearestLevel + bufferAbs;
    if (tp <= cappedPrice) return { price: cappedPrice, snapped: true };
  }
  return { price: tp, snapped: false };
}

function applyStructureSnap(targets, side, marketStructure, config, entryPrice) {
  if (!targets) return { targets, snappedTiers: [] };
  const level = side === 'long' ? marketStructure?.value?.nearestResistance : marketStructure?.value?.nearestSupport;
  if (marketStructure?.status !== 'ok' || typeof level !== 'number') return { targets, snappedTiers: [] };

  const snappedTiers = [];
  const result = {};
  for (const key of ['TP1', 'TP2', 'TP3']) {
    const { price, snapped } = snapToStructure(targets[key], side, level, config.supportResistanceBufferPercent, entryPrice);
    result[key] = price;
    if (snapped) snappedTiers.push(key);
  }
  return { targets: result, snappedTiers };
}

/** ADX>threshold + DI-direction-agrees-with-side = strong agreeing trend (widen); anything else
 *  (weak ADX, or DI disagrees with side) = tighten. Reuses technical-scorer.js#scoreAdx's exact
 *  ADX>25-default convention rather than inventing a new one. Missing/degraded ADX is treated as
 *  neutral — tighten, the conservative default — never widens on absent data. */
function classifyTrendStrength(trendStrength, side, config) {
  if (trendStrength?.status !== 'ok' || !trendStrength.value) {
    return { strong: false, agrees: false, reason: 'Trend strength unavailable — treated as neutral (tightened).' };
  }
  const { adx, pdi, mdi } = trendStrength.value;
  const trending = adx > config.trendStrengthAdxThreshold;
  const bullish = pdi > mdi;
  const agrees = side === 'long' ? bullish : !bullish;
  return {
    strong: trending && agrees,
    agrees,
    reason: trending
      ? (agrees ? `ADX ${adx.toFixed(1)} > ${config.trendStrengthAdxThreshold}, trend agrees with ${side} — widened.` : `ADX ${adx.toFixed(1)} > ${config.trendStrengthAdxThreshold} but trend opposes ${side} — tightened.`)
      : `ADX ${adx.toFixed(1)} <= ${config.trendStrengthAdxThreshold} (no clear trend) — tightened.`,
  };
}

function applyTrendAdjustment(targets, entryPrice, side, trendStrength, config) {
  if (!targets) return { targets, trendInfo: null };
  const trendInfo = classifyTrendStrength(trendStrength, side, config);
  const factor = trendInfo.strong ? config.trendWideningFactor : config.trendTighteningFactor;
  return { targets: scaleTargets(targets, entryPrice, factor), trendInfo };
}

/** Volume is a confidence/reason modifier ONLY — per spec it must never gate, veto, or resize a
 *  target on its own. Returns a confidence delta and a reason string; never touches `targets`. */
function applyVolumeModifier(volumeCondition, trendInfo, config) {
  if (volumeCondition?.status !== 'ok' || typeof volumeCondition.value?.relativeVolume !== 'number') {
    return { confidenceDelta: 0, reason: null };
  }
  const { relativeVolume } = volumeCondition.value;
  const strongVolume = relativeVolume >= config.volumeConfirmationRelativeVolumeThreshold;
  if (strongVolume && trendInfo?.strong) {
    return { confidenceDelta: 0.15, reason: `Relative volume ${relativeVolume.toFixed(2)}x confirms the strong trend — targets left widened.` };
  }
  if (!strongVolume && !trendInfo?.strong) {
    return { confidenceDelta: -0.1, reason: `Relative volume ${relativeVolume.toFixed(2)}x is weak alongside a weak trend — consider earlier profit-taking.` };
  }
  return { confidenceDelta: 0, reason: null };
}

function deriveVolatilityRegime(atrPercent, config) {
  if (typeof atrPercent !== 'number') return 'unknown';
  const { low, high } = config.volatilityRegimeAtrPercentThreshold;
  if (atrPercent < low) return 'low';
  if (atrPercent > high) return 'high';
  return 'normal';
}

/** Structural early-exit conditions this setup would invalidate on — descriptive only, matching
 *  the module doc comment: nothing here evaluates live data or closes a position. Stage E
 *  (position-risk-watcher.js) is what checks these against fresh candles/indicators. */
function buildReversalConditions(side, marketStructure, config, entryPrice, atr) {
  if (!config.reversalExitEnabled) return [];
  const conditions = [
    { type: 'reversal_signal', description: `Strong ${side === 'long' ? 'bearish' : 'bullish'} reversal signal against the position.` },
  ];
  let structureLevel = side === 'long' ? marketStructure?.value?.nearestSupport : marketStructure?.value?.nearestResistance;

  // Calculate minimum noise buffer distance from entry price:
  // Must be at least 0.5 * ATR (or 0.3% of entry price if ATR is not available) to prevent
  // instant premature exits on normal bid/ask spread and sub-minute candle noise.
  let minBuffer = 0;
  if (typeof entryPrice === 'number' && entryPrice > 0) {
    if (typeof atr === 'number' && atr > 0) {
      minBuffer = Math.max(atr * 0.5, entryPrice * 0.003);
    } else {
      minBuffer = entryPrice * 0.003;
    }
  }

  // A structural break level MUST make sense relative to the entry price:
  // - For a LONG, the support level must be BELOW entry price by at least minBuffer (structureLevel <= entryPrice - minBuffer).
  // - For a SHORT, the resistance level must be ABOVE entry price by at least minBuffer (structureLevel >= entryPrice + minBuffer).
  // If the initial level was already breached or is within the noise buffer, attempt to find a valid
  // level from supportLevels / resistanceLevels. If none exists, do not attach an invalid structure_break.
  const isValidLevel = (lvl) => {
    if (typeof lvl !== 'number' || !Number.isFinite(lvl)) return false;
    if (typeof entryPrice !== 'number') return true;
    return side === 'long' ? lvl <= entryPrice - minBuffer : lvl >= entryPrice + minBuffer;
  };

  if (!isValidLevel(structureLevel)) {
    const candidates = side === 'long'
      ? (marketStructure?.value?.supportLevels || []).filter(isValidLevel).sort((a, b) => b - a)
      : (marketStructure?.value?.resistanceLevels || []).filter(isValidLevel).sort((a, b) => a - b);
    structureLevel = candidates[0] ?? null;
  }

  if (marketStructure?.status === 'ok' && typeof structureLevel === 'number') {
    conditions.push({
      type: 'structure_break',
      description: side === 'long'
        ? `Loss of key support at ${structureLevel} (bearish structure shift).`
        : `Breakout above key resistance at ${structureLevel} (bullish structure shift).`,
      level: structureLevel,
    });
  }
  return conditions;
}

/**
 * @param {object} input
 * @param {number} input.entryPrice
 * @param {number} [input.currentPrice]
 * @param {'long'|'short'|'buy'|'sell'} input.side
 * @param {number|null} input.atr - raw ATR value (price units), e.g. atr.js#compute's `.value`
 * @param {number|null} [input.atrPercent] - ATR as a percent of price, for volatility-regime classification
 * @param {number|null} input.stopLoss
 * @param {number|null} [input.currentRMultiple]
 * @param {{value:{adx,pdi,mdi}|null,status:string}} [input.trendStrength] - adx.js#compute's return shape, verbatim
 * @param {{value:{nearestResistance,nearestSupport,resistanceLevels,supportLevels}|null,status:string}} [input.marketStructure] - support-resistance.js#compute's return shape, verbatim
 * @param {{value:{currentVolume,volumeSma,relativeVolume}|null,status:string}} [input.volumeCondition] - volume-analysis.js#compute's return shape, verbatim
 * @param {object} [input.config] - partial override merged onto adaptive-take-profit-config.js's DEFAULT_CONFIG
 * @returns {{TP1:number|null,TP2:number|null,TP3:number|null,partialExitPercentages:object,recommendedTrailingMultiplier:number,exitReversalConditions:Array,confidence:number,reason:string[],warnings:string[]}}
 */
function computeAdaptiveTargets(input) {
  const config = mergeConfig(input.config);
  const warnings = [];
  const reason = [];

  const side = normalizeSide(input.side);
  if (!side) {
    return {
      TP1: null, TP2: null, TP3: null,
      partialExitPercentages: { tp1: 0, tp2: 0, tp3: 0 },
      recommendedTrailingMultiplier: config.trailingAtrMultiplier,
      exitReversalConditions: [],
      confidence: 0,
      reason: [],
      warnings: [`Unrecognized side "${input.side}" — no targets computed.`],
    };
  }

  const entryPrice = input.entryPrice;
  const atrTargets = computeAtrTargets(entryPrice, side, input.atr, config);
  const rTargets = computeRMultipleTargets(entryPrice, side, input.stopLoss, config);

  if (!atrTargets && config.targetMode !== 'r_multiple') {
    warnings.push('ATR unavailable — fell back to R-multiple targets only.');
  }
  if (!rTargets && config.targetMode !== 'atr') {
    warnings.push('stopLoss unavailable or equal to entry (R=0) — fell back to ATR targets only.');
  }

  let baseTargets;
  if (config.targetMode === 'atr') baseTargets = atrTargets || rTargets;
  else if (config.targetMode === 'r_multiple') baseTargets = rTargets || atrTargets;
  else baseTargets = blendTargets(atrTargets, rTargets);

  if (!baseTargets) {
    warnings.push('Neither ATR nor a valid stop-loss was available — no targets could be computed.');
    return {
      TP1: null, TP2: null, TP3: null,
      partialExitPercentages: { tp1: 0, tp2: 0, tp3: 0 },
      recommendedTrailingMultiplier: config.trailingAtrMultiplier,
      exitReversalConditions: buildReversalConditions(side, input.marketStructure, config, entryPrice, input.atr),
      confidence: 0, reason, warnings,
    };
  }

  const { targets: trendAdjusted, trendInfo } = applyTrendAdjustment(baseTargets, entryPrice, side, input.trendStrength, config);
  if (trendInfo) reason.push(trendInfo.reason);

  const { targets: snappedTargets, snappedTiers } = applyStructureSnap(trendAdjusted, side, input.marketStructure, config, entryPrice);
  if (snappedTiers.length > 0) {
    reason.push(`${snappedTiers.join(', ')} snapped to market structure (within ${config.supportResistanceBufferPercent}% buffer).`);
  }

  // Defense-in-depth: no adjustment above should ever be able to push a target to the wrong side
  // of entry or out of TP1<TP2<TP3 order, but if one somehow does (e.g. a future bug in the
  // structure snap, or a pathological config), fail safe by reverting to the pre-snap
  // trend-adjusted target for that tier rather than silently handing out an inverted "take profit"
  // that would realize a loss. This exact class of bug (a stale, already-passed structure level
  // pulling every tier below entry on a long) was caught by the LSR backtest integration test.
  const finalTargets = {};
  const rejectedTiers = [];
  for (const key of ['TP1', 'TP2', 'TP3']) {
    const candidate = snappedTargets[key];
    const wrongSide = side === 'long' ? candidate <= entryPrice : candidate >= entryPrice;
    if (wrongSide) {
      finalTargets[key] = trendAdjusted[key];
      rejectedTiers.push(key);
    } else {
      finalTargets[key] = candidate;
    }
  }
  if (rejectedTiers.length > 0) {
    warnings.push(`${rejectedTiers.join(', ')} landed on the wrong side of entry after structure snapping — reverted to the pre-snap target.`);
  }

  const volumeModifier = applyVolumeModifier(input.volumeCondition, trendInfo, config);
  if (volumeModifier.reason) reason.push(volumeModifier.reason);

  const volatilityRegime = deriveVolatilityRegime(input.atrPercent, config);
  reason.push(`Volatility regime: ${volatilityRegime}.`);

  const baseConfidence = trendInfo?.strong ? 0.7 : 0.5;
  const confidence = Math.max(0, Math.min(1, baseConfidence + volumeModifier.confidenceDelta));

  const recommendedTrailingMultiplier = trendInfo?.strong
    ? config.trailingAtrMultiplier * config.trendWideningFactor
    : config.trailingAtrMultiplier;

  return {
    TP1: finalTargets.TP1,
    TP2: finalTargets.TP2,
    TP3: finalTargets.TP3,
    partialExitPercentages: { tp1: config.tp1ClosePercent, tp2: config.tp2ClosePercent, tp3: config.tp3RemainingPercent },
    recommendedTrailingMultiplier,
    exitReversalConditions: buildReversalConditions(side, input.marketStructure, config, entryPrice, input.atr),
    confidence,
    reason,
    warnings,
  };
}

/**
 * Detects whether the latest candle represents an abnormal price spike in the direction of the trade.
 * A candle spike occurs when:
 * 1. Candle range (high - low) >= spikeAtrMultiplier * ATR
 * 2. Close is in trade direction (close > open for long, close < open for short)
 * 3. Body is substantial (body / range >= 0.5 to exclude long rejection wicks / dojis)
 * 4. Relative volume confirms the spike (if relativeVolume is provided)
 */
function detectCandleSpike({ latestCandle, atr, side, relativeVolume, config }) {
  const cfg = config || mergeConfig();
  if (!cfg.spikeExitEnabled) return { isSpike: false, reason: null, spikeRange: 0, multiplier: 0, suggestedStop: null };
  if (!latestCandle || typeof atr !== 'number' || atr <= 0) {
    return { isSpike: false, reason: null, spikeRange: 0, multiplier: 0, suggestedStop: null };
  }

  const normSide = normalizeSide(side);
  if (!normSide) return { isSpike: false, reason: null, spikeRange: 0, multiplier: 0, suggestedStop: null };

  const { open, high, low, close } = latestCandle;
  if (typeof open !== 'number' || typeof high !== 'number' || typeof low !== 'number' || typeof close !== 'number') {
    return { isSpike: false, reason: null, spikeRange: 0, multiplier: 0, suggestedStop: null };
  }

  const range = high - low;
  const body = Math.abs(close - open);
  const minRange = atr * (cfg.spikeAtrMultiplier || 2.5);

  if (range < minRange) {
    return { isSpike: false, reason: null, spikeRange: range, multiplier: Number((range / atr).toFixed(2)), suggestedStop: null };
  }

  const isFavorable = normSide === 'long' ? close > open : close < open;
  if (!isFavorable) {
    return { isSpike: false, reason: null, spikeRange: range, multiplier: Number((range / atr).toFixed(2)), suggestedStop: null };
  }

  if (range > 0 && body / range < 0.5) {
    return { isSpike: false, reason: null, spikeRange: range, multiplier: Number((range / atr).toFixed(2)), suggestedStop: null };
  }

  if (typeof relativeVolume === 'number' && cfg.spikeVolumeMultiplier > 0) {
    if (relativeVolume < cfg.spikeVolumeMultiplier) {
      return { isSpike: false, reason: null, spikeRange: range, multiplier: Number((range / atr).toFixed(2)), suggestedStop: null };
    }
  }

  const mult = Number((range / atr).toFixed(2));
  // Suggested stop locks in the lower half of the spike body (50% pullback level)
  const suggestedStop = normSide === 'long'
    ? close - (close - open) * 0.5
    : close + (open - close) * 0.5;

  const reason = `Candle spike detected: range ${range.toFixed(4)} is ${mult}x ATR (>= ${cfg.spikeAtrMultiplier}x)${typeof relativeVolume === 'number' ? ` with ${relativeVolume.toFixed(2)}x volume` : ''}. Suggested tightened stop: ${suggestedStop.toFixed(4)}.`;

  return {
    isSpike: true,
    reason,
    spikeRange: range,
    multiplier: mult,
    suggestedStop,
  };
}

/**
 * Detects whether technical momentum is exhausted in the trade direction (extreme RSI overbought/oversold
 * while the position is in profit), signaling an imminent pullback or trend exhaustion.
 */
function detectMomentumExhaustion({ indicators, side, unrealizedPnl, currentPrice, atr, config }) {
  const cfg = config || mergeConfig();
  if (!cfg.momentumExhaustionEnabled) return { isExhausted: false, reason: null, rsiValue: null, suggestedStop: null };
  if (!indicators || typeof unrealizedPnl !== 'number' || unrealizedPnl <= 0) {
    return { isExhausted: false, reason: null, rsiValue: null, suggestedStop: null };
  }

  const normSide = normalizeSide(side);
  if (!normSide) return { isExhausted: false, reason: null, rsiValue: null, suggestedStop: null };

  const rsi = indicators.rsi;
  if (!rsi || rsi.status !== 'ok' || typeof rsi.value !== 'number') {
    return { isExhausted: false, reason: null, rsiValue: null, suggestedStop: null };
  }

  const rsiVal = rsi.value;
  const overbought = cfg.rsiExhaustionOverbought || 78;
  const oversold = cfg.rsiExhaustionOversold || 22;
  const tightMultiplier = cfg.exhaustionTrailingMultiplier || 0.75;

  let suggestedStop = null;
  if (typeof currentPrice === 'number' && typeof atr === 'number' && atr > 0) {
    suggestedStop = normSide === 'long'
      ? currentPrice - atr * tightMultiplier
      : currentPrice + atr * tightMultiplier;
  }

  if (normSide === 'long' && rsiVal >= overbought) {
    const reason = `Momentum exhaustion: RSI ${rsiVal.toFixed(1)} >= ${overbought} (extreme overbought) while in profit (+${unrealizedPnl.toFixed(2)}) — locking profit with tightened ${tightMultiplier}x ATR trail.`;
    return { isExhausted: true, reason, rsiValue: rsiVal, suggestedStop };
  }

  if (normSide === 'short' && rsiVal <= oversold) {
    const reason = `Momentum exhaustion: RSI ${rsiVal.toFixed(1)} <= ${oversold} (extreme oversold) while in profit (+${unrealizedPnl.toFixed(2)}) — locking profit with tightened ${tightMultiplier}x ATR trail.`;
    return { isExhausted: true, reason, rsiValue: rsiVal, suggestedStop };
  }

  return { isExhausted: false, reason: null, rsiValue: rsiVal, suggestedStop: null };
}

module.exports = {
  computeAdaptiveTargets,
  detectCandleSpike,
  detectMomentumExhaustion,
  // Exported for direct unit testing of each pure step.
  normalizeSide,
  computeAtrTargets,
  computeRMultipleTargets,
  blendTargets,
  scaleTargets,
  snapToStructure,
  applyStructureSnap,
  classifyTrendStrength,
  applyTrendAdjustment,
  applyVolumeModifier,
  deriveVolatilityRegime,
  buildReversalConditions,
};

