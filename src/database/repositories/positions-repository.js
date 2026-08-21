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
  const result = db
    .prepare(
      `INSERT INTO ${table} (user_id, symbol, exchange, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, status, signal_id, strategy_id, combined_strategy_ids_json, combined_votes_json, source, timeframe, trailing_percent, trailing_high_water_mark, initial_stop_loss)
       VALUES (@userId, @symbol, @exchange, @side, @qty, @entryPrice, @stopLoss, @takeProfit, @openedAtUtc, 'open', @signalId, @strategyId, @combinedStrategyIdsJson, @combinedVotesJson, @source, @timeframe, @trailingPercent, @trailingHighWaterMark, @stopLoss)`
    )
    .run({
      exchange: null,
      signalId: null, strategyId: null, combinedStrategyIdsJson: null, combinedVotesJson: null, source: 'manual', timeframe: null,
      trailingPercent: null, trailingHighWaterMark: null,
      ...position, userId,
    });
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(result.lastInsertRowid);
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
};
