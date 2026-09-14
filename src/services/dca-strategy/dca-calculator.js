'use strict';

/**
 * Controlled DCA / Martingale Safety Order Calculator (3Commas / Quadency style)
 *
 * Parameters:
 * - baseOrderValue: value of the initial entry order
 * - maxSafetyOrders: total number of averaging orders allowed (e.g. 3 to 5)
 * - priceDeviationPercent: % price drop to trigger the first safety order (e.g. 1.5%)
 * - safetyOrderStepScale: multiplier for subsequent step deviations (e.g. 1.2x)
 * - safetyOrderVolumeScale: multiplier for subsequent safety order sizes (e.g. 1.4x)
 * - targetTakeProfitPercent: % profit target above average entry (e.g. 1.5%)
 */
function calculateDcaPlan({
  entryPrice,
  baseOrderValue = 100,
  maxSafetyOrders = 4,
  priceDeviationPercent = 2.0,
  safetyOrderStepScale = 1.2,
  safetyOrderVolumeScale = 1.4,
  targetTakeProfitPercent = 1.5,
}) {
  if (entryPrice <= 0 || baseOrderValue <= 0 || maxSafetyOrders < 1) {
    throw new Error('Invalid DCA parameters: entryPrice > 0, baseOrderValue > 0, maxSafetyOrders >= 1');
  }

  const orders = [];

  // Order 0: Base Order
  let cumulativeValue = baseOrderValue;
  let cumulativeUnits = baseOrderValue / entryPrice;
  let averagePrice = entryPrice;

  orders.push({
    orderIndex: 0,
    type: 'BASE_ORDER',
    triggerPrice: entryPrice,
    orderValue: baseOrderValue,
    units: Number(cumulativeUnits.toFixed(6)),
    averagePrice: Number(averagePrice.toFixed(4)),
    takeProfitPrice: Number((averagePrice * (1 + targetTakeProfitPercent / 100)).toFixed(4)),
    requiredDrawdownPercent: 0,
  });

  let currentDeviation = priceDeviationPercent;
  let cumulativeDeviation = 0;
  let currentSoValue = baseOrderValue;

  for (let i = 1; i <= maxSafetyOrders; i++) {
    cumulativeDeviation += currentDeviation;
    const triggerPrice = entryPrice * (1 - cumulativeDeviation / 100);

    // Scale order size
    currentSoValue = currentSoValue * safetyOrderVolumeScale;
    const orderUnits = currentSoValue / triggerPrice;

    cumulativeValue += currentSoValue;
    cumulativeUnits += orderUnits;
    averagePrice = cumulativeValue / cumulativeUnits;

    orders.push({
      orderIndex: i,
      type: `SAFETY_ORDER_${i}`,
      triggerPrice: Number(triggerPrice.toFixed(4)),
      orderValue: Number(currentSoValue.toFixed(2)),
      units: Number(orderUnits.toFixed(6)),
      cumulativeInvested: Number(cumulativeValue.toFixed(2)),
      averagePrice: Number(averagePrice.toFixed(4)),
      takeProfitPrice: Number((averagePrice * (1 + targetTakeProfitPercent / 100)).toFixed(4)),
      requiredDrawdownPercent: Number(cumulativeDeviation.toFixed(2)),
    });

    // Scale deviation step for the next level
    currentDeviation *= safetyOrderStepScale;
  }

  return {
    entryPrice,
    baseOrderValue,
    maxSafetyOrders,
    targetTakeProfitPercent,
    totalCapitalCommitted: Number(cumulativeValue.toFixed(2)),
    maxDrawdownCoveredPercent: Number(cumulativeDeviation.toFixed(2)),
    finalAveragePriceAfterAllOrders: Number(averagePrice.toFixed(4)),
    orders,
  };
}

module.exports = { calculateDcaPlan };
