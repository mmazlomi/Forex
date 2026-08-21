'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAdaptivePositionFieldsReversal, checkAdaptiveExitsReversal, realizePartialExitReversal,
} = require('../../src/services/backtesting/reversal-backtest-engine');

function ok(value) { return { status: 'ok', value }; }

const ENTRY_INDICATORS = {
  atr: ok(5),
  adx: ok({ adx: 30, pdi: 25, mdi: 10 }),
  supportResistance: ok({ nearestResistance: 200, nearestSupport: 80, resistanceLevels: [200], supportLevels: [80] }),
  volumeAnalysis: ok({ currentVolume: 20, volumeSma: 10, relativeVolume: 2 }),
};

// ---------- buildAdaptivePositionFieldsReversal ----------

test('buildAdaptivePositionFieldsReversal: returns null when adaptiveTpConfig is not supplied', () => {
  const fields = buildAdaptivePositionFieldsReversal({ adaptiveTpConfig: undefined, entryPrice: 100, side: 'long', stopLoss: 95, entryIndicators: ENTRY_INDICATORS });
  assert.equal(fields, null);
});

test('buildAdaptivePositionFieldsReversal: LONG produces tp1<tp2<tp3 above entry', () => {
  const fields = buildAdaptivePositionFieldsReversal({ adaptiveTpConfig: {}, entryPrice: 100, side: 'long', stopLoss: 90, entryIndicators: ENTRY_INDICATORS });
  assert.ok(fields.tp1 > 100 && fields.tp1 < fields.tp2 && fields.tp2 < fields.tp3);
});

test('buildAdaptivePositionFieldsReversal: SHORT produces tp1>tp2>tp3 below entry (mirror of long)', () => {
  const fields = buildAdaptivePositionFieldsReversal({
    adaptiveTpConfig: {}, entryPrice: 100, side: 'short', stopLoss: 110,
    entryIndicators: { ...ENTRY_INDICATORS, supportResistance: ok({ nearestResistance: 130, nearestSupport: 60, resistanceLevels: [130], supportLevels: [60] }) },
  });
  assert.ok(fields.tp1 < 100 && fields.tp1 > fields.tp2 && fields.tp2 > fields.tp3);
});

// ---------- realizePartialExitReversal ----------

test('realizePartialExitReversal: LONG pnl is direction-positive on a favorable exit', () => {
  const position = { qty: 10, entryPrice: 100, entryTsUtc: '2020-01-01T00:00:00.000Z', direction: 'bullish', sweep: { sweepIndex: 1 }, chochLevel: { price: 99 } };
  const { trade } = realizePartialExitReversal({ position, symbol: 'BTC/USDT:USDT', exitPrice: 110, qty: 4, exitReason: 'take_profit_1', tsUtc: 'x', feePercent: 0, dirMult: 1 });
  assert.equal(trade.pnl, (110 - 100) * 4);
  assert.equal(trade.side, 'long');
  assert.equal(position.qty, 6);
});

test('realizePartialExitReversal: SHORT pnl is direction-positive when price falls (dirMult=-1)', () => {
  const position = { qty: 10, entryPrice: 100, entryTsUtc: '2020-01-01T00:00:00.000Z', direction: 'bearish', sweep: { sweepIndex: 1 }, chochLevel: { price: 101 } };
  const { trade } = realizePartialExitReversal({ position, symbol: 'BTC/USDT:USDT', exitPrice: 90, qty: 4, exitReason: 'take_profit_1', tsUtc: 'x', feePercent: 0, dirMult: -1 });
  assert.equal(trade.pnl, -1 * (90 - 100) * 4); // = 40, a profit for a short that fell
  assert.equal(trade.side, 'short');
});

// ---------- checkAdaptiveExitsReversal ----------

function buildLongPosition(overrides = {}) {
  return {
    direction: 'bullish', qty: 10, originalQty: 10, entryPrice: 100, entryTsUtc: '2020-01-01T00:00:00.000Z',
    sweep: { sweepIndex: 1 }, chochLevel: { price: 99 },
    stopLoss: 90, tp1: 110, tp2: 120, tp3: 130,
    partialExitPercentages: { tp1: 25, tp2: 35, tp3: 40 },
    recommendedTrailingMultiplier: 1.5, entryAtr: 5,
    filledTiers: new Set(), trailingActive: false, trailingStop: null, highWaterMark: 100,
    ...overrides,
  };
}

