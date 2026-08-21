'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAdaptivePositionFields, checkAdaptiveExits, realizePartialExit, simulateStrategy } = require('../../src/services/backtesting/backtest-engine');

function ok(value) { return { status: 'ok', value }; }
function noHistory() { return { status: 'insufficient_history', value: null }; }

const ENTRY_INDICATORS = {
  atr: ok(5),
  adx: ok({ adx: 30, pdi: 25, mdi: 10 }),
  supportResistance: ok({ nearestResistance: 200, nearestSupport: 80, resistanceLevels: [200], supportLevels: [80] }),
  volumeAnalysis: ok({ currentVolume: 20, volumeSma: 10, relativeVolume: 2 }),
};

// ---------- buildAdaptivePositionFields ----------

test('buildAdaptivePositionFields: returns null when adaptiveTpConfig is not supplied (baseline path)', () => {
  const fields = buildAdaptivePositionFields({ adaptiveTpConfig: undefined, entryPrice: 100, stopLoss: 95, entryIndicators: ENTRY_INDICATORS });
  assert.equal(fields, null);
});

test('buildAdaptivePositionFields: returns tp1<tp2<tp3 and fresh per-tier state when adaptiveTpConfig is supplied', () => {
  const fields = buildAdaptivePositionFields({ adaptiveTpConfig: {}, entryPrice: 100, stopLoss: 95, entryIndicators: ENTRY_INDICATORS });
  assert.ok(fields.tp1 < fields.tp2 && fields.tp2 < fields.tp3);
  assert.equal(fields.filledTiers.size, 0);
  assert.equal(fields.trailingActive, false);
  assert.equal(fields.highWaterMark, 100);
  assert.equal(fields.entryAtr, 5);
  const sum = fields.partialExitPercentages.tp1 + fields.partialExitPercentages.tp2 + fields.partialExitPercentages.tp3;
  assert.equal(sum, 100);
});

test('buildAdaptivePositionFields: fails safe to null when neither ATR nor stop-loss can produce a target (missing indicator data)', () => {
  const fields = buildAdaptivePositionFields({ adaptiveTpConfig: {}, entryPrice: 100, stopLoss: null, entryIndicators: { ...ENTRY_INDICATORS, atr: noHistory() } });
  assert.equal(fields, null);
});

// ---------- realizePartialExit ----------

test('realizePartialExit: decrements position.qty by exactly the leg qty and computes pnl against entry', () => {
  const position = { qty: 10, entryPrice: 100, entryTsUtc: '2020-01-01T00:00:00.000Z', signalId: null };
  const { trade, cashDelta } = realizePartialExit({ position, symbol: 'BTC/USDT', exitPrice: 110, qty: 4, exitReason: 'take_profit_1', tsUtc: '2020-01-02T00:00:00.000Z', feePercent: 0 });
  assert.equal(position.qty, 6);
  assert.equal(trade.qty, 4);
  assert.equal(trade.pnl, (110 - 100) * 4);
  assert.equal(cashDelta, 110 * 4);
});

test('realizePartialExit: fee is deducted from the cash delta', () => {
  const position = { qty: 10, entryPrice: 100, entryTsUtc: '2020-01-01T00:00:00.000Z', signalId: null };
  const { cashDelta } = realizePartialExit({ position, symbol: 'BTC/USDT', exitPrice: 100, qty: 10, exitReason: 'stop_loss', tsUtc: '2020-01-02T00:00:00.000Z', feePercent: 1 });
  assert.equal(cashDelta, 1000 - 10); // 1% fee on 1000 notional
});

// ---------- checkAdaptiveExits ----------

function buildPosition(overrides = {}) {
  return {
    qty: 10, originalQty: 10, entryPrice: 100, entryTsUtc: '2020-01-01T00:00:00.000Z', signalId: null,
    stopLoss: 90, tp1: 110, tp2: 120, tp3: 130,
    partialExitPercentages: { tp1: 25, tp2: 35, tp3: 40 },
    recommendedTrailingMultiplier: 1.5, entryAtr: 5,
    filledTiers: new Set(), trailingActive: false, trailingStop: null, highWaterMark: 100,
    ...overrides,
  };
}

function candle(o) { return { tsUtc: Date.now(), open: o.open ?? 100, high: o.high, low: o.low, close: o.close ?? o.high }; }

