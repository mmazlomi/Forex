'use strict';

/**
 * Grid Trading Calculator
 * Generates arithmetic and geometric price grid levels for sideways/ranging markets.
 *
 * Parameters:
 * - lowerPrice: bottom boundary of the grid
 * - upperPrice: top boundary of the grid
 * - gridCount: number of grid orders (e.g. 5 to 50)
 * - mode: 'arithmetic' (equal price steps) | 'geometric' (equal percentage steps)
 * - totalInvestment: capital assigned to this grid
 */
function calculateGrid({ lowerPrice, upperPrice, gridCount = 10, mode = 'arithmetic', totalInvestment = 1000 }) {
  if (lowerPrice <= 0 || upperPrice <= lowerPrice || gridCount < 2) {
    throw new Error('Invalid grid parameters: upperPrice must exceed lowerPrice > 0, and gridCount >= 2.');
  }

  const levels = [];
  const allocationPerGrid = totalInvestment / gridCount;

  if (mode === 'arithmetic') {
    const step = (upperPrice - lowerPrice) / gridCount;
    for (let i = 0; i <= gridCount; i++) {
      const price = Number((lowerPrice + i * step).toFixed(4));
      levels.push({
        index: i,
        price,
        allocation: allocationPerGrid,
        targetProfitPrice: i < gridCount ? Number((price + step).toFixed(4)) : null,
      });
    }
  } else {
    // Geometric: P_i = lower * (upper / lower) ^ (i / gridCount)
    const ratio = Math.pow(upperPrice - lowerPrice, 1 / gridCount);
    for (let i = 0; i <= gridCount; i++) {
      const price = Number((lowerPrice * Math.pow(upperPrice / lowerPrice, i / gridCount)).toFixed(4));
      levels.push({
        index: i,
        price,
        allocation: allocationPerGrid,
        targetProfitPrice: null,
      });
    }
  }

  const stepPercent = ((levels[1].price - levels[0].price) / levels[0].price) * 100;

  return {
    lowerPrice,
    upperPrice,
    gridCount,
    mode,
    totalInvestment,
    allocationPerGrid,
    stepPercent: Number(stepPercent.toFixed(2)),
    levels,
  };
}

/**
 * Maps current market price to pending Buy and Sell limit orders across the grid.
 */
function getActiveGridOrders(grid, currentPrice) {
  const buyOrders = [];
  const sellOrders = [];

  for (const level of grid.levels) {
    if (level.price < currentPrice) {
      buyOrders.push({
        type: 'BUY',
        limitPrice: level.price,
        orderValue: grid.allocationPerGrid,
        expectedExit: level.price * (1 + grid.stepPercent / 100),
      });
    } else if (level.price > currentPrice) {
      sellOrders.push({
        type: 'SELL',
        limitPrice: level.price,
        orderValue: grid.allocationPerGrid,
        expectedExit: level.price * (1 - grid.stepPercent / 100),
      });
    }
  }

  return {
    currentPrice,
    buyOrders: buyOrders.sort((a, b) => b.limitPrice - a.limitPrice), // highest buy limit first
    sellOrders: sellOrders.sort((a, b) => a.limitPrice - b.limitPrice), // lowest sell limit first
  };
}

module.exports = { calculateGrid, getActiveGridOrders };
