'use strict';

/**
 * Realized profit expressed in R-multiples (units of the original risk taken) — the standard way
 * to compare trades of different sizes/instruments on one scale: "+2R" means the trade returned
 * twice what was risked, regardless of dollar size. `rMultiple` here is a position's own stored
 * r_multiple column (the risk-per-unit distance |entryPrice - stopLoss| at entry — see
 * adaptive-take-profit-resolver.js), and `initialQty` its initial_qty column, so
 * `rMultiple * initialQty` is the total dollar risk originally taken. Pure, never throws — returns
 * null (not NaN/Infinity) when either input is missing/zero, since a position with no stored
 * r_multiple (every non-adaptive position) simply has no R-multiple to report.
 */
function computeRealizedR(totalRealizedPnl, rMultiple, initialQty) {
  if (typeof totalRealizedPnl !== 'number' || typeof rMultiple !== 'number' || typeof initialQty !== 'number') return null;
  const totalRisk = rMultiple * initialQty;
  if (!(totalRisk > 0)) return null;
  return totalRealizedPnl / totalRisk;
}

module.exports = { computeRealizedR };
