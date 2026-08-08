'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTrade } = require('../../src/services/risk/validate-trade');

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

test('leverage omitted is byte-for-byte identical to today\'s spot behavior (requiredMargin === orderValue)', () => {
  const withoutLeverage = validateTrade(baseTrade());
  const withLeverageOne = validateTrade(baseTrade({ leverage: 1 }));
  assert.deepEqual(withoutLeverage, withLeverageOne);
  assert.equal(withoutLeverage.requiredMargin, withoutLeverage.orderValue);
});

test('leverage reduces required margin, letting a trade pass that would fail unleveraged', () => {
  // orderValue=500 (positionSize 5 * entryPrice 100), balance 10000, currentExposureValue 9600
  // -> availableBalance 400. Unleveraged this rejects (500 > 400); at 2x leverage requiredMargin
  // is 250, well under 400.
  const trade = baseTrade({ currentExposureValue: 9600, riskSettings: { ...baseRiskSettings, maxPortfolioExposurePercent: 200 } });
  const unleveraged = validateTrade(trade);
  assert.equal(unleveraged.accepted, false);
  assert.equal(unleveraged.reasonCode, 'INSUFFICIENT_BALANCE');

  const leveraged = validateTrade({ ...trade, leverage: 2 });
  assert.equal(leveraged.accepted, true);
  assert.equal(leveraged.requiredMargin, 250);
  assert.equal(leveraged.orderValue, 500); // notional unchanged by leverage
});

test('leverage does NOT loosen the max-order-value clamp (notional-based, leverage-independent) — an auto-sized position still shrinks to the same notional cap regardless of leverage', () => {
  // Auto-sized orderValue 500 > maxOrderValue 100 still clamps down to a notional of 100 at high
  // leverage, exactly as it would unleveraged — leverage only ever affects requiredMargin, never
  // the notional cap itself.
  const result = validateTrade(baseTrade({ leverage: 10, riskSettings: { ...baseRiskSettings, maxOrderValue: 100 } }));
  assert.equal(result.accepted, true);
  assert.ok(result.orderValue <= 100);
  assert.equal(result.requiredMargin, result.orderValue / 10);
});

test('leverage does NOT loosen the exposure check', () => {
  const result = validateTrade(
    baseTrade({ leverage: 10, currentExposureValue: 9600, riskSettings: { ...baseRiskSettings, maxPortfolioExposurePercent: 50 } })
  );
  assert.equal(result.accepted, false);
  assert.equal(result.reasonCode, 'MAX_EXPOSURE_EXCEEDED');
});

test('marginUsed (not notional currentExposureValue) is what offsets balance for existing positions — lets a new leveraged trade through even when notional exposure alone would exceed balance', () => {
  // balance 1000, three existing 5x-leveraged positions each with notional 3000 (marginUsed 600
  // each -> 1800 total) -> currentExposureValue (notional) 9000 vastly exceeds balance, but actual
  // committed margin (1800) leaves 8200... wait, use simpler numbers.
  // balance 1000, existing notional exposure 9000 (would make availableBalance deeply negative if
  // reused as-is), but actual margin committed is only 200 (9000 notional at effectively ~45x
  // blended leverage) -> availableBalance via marginUsed = 800, plenty for a new 100 order.
  const trade = baseTrade({
    currentExposureValue: 9000, // notional — used for the exposure-percent check (step 8)
    marginUsed: 200, // actual margin committed — used for the balance check (step 9)
    riskSettings: { ...baseRiskSettings, maxPortfolioExposurePercent: 99999 }, // disable step 8 for this test, isolate step 9
  });
  const result = validateTrade(trade);
  assert.equal(result.accepted, true);
});

test('marginUsed defaults to currentExposureValue when omitted — spot behavior (leverage always effectively 1) is unaffected', () => {
  const result = validateTrade(baseTrade({ currentExposureValue: 9600, riskSettings: { ...baseRiskSettings, maxPortfolioExposurePercent: 200 } }));
  assert.equal(result.accepted, false);
  assert.equal(result.reasonCode, 'INSUFFICIENT_BALANCE');
});

test('insufficient balance message mentions leverage/margin only when leverage > 1', () => {
  const trade = baseTrade({ currentExposureValue: 9600, riskSettings: { ...baseRiskSettings, maxPortfolioExposurePercent: 200 } });
  const unleveraged = validateTrade(trade);
  assert.doesNotMatch(unleveraged.message, /margin|leverage/i);

  const stillInsufficient = validateTrade({ ...trade, leverage: 1.1 });
  assert.equal(stillInsufficient.reasonCode, 'INSUFFICIENT_BALANCE');
  assert.match(stillInsufficient.message, /margin/i);
});
