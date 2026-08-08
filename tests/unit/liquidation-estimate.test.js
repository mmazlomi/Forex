'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateLiquidationPrice, isStopLossSafeFromLiquidation } = require('../../src/services/orders/liquidation-estimate');

test('estimateLiquidationPrice: long liquidation sits below entry, short liquidation sits above entry', () => {
  const long = estimateLiquidationPrice({ entryPrice: 60000, leverage: 5, side: 'long' });
  const short = estimateLiquidationPrice({ entryPrice: 60000, leverage: 5, side: 'short' });
  assert.ok(long < 60000);
  assert.ok(short > 60000);
});

test('estimateLiquidationPrice: higher leverage means liquidation is closer to entry (less room)', () => {
  const low = estimateLiquidationPrice({ entryPrice: 60000, leverage: 2, side: 'long' });
  const high = estimateLiquidationPrice({ entryPrice: 60000, leverage: 20, side: 'long' });
  assert.ok(high > low); // 20x's liquidation is closer to (higher than) entry for a long than 2x's
});

test('isStopLossSafeFromLiquidation: long requires stop strictly above liquidation', () => {
  assert.equal(isStopLossSafeFromLiquidation({ side: 'long', stopLoss: 55000, liquidationPrice: 48300 }), true);
  assert.equal(isStopLossSafeFromLiquidation({ side: 'long', stopLoss: 45000, liquidationPrice: 48300 }), false);
});

test('isStopLossSafeFromLiquidation: short requires stop strictly below liquidation', () => {
  assert.equal(isStopLossSafeFromLiquidation({ side: 'short', stopLoss: 70000, liquidationPrice: 79700 }), true);
  assert.equal(isStopLossSafeFromLiquidation({ side: 'short', stopLoss: 85000, liquidationPrice: 79700 }), false);
});

test('isStopLossSafeFromLiquidation: passes through as safe when liquidationPrice is not a number (nothing to check against)', () => {
  assert.equal(isStopLossSafeFromLiquidation({ side: 'long', stopLoss: 45000, liquidationPrice: null }), true);
  assert.equal(isStopLossSafeFromLiquidation({ side: 'long', stopLoss: 45000, liquidationPrice: undefined }), true);
});
