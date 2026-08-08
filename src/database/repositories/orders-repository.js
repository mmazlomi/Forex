'use strict';

const { getDb } = require('../connection');
const { ordersTable, assertTradingMode } = require('./mode-tables');

function insertOrder(mode, userId, order) {
  assertTradingMode(mode);
  const db = getDb();
  const table = ordersTable(mode);
  // node:sqlite's named-parameter binding throws on any object key not referenced in the SQL
  // (`ERR_INVALID_STATE: Unknown named parameter`), so each branch's defaults must exactly match
  // that branch's own placeholders — exchangeOrderId only exists on real_orders, never demo_orders.
  const commonDefaults = {
    filledAtUtc: null, signalId: null, realizedPnl: null,
    orderType: 'market', limitPrice: null, triggerPrice: null, ocoGroupId: null, cancelledAtUtc: null,
    exchange: null,
  };

  if (mode === 'real') {
    db.prepare(
      `INSERT INTO ${table} (
         id, user_id, symbol, side, qty, price, stop_loss, take_profit, status, reject_reason,
         idempotency_key, exchange_order_id, created_at_utc, filled_at_utc, signal_id, realized_pnl,
         order_type, limit_price, trigger_price, oco_group_id, cancelled_at_utc, exchange
       ) VALUES (
         @id, @userId, @symbol, @side, @qty, @price, @stopLoss, @takeProfit, @status, @rejectReason,
         @idempotencyKey, @exchangeOrderId, @createdAtUtc, @filledAtUtc, @signalId, @realizedPnl,
         @orderType, @limitPrice, @triggerPrice, @ocoGroupId, @cancelledAtUtc, @exchange
       )`
    ).run({ ...commonDefaults, exchangeOrderId: null, ...order, userId });
  } else {
    db.prepare(
      `INSERT INTO ${table} (
         id, user_id, symbol, side, qty, price, stop_loss, take_profit, status, reject_reason,
         idempotency_key, created_at_utc, filled_at_utc, signal_id, realized_pnl,
         order_type, limit_price, trigger_price, oco_group_id, cancelled_at_utc, exchange
       ) VALUES (
         @id, @userId, @symbol, @side, @qty, @price, @stopLoss, @takeProfit, @status, @rejectReason,
         @idempotencyKey, @createdAtUtc, @filledAtUtc, @signalId, @realizedPnl,
         @orderType, @limitPrice, @triggerPrice, @ocoGroupId, @cancelledAtUtc, @exchange
       )`
    ).run({ ...commonDefaults, ...order, userId });
  }
  return getOrder(mode, userId, order.id);
}

// Ownership-scoped: WHERE id = ? AND user_id = ? — a mismatched userId returns undefined, same as
// a nonexistent id, rather than leaking another user's order.
function getOrder(mode, userId, id) {
  const db = getDb();
  const table = ordersTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(id, userId);
}

function listOrders(mode, userId, { limit = 50, offset = 0, status } = {}) {
  const db = getDb();
  const table = ordersTable(mode);
  if (status) {
    return db
      .prepare(`SELECT * FROM ${table} WHERE user_id = ? AND status = ? ORDER BY created_at_utc DESC LIMIT ? OFFSET ?`)
      .all(userId, status, limit, offset);
  }
  return db
    .prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY created_at_utc DESC LIMIT ? OFFSET ?`)
    .all(userId, limit, offset);
}

// Deliberately NOT scoped by user_id — this is what pending-orders-watcher.js polls every cycle,
// and it's one shared background process that must see every account's pending orders, not just
// one user's (same documented exception as assets-repository.js's listAutoTradeEnabled). Each
// returned row still carries its own user_id, consumed downstream to resolve the right owner.
function listPendingOrders(mode) {
  const db = getDb();
  const table = ordersTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE status = 'pending' ORDER BY created_at_utc`).all();
}

/** The other leg of an OCO pair, if it's still pending — used to cancel it once one leg fills. */
function findOcoSibling(mode, userId, ocoGroupId, excludeId) {
  if (!ocoGroupId) return null;
  const db = getDb();
  const table = ordersTable(mode);
  return db
    .prepare(`SELECT * FROM ${table} WHERE user_id = ? AND oco_group_id = ? AND id != ? AND status = 'pending' LIMIT 1`)
    .get(userId, ocoGroupId, excludeId);
}

/**
 * Transitions a pending order to filled/cancelled/rejected. Ownership-scoped like getOrder — the
 * UPDATE's WHERE clause includes user_id, so a mismatched id/userId pair silently updates nothing
 * (getOrder afterward then correctly returns undefined) rather than touching another user's row.
 */
function updateOrderStatus(mode, userId, id, { status, filledAtUtc = null, cancelledAtUtc = null, realizedPnl = null, rejectReason = null, exchangeOrderId, price } = {}) {
  const db = getDb();
  const table = ordersTable(mode);
  const priceParam = price === undefined ? null : price;
  if (mode === 'real' && exchangeOrderId !== undefined) {
    db.prepare(`UPDATE ${table} SET status = ?, filled_at_utc = ?, cancelled_at_utc = ?, realized_pnl = ?, reject_reason = ?, exchange_order_id = ?, price = COALESCE(?, price) WHERE id = ? AND user_id = ?`)
      .run(status, filledAtUtc, cancelledAtUtc, realizedPnl, rejectReason, exchangeOrderId, priceParam, id, userId);
  } else {
    db.prepare(`UPDATE ${table} SET status = ?, filled_at_utc = ?, cancelled_at_utc = ?, realized_pnl = ?, reject_reason = ?, price = COALESCE(?, price) WHERE id = ? AND user_id = ?`)
      .run(status, filledAtUtc, cancelledAtUtc, realizedPnl, rejectReason, priceParam, id, userId);
  }
  return getOrder(mode, userId, id);
}

// Scoped by user_id — an idempotency key is only meaningful within one user's own order history;
// two different users legitimately submitting the same key value must not collide.
function findByIdempotencyKey(mode, userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const db = getDb();
  const table = ordersTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND idempotency_key = ?`).get(userId, idempotencyKey);
}

/**
 * Duplicate guard: same symbol+side+price submitted again within `windowMs`, scoped to this one
 * user — two different users' legitimately-similar orders on the same symbol/side/price must not
 * dedupe against each other. Excludes previously *rejected* orders — a rejected order was never
 * executed, so it must not block a legitimate retry.
 */
function findRecentSimilarOrder(mode, userId, { symbol, side, price, windowMs }) {
  const db = getDb();
  const table = ordersTable(mode);
  const cutoffUtc = new Date(Date.now() - windowMs).toISOString();
  return db
    .prepare(
      `SELECT * FROM ${table}
       WHERE user_id = ? AND symbol = ? AND side = ? AND price = ? AND created_at_utc >= ? AND status != 'rejected'
       ORDER BY created_at_utc DESC LIMIT 1`
    )
    .get(userId, symbol, side, price, cutoffUtc);
}

module.exports = {
  insertOrder, getOrder, listOrders, findByIdempotencyKey, findRecentSimilarOrder,
  listPendingOrders, findOcoSibling, updateOrderStatus,
};
