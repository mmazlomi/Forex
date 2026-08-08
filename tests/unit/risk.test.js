'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMaxRiskAmount, computePositionSize, computeRiskRewardRatio } = require('../../src/services/risk/position-sizing');
const { validateTrade } = require('../../src/services/risk/validate-trade');

test('Maximum Risk Amount = Portfolio Balance x Maximum Risk Percentage', () => {
  assert.equal(computeMaxRiskAmount(10000, 1), 100);
  assert.equal(computeMaxRiskAmount(5000, 2.5), 125);
});

test('Position Size = Maximum Risk Amount / |Entry - Stop|', () => {
  assert.equal(computePositionSize(100, 100, 98), 50);
  assert.equal(computePositionSize(100, 50, 60), 10);
});

test('Position Size is null when entry equals stop-loss (division by zero guarded)', () => {
  assert.equal(computePositionSize(100, 100, 100), null);
});

test('Risk-to-reward ratio computation', () => {
  assert.equal(computeRiskRewardRatio(100, 98, 106), 3);
  assert.equal(computeRiskRewardRatio(100, 100, 106), null);
});

const baseRiskSettings = {
  maxRiskPerTradePercent: 1,
  maxDailyLossPercent: 3,
  maxOpenPositions: 5,
  maxOrderValue: 1000,
  minRiskRewardRatio: 1.5,
  maxPortfolioExposurePercent: 99,
};

function baseTrade(overrides = {}) {
  return {
    mode: 'demo',
    emergencyStopActive: false,
    liveTradingEnabled: false,
    dataQuality: 'good',
    dataAgeMs: 1000,
    maxDataAgeMs: 60000,
    entryPrice: 100,
    stopLossPrice: 80,
    takeProfitPrice: 140,
    riskSettings: baseRiskSettings,
    balance: 10000,
    openPositionsCount: 0,
    dailyLossSoFar: 0,
    currentExposureValue: 0,
    minOrderValue: 0,
    isDuplicate: false,
    ...overrides,
  };
}

test('validateTrade accepts a well-formed trade and returns correct sizing', () => {
  const result = validateTrade(baseTrade());
  assert.equal(result.accepted, true);
  assert.equal(result.positionSize, 5); // maxRiskAmount(100) / riskPerUnit(20)
  assert.equal(result.orderValue, 500);
  assert.equal(result.riskRewardRatio, 2);
});

test('validateTrade rejects when emergency stop is active', () => {
  const result = validateTrade(baseTrade({ emergencyStopActive: true }));
  assert.equal(result.accepted, false);
  assert.equal(result.reasonCode, 'EMERGENCY_STOP_ACTIVE');
});

test('validateTrade rejects real-mode trades when live trading is disabled', () => {
  const result = validateTrade(baseTrade({ mode: 'real', liveTradingEnabled: false }));
  assert.equal(result.accepted, false);
  assert.equal(result.reasonCode, 'LIVE_TRADING_DISABLED');
});

test('validateTrade accepts real-mode trades when live trading is enabled', () => {
  const result = validateTrade(baseTrade({ mode: 'real', liveTradingEnabled: true }));
  assert.equal(result.accepted, true);
});

test('validateTrade rejects insufficient data quality', () => {
  const result = validateTrade(baseTrade({ dataQuality: 'insufficient' }));
  assert.equal(result.reasonCode, 'INSUFFICIENT_DATA');
});

test('validateTrade rejects stale data beyond maxDataAgeMs', () => {
  const result = validateTrade(baseTrade({ dataAgeMs: 999999 }));
  assert.equal(result.reasonCode, 'STALE_DATA');
});

test('validateTrade rejects when entry equals stop-loss', () => {
  const result = validateTrade(baseTrade({ stopLossPrice: 100 }));
  assert.equal(result.reasonCode, 'INVALID_STOP_LOSS');
});

test('validateTrade rejects risk/reward below the configured minimum', () => {
  const result = validateTrade(baseTrade({ takeProfitPrice: 110 })); // reward 10 / risk 20 = 0.5 < 1.5
  assert.equal(result.reasonCode, 'RISK_REWARD_TOO_LOW');
});

test('validateTrade tolerates a floating-point-noise ratio at the minRiskRewardRatio boundary (regression: a "true" 1.5 computed as 1.4999999999999791 was wrongly rejected)', () => {
  // riskPerUnit(20) * 1.5 - a sliver lands a hair under the intended 1.5 ratio purely from binary
  // float representation, not a genuinely worse risk/reward — same shape as the real GRAM/USDT
  // signal that triggered this (stop/take-profit prices derived from earlier float arithmetic).
  const result = validateTrade(baseTrade({ takeProfitPrice: 100 + 20 * 1.5 - 1e-10 }));
  assert.equal(result.accepted, true);
});

test('validateTrade still rejects a ratio that is genuinely below the minimum, not just float noise', () => {
  const result = validateTrade(baseTrade({ takeProfitPrice: 100 + 20 * 1.4 })); // ratio 1.4, well outside the epsilon
  assert.equal(result.reasonCode, 'RISK_REWARD_TOO_LOW');
});

