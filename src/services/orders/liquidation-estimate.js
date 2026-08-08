'use strict';

// Standard, publicly-documented isolated-margin liquidation-price approximation, used only for
// Demo simulation (Real futures gets its actual liquidation price from KuCoin's own
// fetchPositions() — see futures-real-orders.js). maintenanceMarginRate is a conservative, flat
// placeholder (real exchanges use tiered rates that vary by position size and symbol); this is
// explicitly an approximation for simulating "roughly how much room a leveraged demo position
// has," not a claim of exactness — never surfaced as if it were KuCoin's real number.
const DEMO_MAINTENANCE_MARGIN_RATE = 0.005;

function estimateLiquidationPrice({ entryPrice, leverage, side, maintenanceMarginRate = DEMO_MAINTENANCE_MARGIN_RATE }) {
  if (side === 'long') {
    return entryPrice * (1 - 1 / leverage + maintenanceMarginRate);
  }
  return entryPrice * (1 + 1 / leverage - maintenanceMarginRate);
}

// A stop-loss that sits beyond (or exactly at) the liquidation price would never actually
// trigger — the position gets liquidated first, so the stop provides no real protection. For a
// long, liquidation is below entry, so the stop must stay strictly above liquidation. For a
// short, liquidation is above entry, so the stop must stay strictly below it.
function isStopLossSafeFromLiquidation({ side, stopLoss, liquidationPrice }) {
  if (typeof liquidationPrice !== 'number') return true; // nothing to check against (e.g. real, pre-fetch)
  return side === 'long' ? stopLoss > liquidationPrice : stopLoss < liquidationPrice;
}

module.exports = { estimateLiquidationPrice, isStopLossSafeFromLiquidation, DEMO_MAINTENANCE_MARGIN_RATE };