test('checkAdaptiveExits: stop-loss takes priority and fully closes the position', () => {
  const position = buildPosition();
  const result = checkAdaptiveExits({ position, candle: candle({ high: 105, low: 89 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.closed, true);
  assert.equal(result.producedTrades.length, 1);
  assert.equal(result.producedTrades[0].exitReason, 'stop_loss');
  assert.equal(result.producedTrades[0].qty, 10);
});

test('checkAdaptiveExits: TP1 alone fires a partial exit for exactly its configured percent and leaves the position open', () => {
  const position = buildPosition();
  const result = checkAdaptiveExits({ position, candle: candle({ high: 111, low: 105 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.closed, false);
  assert.equal(result.producedTrades.length, 1);
  assert.equal(result.producedTrades[0].exitReason, 'take_profit_1');
  assert.equal(result.producedTrades[0].qty, 2.5); // 25% of originalQty(10)
  assert.equal(position.qty, 7.5);
  assert.ok(position.filledTiers.has('tp1'));
});

test('checkAdaptiveExits: TP1 activates trailing immediately (seeded from this bar\'s high)', () => {
  const position = buildPosition();
  checkAdaptiveExits({ position, candle: candle({ high: 111, low: 105 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(position.trailingActive, true);
  assert.equal(position.trailingStop, 111 - 5 * 1.5); // highWaterMark(111) - entryAtr*multiplier
});

test('checkAdaptiveExits: a single bar gapping through TP1 AND TP2 fires both partials in one call, in order', () => {
  const position = buildPosition();
  const result = checkAdaptiveExits({ position, candle: candle({ high: 125, low: 108 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.producedTrades.length, 2);
  assert.equal(result.producedTrades[0].exitReason, 'take_profit_1');
  assert.equal(result.producedTrades[1].exitReason, 'take_profit_2');
  assert.equal(position.qty, 10 - 2.5 - 3.5); // 25% + 35% of original
  assert.equal(result.closed, false);
});

test('checkAdaptiveExits: gapping through all three tiers in one bar closes the position (dust remainder)', () => {
  const position = buildPosition();
  const result = checkAdaptiveExits({ position, candle: candle({ high: 135, low: 108 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.producedTrades.length, 3);
  assert.equal(result.closed, true);
});

test('checkAdaptiveExits: an already-filled tier never fires twice', () => {
  const position = buildPosition({ filledTiers: new Set(['tp1']), qty: 7.5, trailingActive: true, trailingStop: 105, highWaterMark: 111 });
  const result = checkAdaptiveExits({ position, candle: candle({ high: 111, low: 106 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.producedTrades.length, 0);
});

test('checkAdaptiveExits: trailing stop only ever moves in the position\'s favor, never loosens', () => {
  const position = buildPosition({ filledTiers: new Set(['tp1']), qty: 7.5, trailingActive: true, trailingStop: 105, highWaterMark: 111, entryAtr: 5, recommendedTrailingMultiplier: 1.5 });
  // Price pulls back (new high is LOWER than the existing high-water mark) — trailing stop must not loosen.
  checkAdaptiveExits({ position, candle: candle({ high: 108, low: 106 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(position.trailingStop, 105); // unchanged, not lowered
  assert.equal(position.highWaterMark, 111); // unchanged, not lowered
});

test('checkAdaptiveExits: trailing stop ratchets up as price makes a new high', () => {
  const position = buildPosition({ filledTiers: new Set(['tp1']), qty: 7.5, trailingActive: true, trailingStop: 105, highWaterMark: 111, entryAtr: 5, recommendedTrailingMultiplier: 1.5 });
  checkAdaptiveExits({ position, candle: candle({ high: 120, low: 112 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(position.highWaterMark, 120);
  assert.equal(position.trailingStop, 120 - 5 * 1.5);
});

test('checkAdaptiveExits: once trailing is active, the trailing stop (not the original fixed stop-loss) is what triggers a close', () => {
  // Original stopLoss=90 is far below price; trailingStop=105 is much closer and should be what fires.
  const position = buildPosition({ filledTiers: new Set(['tp1']), qty: 7.5, trailingActive: true, trailingStop: 105, highWaterMark: 111 });
  const result = checkAdaptiveExits({ position, candle: candle({ high: 106, low: 104 }), symbol: 'BTC/USDT', feePercent: 0, slippagePercent: 0 });
  assert.equal(result.closed, true);
  assert.equal(result.producedTrades[0].exitReason, 'trailing_stop');
});

// ---------- simulateStrategy: end-to-end wiring / backward-compat regression ----------

function flatCandles(n = 45) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    tsUtc: now + i * 3600_000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10,
  }));
}

test('simulateStrategy: omitting adaptiveTpConfig never produces a position with filledTiers set (baseline path only), and is deterministic across repeated runs', () => {
  const candles = flatCandles();
  const args = {
    candles, startIndex: 40, symbol: 'BTC/USDT', initialCapital: 10000, feePercent: 0.1, slippagePercent: 0.05,
    riskSettings: { maxRiskPerTradePercent: 1, minRiskRewardRatio: 1.5 }, config: { fundamentalWeight: 0, technicalWeight: 1 },
  };
  const first = simulateStrategy(args);
  const second = simulateStrategy(args);
  assert.deepEqual(first, second);
  assert.ok(first.trades.every((t) => !String(t.exitReason).startsWith('take_profit_') && t.exitReason !== 'trailing_stop'));
});

test('simulateStrategy: passing adaptiveTpConfig on flat/no-signal data still runs to completion without throwing and produces the same equity-curve length as the baseline call', () => {
  const candles = flatCandles();
  const baseArgs = {
    candles, startIndex: 40, symbol: 'BTC/USDT', initialCapital: 10000, feePercent: 0.1, slippagePercent: 0.05,
    riskSettings: { maxRiskPerTradePercent: 1, minRiskRewardRatio: 1.5 }, config: { fundamentalWeight: 0, technicalWeight: 1 },
  };
  const baseline = simulateStrategy(baseArgs);
  const adaptive = simulateStrategy({ ...baseArgs, adaptiveTpConfig: {} });
  assert.equal(adaptive.equityCurve.length, baseline.equityCurve.length);
  // No signal ever fires on perfectly flat candles, so both should have zero trades either way.
  assert.equal(baseline.trades.length, 0);
  assert.equal(adaptive.trades.length, 0);
});
