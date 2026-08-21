'use strict';

// Trading-statistics rollup for the Statistics dashboard section — trade counts, win rate, and
// realized P&L across every CLOSED position this user has, sliced by mode (demo/real), market
// (spot/futures), and strategy. Scoped to one user throughout, same as every other portfolio
// endpoint in this app (there's no admin/cross-user role — see users table) — "totally" in the
// feature request means "the overall total across this user's own trades," not across all
// accounts on a shared instance.

const positionsRepository = require('../../database/repositories/positions-repository');
const futuresPositionsRepository = require('../../database/repositories/futures-positions-repository');
const { describeStrategyIds } = require('../signals/strategies');

/**
 * Aggregates a flat list of closed positions (spot and/or futures rows both have realized_pnl,
 * strategy_id, combined_strategy_ids_json — the only fields this needs) into count/win-rate/P&L
 * summary stats. Win rate's denominator excludes exact-breakeven trades (realized_pnl === 0) —
 * there's no "right" side of a breakeven trade, so counting it as a loss (or a win) would distort
 * the rate rather than clarify it.
 */
function summarize(positions) {
  let wins = 0;
  let losses = 0;
  let totalRealizedPnl = 0;
  let grossWin = 0;
  let grossLoss = 0;

  for (const p of positions) {
    const pnl = p.realized_pnl ?? 0;
    totalRealizedPnl += pnl;
    if (pnl > 0) { wins += 1; grossWin += pnl; }
    else if (pnl < 0) { losses += 1; grossLoss += pnl; }
  }

  const count = positions.length;
  const decided = wins + losses;

  return {
    count,
    wins,
    losses,
    breakeven: count - decided,
    winRatePercent: decided > 0 ? (wins / decided) * 100 : null,
    totalRealizedPnl,
    avgWin: wins > 0 ? grossWin / wins : null,
    avgLoss: losses > 0 ? grossLoss / losses : null,
    // Gross profit / gross loss — the standard "how many dollars won per dollar lost" measure.
    // null when there's nothing to divide by yet, the string '∞' when every closed trade won —
    // NOT the number Infinity, which JSON.stringify silently turns into null over the wire,
    // making a perfect win record indistinguishable from "no data yet" once this crosses the API.
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? '∞' : null),
  };
}

// Groups by the exact same strategy id/name combination the Trade History table already shows
// per row (via describeStrategyIds) — a combined-vote trade is attributed to that whole voting
// group as one bucket, not split across its component strategies individually.
function strategyGroupKey(position) {
  const described = describeStrategyIds(position.strategy_id, position.combined_strategy_ids_json);
  if (described.length === 0) return { key: 'none', label: 'No Strategy (Manual)' };
  return { key: described.map((d) => d.id).join('+'), label: described.map((d) => d.name).join(' + ') };
}

function byStrategyBreakdown(positions) {
  const groups = new Map();
  for (const p of positions) {
    const { key, label } = strategyGroupKey(p);
    if (!groups.has(key)) groups.set(key, { strategyId: key, strategyName: label, positions: [] });
    groups.get(key).positions.push(p);
  }
  return Array.from(groups.values())
    .map((g) => ({ strategyId: g.strategyId, strategyName: g.strategyName, ...summarize(g.positions) }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Full statistics rollup for one user: per (mode, market) summary, a demo/real/overall total, and
 * a per-strategy win-rate breakdown for demo and real kept separate — mixing demo's unlimited
 * simulated capital into real's numbers would make the real win rate/P&L meaningless.
 */
function getStatistics(userId) {
  const demoSpot = positionsRepository.listAllClosedPositions('demo', userId);
  const realSpot = positionsRepository.listAllClosedPositions('real', userId);
  const demoFutures = futuresPositionsRepository.listAllClosedPositions('demo', userId);
  const realFutures = futuresPositionsRepository.listAllClosedPositions('real', userId);

  const demoAll = [...demoSpot, ...demoFutures];
  const realAll = [...realSpot, ...realFutures];

  return {
    demo: {
      spot: summarize(demoSpot),
      futures: summarize(demoFutures),
      total: summarize(demoAll),
      byStrategy: byStrategyBreakdown(demoAll),
    },
    real: {
      spot: summarize(realSpot),
      futures: summarize(realFutures),
      total: summarize(realAll),
      byStrategy: byStrategyBreakdown(realAll),
    },
    overall: summarize([...demoAll, ...realAll]),
  };
}

module.exports = { getStatistics, summarize, byStrategyBreakdown };
