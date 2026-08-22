'use strict';

const { getDb } = require('../connection');
const { positionsTable } = require('./mode-tables');

function listOpenPositions(mode, userId) {
  const db = getDb();
  const table = positionsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND status = 'open' ORDER BY opened_at_utc`).all(userId);
}

// Deliberately NOT scoped by user_id — used only by position-risk-watcher.js's per-cycle
// stop-loss/take-profit check, which is one shared background process that must see every
// account's open positions. Each returned row still carries its own user_id.
function listAllOpenPositions(mode) {
  const db = getDb();
  const table = positionsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE status = 'open' ORDER BY opened_at_utc`).all();
}

function insertPosition(mode, userId, position) {
  const db = getDb();
  const table = positionsTable(mode);
  // initial_stop_loss snapshots stop_loss as opened — never touched again, unlike stop_loss itself
  // (which position-risk-watcher.js's trailing ratchet overwrites in place) — so trade history can
  // show both the as-opened stop and, separately, wherever trailing eventually moved it to.
  // initial_qty is the adaptive-TP engine's equivalent snapshot for qty — see
  // schema.js#migrateAddAdaptiveTakeProfitColumns for why qty itself must stay mutable.
  const result = db
    .prepare(
      `INSERT INTO ${table} (user_id, symbol, exchange, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, status, signal_id, strategy_id, combined_strategy_ids_json, combined_votes_json, source, timeframe, trailing_percent, trailing_high_water_mark, initial_stop_loss, initial_qty, adaptive_tp_enabled, entry_atr, r_multiple, entry_context_json, tp1_price, tp2_price, tp3_price, tp1_qty_percent, tp2_qty_percent, tp3_qty_percent, recommended_trailing_multiplier, exit_reversal_conditions_json)
       VALUES (@userId, @symbol, @exchange, @side, @qty, @entryPrice, @stopLoss, @takeProfit, @openedAtUtc, 'open', @signalId, @strategyId, @combinedStrategyIdsJson, @combinedVotesJson, @source, @timeframe, @trailingPercent, @trailingHighWaterMark, @stopLoss, @initialQty, @adaptiveTpEnabled, @entryAtr, @rMultiple, @entryContextJson, @tp1Price, @tp2Price, @tp3Price, @tp1QtyPercent, @tp2QtyPercent, @tp3QtyPercent, @recommendedTrailingMultiplier, @exitReversalConditionsJson)`
    )
    .run({
      exchange: null,
      signalId: null, strategyId: null, combinedStrategyIdsJson: null, combinedVotesJson: null, source: 'manual', timeframe: null,
      trailingPercent: null, trailingHighWaterMark: null,
      adaptiveTpEnabled: 0, entryAtr: null, rMultiple: null, entryContextJson: null,
      tp1Price: null, tp2Price: null, tp3Price: null,
      tp1QtyPercent: null, tp2QtyPercent: null, tp3QtyPercent: null,
      recommendedTrailingMultiplier: null, exitReversalConditionsJson: null,
      ...position,
      userId,
      initialQty: (position && position.initialQty != null) ? position.initialQty : position.qty,
    });
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(result.lastInsertRowid);
}

/**
 * Fires one TP tier (1/2/3) of an adaptive-TP position: decrements remaining qty by legQty, adds
 * legPnl to the running realized_pnl_partial_sum, stamps that tier's fill timestamp/price, and
 * appends {level,qty,price,feePercent,pnl,closedAtUtc} to the append-only partial_exits_json log.
 * Ownership-scoped like getPosition. Throws if that tier is already filled — defense in depth; the
 * caller (order service) must also check tpN_filled_at_utc IS NULL before calling, to avoid a
 * duplicate partial-close order ever reaching this far.
 */
function recordPartialExit(mode, userId, id, { level, qty, price, pnl, feePercent = null, closedAtUtc } = {}) {
  if (![1, 2, 3].includes(level)) throw new Error(`Invalid TP level ${level} — must be 1, 2, or 3.`);
  const db = getDb();
  const table = positionsTable(mode);
  const position = getPosition(mode, userId, id);
  if (!position) return null;

  const filledAtCol = `tp${level}_filled_at_utc`;
  const fillPriceCol = `tp${level}_fill_price`;
  if (position[filledAtCol]) {
    throw new Error(`TP${level} on position ${id} is already filled — refusing to record a duplicate partial exit.`);
  }

  const closedAt = closedAtUtc || new Date().toISOString();
  const priorLegs = position.partial_exits_json ? JSON.parse(position.partial_exits_json) : [];
  const legs = [...priorLegs, { level, qty, price, feePercent, pnl, closedAtUtc: closedAt }];
  const remainingQty = position.qty - qty;
  const newPartialSum = (position.realized_pnl_partial_sum || 0) + pnl;

  db.prepare(
    `UPDATE ${table} SET qty = ?, realized_pnl_partial_sum = ?, ${filledAtCol} = ?, ${fillPriceCol} = ?, partial_exits_json = ? WHERE id = ? AND user_id = ?`
  ).run(remainingQty, newPartialSum, closedAt, price, JSON.stringify(legs), id, userId);
  return getPosition(mode, userId, id);
}

