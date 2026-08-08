'use strict';

const { getDb } = require('../connection');
const { futuresOrdersTable, assertTradingMode } = require('./mode-tables');

function insertOrder(mode, userId, order) {
  assertTradingMode(mode);
  const db = getDb();
  const table = futuresOrdersTable(mode);
  // Same node:sqlite named-parameter-binding constraint as orders-repository.js (a key not
  // referenced by the branch's own SQL throws ERR_INVALID_STATE) — per-branch defaults, mirrored.
  const commonDefaults = {
    filledAtUtc: null, signalId: null, realizedPnl: null, source: 'manual',
  };

  if (mode === 'real') {
    db.prepare(
      `INSERT INTO ${table} (
         id, user_id, symbol, exchange, action, leverage, qty, price, stop_loss, take_profit, status,
         reject_reason, idempotency_key, exchange_order_id, created_at_utc, filled_at_utc,
         signal_id, realized_pnl, source
       ) VALUES (
         @id, @userId, @symbol, @exchange, @action, @leverage, @qty, @price, @stopLoss, @takeProfit, @status,
         @rejectReason, @idempotencyKey, @exchangeOrderId, @createdAtUtc, @filledAtUtc,
         @signalId, @realizedPnl, @source
       )`
    ).run({ ...commonDefaults, exchangeOrderId: null, ...order, userId });
  } else {
    db.prepare(
      `INSERT INTO ${table} (
         id, user_id, symbol, exchange, action, leverage, qty, price, stop_loss, take_profit, status,
         reject_reason, idempotency_key, created_at_utc, filled_at_utc, signal_id, realized_pnl, source
       ) VALUES (
         @id, @userId, @symbol, @exchange, @action, @leverage, @qty, @price, @stopLoss, @takeProfit, @status,
         @rejectReason, @idempotencyKey, @createdAtUtc, @filledAtUtc, @signalId, @realizedPnl, @source
       )`
    ).run({ ...commonDefaults, ...order, userId });
  }
  return getOrder(mode, userId, order.id);
}

// Ownership-scoped: WHERE id = ? AND user_id = ? — a mismatched userId returns undefined, same as
// a nonexistent id, rather than leaking another user's order.
function getOrder(mode, userId, id) {
  const db = getDb();
  const table = futuresOrdersTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(id, userId);
}

function listOrders(mode, userId, { limit = 50, offset = 0, status } = {}) {
  const db = getDb();
  const table = futuresOrdersTable(mode);
  if (status) {
    return db
      .prepare(`SELECT * FROM ${table} WHERE user_id = ? AND status = ? ORDER BY created_at_utc DESC LIMIT ? OFFSET ?`)
      .all(userId, status, limit, offset);
  }
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY created_at_utc DESC LIMIT ? OFFSET ?`).all(userId, limit, offset);
}

// Scoped by user_id — an idempotency key is only meaningful within one user's own order history.
function findByIdempotencyKey(mode, userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const db = getDb();
  const table = futuresOrdersTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND idempotency_key = ?`).get(userId, idempotencyKey);
}

/** Duplicate guard: same symbol+action+price submitted again within windowMs, scoped to this one
 *  user (mirrors orders-repository.js's findRecentSimilarOrder, keyed on `action` instead of `side`). */
function findRecentSimilarOrder(mode, userId, { symbol, action, price, windowMs }) {
  const db = getDb();
  const table = futuresOrdersTable(mode);
  const cutoffUtc = new Date(Date.now() - windowMs).toISOString();
  return db
    .prepare(
      `SELECT * FROM ${table}
       WHERE user_id = ? AND symbol = ? AND action = ? AND price = ? AND created_at_utc >= ? AND status != 'rejected'
       ORDER BY created_at_utc DESC LIMIT 1`
    )
    .get(userId, symbol, action, price, cutoffUtc);
}

module.exports = { insertOrder, getOrder, listOrders, findByIdempotencyKey, findRecentSimilarOrder };