function buildShortPosition(overrides = {}) {
  return {
    direction: 'bearish', qty: 10, originalQty: 10, entryPrice: 100, entryTsUtc: '2020-01-01T00:00:00.000Z',
    sweep: { sweepIndex: 1 }, chochLevel: { price: 101 },
    stopLoss: 110, tp1: 90, tp2: 80, tp3: 70,
    partialExitPercentages: { tp1: 25, tp2: 35, tp3: 40 },
    recommendedTrailingMultiplier: 1.5, entryAtr: 5,
    filledTiers: new Set(), trailingActive: false, trailingStop: null, highWaterMark: 100,
    ...overrides,
  };
}

function bar(o) { return { tsUtc: Date.now(), open: o.open ?? 100, high: o.high, low: o.low, close: o.close ?? o.high }; }

test('checkAdaptiveExitsReversal (LONG): stop-loss fires on bar.low and fully closes', () => {
  const position = buildLongPosition();
  const result = checkAdaptiveExitsReversal({ position, bar: bar({ high: 105, low: 89 }), symbol: 'BTC/USDT:USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.closed, true);
  assert.equal(result.producedTrades[0].exitReason, 'stop_loss');
});

test('checkAdaptiveExitsReversal (SHORT): stop-loss fires on bar.high (mirrored direction)', () => {
  const position = buildShortPosition();
  const result = checkAdaptiveExitsReversal({ position, bar: bar({ high: 111, low: 95 }), symbol: 'BTC/USDT:USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.closed, true);
  assert.equal(result.producedTrades[0].exitReason, 'stop_loss');
});

test('checkAdaptiveExitsReversal (SHORT): TP1 fires on bar.low, partial qty, trailing activates downward', () => {
  const position = buildShortPosition();
  const result = checkAdaptiveExitsReversal({ position, bar: bar({ high: 95, low: 89 }), symbol: 'BTC/USDT:USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.closed, false);
  assert.equal(result.producedTrades[0].exitReason, 'take_profit_1');
  assert.equal(result.producedTrades[0].qty, 2.5);
  assert.equal(position.trailingActive, true);
  assert.equal(position.trailingStop, 89 + 5 * 1.5); // highWaterMark(89, the LOW) + entryAtr*multiplier
});

test('checkAdaptiveExitsReversal (SHORT): trailing stop only ever moves down, never loosens back up', () => {
  const position = buildShortPosition({ filledTiers: new Set(['tp1']), qty: 7.5, trailingActive: true, trailingStop: 95, highWaterMark: 89 });
  checkAdaptiveExitsReversal({ position, bar: bar({ high: 93, low: 91 }), symbol: 'BTC/USDT:USDT', feePercent: 0, slippagePercent: 0 }); // price pulls back up
  assert.equal(position.trailingStop, 95); // unchanged
  assert.equal(position.highWaterMark, 89); // unchanged
});

test('checkAdaptiveExitsReversal (SHORT): trailing stop ratchets down as price makes a new low', () => {
  const position = buildShortPosition({ filledTiers: new Set(['tp1']), qty: 7.5, trailingActive: true, trailingStop: 95, highWaterMark: 89 });
  checkAdaptiveExitsReversal({ position, bar: bar({ high: 85, low: 80 }), symbol: 'BTC/USDT:USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(position.highWaterMark, 80);
  assert.equal(position.trailingStop, 80 + 5 * 1.5);
});

test('checkAdaptiveExitsReversal (LONG): a single bar gapping through all three tiers closes the position', () => {
  const position = buildLongPosition();
  const result = checkAdaptiveExitsReversal({ position, bar: bar({ high: 135, low: 108 }), symbol: 'BTC/USDT:USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.producedTrades.length, 3);
  assert.equal(result.closed, true);
});

test('checkAdaptiveExitsReversal: an already-filled tier never fires twice', () => {
  const position = buildLongPosition({ filledTiers: new Set(['tp1']), qty: 7.5, trailingActive: true, trailingStop: 105, highWaterMark: 111 });
  const result = checkAdaptiveExitsReversal({ position, bar: bar({ high: 111, low: 106 }), symbol: 'BTC/USDT:USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.producedTrades.length, 0);
});