// Ownership-scoped: WHERE id = ? AND user_id = ? — a mismatched userId returns undefined, same as
// a nonexistent id, rather than leaking another user's position.
function getPosition(mode, userId, id) {
  const db = getDb();
  const table = positionsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(id, userId);
}

function findOpenPositionBySymbol(mode, userId, symbol) {
  const db = getDb();
  const table = positionsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND symbol = ? AND status = 'open' LIMIT 1`).get(userId, symbol);
}

function closePosition(mode, userId, id, { exitPrice, realizedPnl, exitReason = null }) {
  const db = getDb();
  const table = positionsTable(mode);
  db.prepare(
    `UPDATE ${table} SET status = 'closed', exit_price = ?, realized_pnl = ?, closed_at_utc = ?, exit_reason = ? WHERE id = ? AND user_id = ?`
  ).run(exitPrice, realizedPnl, new Date().toISOString(), exitReason, id, userId);
  return getPosition(mode, userId, id);
}

function sumRealizedPnlSince(mode, userId, sinceUtc) {
  const db = getDb();
  const table = positionsTable(mode);
  const row = db
    .prepare(`SELECT COALESCE(SUM(realized_pnl), 0) as total FROM ${table} WHERE user_id = ? AND closed_at_utc >= ?`)
    .get(userId, sinceUtc);
  return row.total;
}

/** All-time realized P&L across every closed position — used for the Portfolio/P&L display. */
function sumAllRealizedPnl(mode, userId) {
  const db = getDb();
  const table = positionsTable(mode);
  const row = db.prepare(`SELECT COALESCE(SUM(realized_pnl), 0) as total FROM ${table} WHERE user_id = ? AND status = 'closed'`).get(userId);
  return row.total;
}

/** Win/loss counts across all closed positions (win = realized_pnl > 0). */
function countClosedByOutcome(mode, userId) {
  const db = getDb();
  const table = positionsTable(mode);
  const wins = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = ? AND status = 'closed' AND realized_pnl > 0`).get(userId).c;
  const losses = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = ? AND status = 'closed' AND realized_pnl <= 0`).get(userId).c;
  return { winCount: wins, lossCount: losses };
}

function listClosedPositions(mode, userId, { limit = 50 } = {}) {
  const db = getDb();
  const table = positionsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND status = 'closed' ORDER BY closed_at_utc DESC LIMIT ?`).all(userId, limit);
}

// Unlike listClosedPositions (capped, most-recent-first, for the Trade History display), this
// returns every closed position with no cap — used by trading-statistics-service.js, where a
// win-rate/PnL rollup that silently only covered the most recent 50 trades would be misleading.
function listAllClosedPositions(mode, userId) {
  const db = getDb();
  const table = positionsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND status = 'closed'`).all(userId);
}

/** Ratchets a trailing-stop position's stop_loss/high-water-mark — called every position-risk-
 *  watcher.js cycle for positions with trailing_percent set. Ownership-scoped like getPosition;
 *  updates nothing if the id/userId pair doesn't match an existing row. */
function updateTrailingStop(mode, userId, id, { stopLoss, highWaterMark }) {
  const db = getDb();
  const table = positionsTable(mode);
  db.prepare(`UPDATE ${table} SET stop_loss = ?, trailing_high_water_mark = ? WHERE id = ? AND user_id = ?`).run(stopLoss, highWaterMark, id, userId);
  return getPosition(mode, userId, id);
}

/** Seeds trailing_percent + trailing_high_water_mark on an adaptive-TP position the moment TP1
 *  fires (see position-risk-watcher.js#seedAdaptiveTrailing) — after this, the position behaves
 *  exactly like any other trailing-stop position to updateTrailingStop/computeSpotTrailingUpdate
 *  above, which don't know or care where trailing_percent came from. Ownership-scoped like
 *  getPosition. */
function seedTrailingPercent(mode, userId, id, { trailingPercent, highWaterMark }) {
  const db = getDb();
  const table = positionsTable(mode);
  db.prepare(`UPDATE ${table} SET trailing_percent = ?, trailing_high_water_mark = ? WHERE id = ? AND user_id = ?`).run(trailingPercent, highWaterMark, id, userId);
  return getPosition(mode, userId, id);
}

module.exports = {
  listOpenPositions,
  listAllOpenPositions,
  insertPosition,
  getPosition,
  findOpenPositionBySymbol,
  closePosition,
  sumRealizedPnlSince,
  sumAllRealizedPnl,
  countClosedByOutcome,
  listAllClosedPositions,
  listClosedPositions,
  updateTrailingStop,
  seedTrailingPercent,
  recordPartialExit,
};