test('validateTrade shrinks an auto-sized position to fit maxOrderValue instead of rejecting, risking less than the configured max', () => {
  // Auto-sizing would give positionSize=5 (maxRiskAmount 100 / riskPerUnit 20), orderValue 500 —
  // over a maxOrderValue of 100. Clamped down to positionSize=1 (100/entryPrice 100), which risks
  // only 20 (1 * riskPerUnit 20), well under maxRiskAmount(100) — strictly safer, never rejected.
  const result = validateTrade(baseTrade({ riskSettings: { ...baseRiskSettings, maxOrderValue: 100 } }));
  assert.equal(result.accepted, true);
  assert.equal(result.positionSize, 1);
  assert.ok(result.orderValue <= 100);
  assert.equal(result.riskAmount, 20);
});

test('validateTrade never lets the order-value clamp push orderValue above maxOrderValue, even with a fractional-unit price', () => {
  // Mirrors the real GRAM/USDT case: a very tight stop relative to price auto-sizes to a huge
  // notional, which must clamp down to fit, not float a hair over via rounding.
  const result = validateTrade(baseTrade({
    entryPrice: 1.395, stopLossPrice: 1.3896684559541732, takeProfitPrice: 1.4029973160687401,
    riskSettings: { ...baseRiskSettings, maxOrderValue: 1000, minRiskRewardRatio: 1 },
  }));
  assert.equal(result.accepted, true);
  assert.ok(result.orderValue <= 1000, `orderValue ${result.orderValue} must not exceed maxOrderValue`);
});

test('validateTrade rejects order value below an exchange minimum', () => {
  const result = validateTrade(baseTrade({ minOrderValue: 100000 }));
  assert.equal(result.reasonCode, 'ORDER_VALUE_TOO_SMALL');
});

test('validateTrade rejects once max open positions is reached', () => {
  const result = validateTrade(baseTrade({ openPositionsCount: 5 }));
  assert.equal(result.reasonCode, 'MAX_OPEN_POSITIONS_REACHED');
});

test('validateTrade rejects once max daily loss is reached', () => {
  const result = validateTrade(baseTrade({ dailyLossSoFar: 500 })); // 5% of 10000 >= 3% max
  assert.equal(result.reasonCode, 'MAX_DAILY_LOSS_REACHED');
});

test('validateTrade rejects when resulting exposure would exceed the limit', () => {
  const result = validateTrade(baseTrade({ currentExposureValue: 9600, riskSettings: { ...baseRiskSettings, maxPortfolioExposurePercent: 50 } }));
  assert.equal(result.reasonCode, 'MAX_EXPOSURE_EXCEEDED');
});

test('validateTrade rejects when order value exceeds available balance', () => {
  // maxPortfolioExposurePercent raised so this isolates the balance check specifically,
  // rather than tripping MAX_EXPOSURE_EXCEEDED first (both checks use exposure/balance
  // and are intentionally layered/redundant — see the exposure test above for that path).
  const result = validateTrade(baseTrade({ currentExposureValue: 9600, riskSettings: { ...baseRiskSettings, maxPortfolioExposurePercent: 200 } }));
  assert.equal(result.reasonCode, 'INSUFFICIENT_BALANCE');
});

test('validateTrade rejects duplicate orders', () => {
  const result = validateTrade(baseTrade({ isDuplicate: true }));
  assert.equal(result.reasonCode, 'DUPLICATE_ORDER');
});

test('validateTrade accepts a caller-supplied qtyOverride smaller than the auto-sized max, and reports the real (smaller) risk incurred', () => {
  // Auto-sizing would give positionSize=5 (maxRiskAmount 100 / riskPerUnit 20) per baseTrade();
  // 2 stays well under both that ceiling and maxOrderValue.
  const result = validateTrade(baseTrade({ qtyOverride: 2 }));
  assert.equal(result.accepted, true);
  assert.equal(result.positionSize, 2);
  assert.equal(result.orderValue, 200); // 2 * entryPrice(100)
  assert.equal(result.riskAmount, 40); // 2 * riskPerUnit(20) — less than maxRiskAmount(100), not clamped up to it
});

test('validateTrade rejects a qtyOverride that would risk more than maxRiskPerTradePercent allows, and reports the max qty actually allowed', () => {
  // riskPerUnit=20, maxRiskAmount=100 -> max allowed qty is 5; 6 risks 120, over the cap.
  const result = validateTrade(baseTrade({ qtyOverride: 6 }));
  assert.equal(result.accepted, false);
  assert.equal(result.reasonCode, 'RISK_AMOUNT_TOO_LARGE');
  assert.equal(result.maxQty, 5);
});

test('validateTrade rejects a non-positive or non-finite qtyOverride before it ever reaches risk-amount math', () => {
  assert.equal(validateTrade(baseTrade({ qtyOverride: 0 })).reasonCode, 'INVALID_QTY');
  assert.equal(validateTrade(baseTrade({ qtyOverride: -3 })).reasonCode, 'INVALID_QTY');
  assert.equal(validateTrade(baseTrade({ qtyOverride: NaN })).reasonCode, 'INVALID_QTY');
});

test('validateTrade still runs every other check (e.g. maxOrderValue) against a qtyOverride-derived orderValue', () => {
  // qty=2 -> orderValue 200, which is fine on its own, but here maxOrderValue is dropped to 100.
  const result = validateTrade(baseTrade({ qtyOverride: 2, riskSettings: { ...baseRiskSettings, maxOrderValue: 100 } }));
  assert.equal(result.accepted, false);
  assert.equal(result.reasonCode, 'ORDER_VALUE_TOO_LARGE');
});
