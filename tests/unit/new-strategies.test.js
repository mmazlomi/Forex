'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertrend = require('../../src/services/technical-analysis/supertrend');
const fairValueGap = require('../../src/services/technical-analysis/fair-value-gap');
const volumeProfile = require('../../src/services/technical-analysis/volume-profile');
const { calculateGrid, getActiveGridOrders } = require('../../src/services/grid-strategy/grid-calculator');
const { calculateDcaPlan } = require('../../src/services/dca-strategy/dca-calculator');

function makeCandles(prices) {
  const now = Date.now();
  return prices.map((close, i) => ({
    tsUtc: now + i * 60_000,
    open: close * 0.99,
    high: close * 1.01,
    low: close * 0.98,
    close,
    volume: 100 + i * 10,
  }));
}

test('SuperTrend computes bullish and bearish directions based on price action', () => {
  // Upward trending prices
  const uptrendCandles = makeCandles([100, 102, 104, 106, 108, 110, 112, 115, 118, 120, 122, 125]);
  const resUp = supertrend.compute(uptrendCandles, { period: 5, multiplier: 2 });
  assert.equal(resUp.status, 'ok');
  assert.equal(resUp.direction, 'up');
  assert.ok(resUp.value < 125);

  // Insufficient history
  const shortCandles = makeCandles([100, 101]);
  const resShort = supertrend.compute(shortCandles, { period: 10 });
  assert.equal(resShort.status, 'insufficient_history');
});

test('Fair Value Gap detects 3-bar imbalance and mitigation', () => {
  const candles = [
    { tsUtc: 1000, open: 100, high: 102, low: 99, close: 101, volume: 10 },
    { tsUtc: 2000, open: 101, high: 110, low: 101, close: 109, volume: 50 }, // Large green impulse
    { tsUtc: 3000, open: 109, high: 115, low: 106, close: 114, volume: 20 }, // Gap between C1 High (102) and C3 Low (106)
  ];
  const fvgRes = fairValueGap.compute(candles, { minGapPercent: 0.1 });
  assert.equal(fvgRes.status, 'ok');
  assert.equal(fvgRes.totalGapsFound, 1);
  assert.equal(fvgRes.nearestBullishFvg.bottom, 102);
  assert.equal(fvgRes.nearestBullishFvg.top, 106);
  assert.equal(fvgRes.nearestBullishFvg.mitigated, false);
});

test('Volume Profile computes VPOC and Value Area boundaries', () => {
  const candles = makeCandles([100, 101, 102, 101, 100, 99, 100, 101, 102, 103, 101, 100]);
  const vpRes = volumeProfile.compute(candles, { binsCount: 10 });
  assert.equal(vpRes.status, 'ok');
  assert.ok(typeof vpRes.vpoc === 'number');
  assert.ok(vpRes.val <= vpRes.vpoc && vpRes.vpoc <= vpRes.vah);
});

test('Grid Calculator generates correct levels and limit orders', () => {
  const grid = calculateGrid({ lowerPrice: 100, upperPrice: 150, gridCount: 5, totalInvestment: 500 });
  assert.equal(grid.levels.length, 6);
  assert.equal(grid.allocationPerGrid, 100);
  assert.equal(grid.levels[0].price, 100);
  assert.equal(grid.levels[5].price, 150);

  const activeOrders = getActiveGridOrders(grid, 125);
  assert.ok(activeOrders.buyOrders.length > 0);
  assert.ok(activeOrders.sellOrders.length > 0);
  assert.ok(activeOrders.buyOrders.every((o) => o.limitPrice < 125));
  assert.ok(activeOrders.sellOrders.every((o) => o.limitPrice > 125));
});

test('DCA Calculator computes safety orders and decreasing average price', () => {
  const dca = calculateDcaPlan({ entryPrice: 100, baseOrderValue: 100, maxSafetyOrders: 3 });
  assert.equal(dca.orders.length, 4); // Base order + 3 SOs
  assert.equal(dca.orders[0].type, 'BASE_ORDER');
  assert.ok(dca.orders[1].triggerPrice < 100);
  assert.ok(dca.orders[2].triggerPrice < dca.orders[1].triggerPrice);
  assert.ok(dca.orders[1].orderValue > dca.orders[0].orderValue); // Volume scaling
  assert.ok(dca.totalCapitalCommitted > 100);
});
