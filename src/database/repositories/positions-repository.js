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
  const result = db
    .prepare(
      `INSERT INTO ${table} (user_id, symbol, exchange, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, status)
       VALUES (@userId, @symbol, @exchange, @side, @qty, @entryPrice, @stopLoss, @takeProfit, @openedAtUtc, 'open')`
    )
    .run({ exchange: null, ...position, userId });
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

function closePosition(mode, userId, id, { exitPrice, realizedPnl }) {
  const db = getDb();
  const table = positionsTable(mode);
  db.prepare(
    `UPDATE ${table} SET status = 'closed', exit_price = ?, realized_pnl = ?, closed_at_utc = ? WHERE id = ? AND user_id = ?`
  ).run(exitPrice, realizedPnl, new Date().toISOString(), id, userId);
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
  listClosedPositions,
};
