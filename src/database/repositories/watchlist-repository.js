'use strict';

const { getDb } = require('../connection');

function listItems(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM watchlist_items WHERE user_id = ? ORDER BY symbol').all(userId);
}

function getItem(userId, symbol, exchange) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM watchlist_items WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .get(userId, symbol, exchange);
}

function addItem(userId, { symbol, exchange, assetType }) {
  const db = getDb();
  const addedAtUtc = new Date().toISOString();
  db.prepare(
    `INSERT INTO watchlist_items (user_id, symbol, exchange, asset_type, added_at_utc)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, symbol, exchange, assetType, addedAtUtc);
  return getItem(userId, symbol, exchange);
}

function removeItem(userId, symbol, exchange) {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM watchlist_items WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(userId, symbol, exchange);
  return result.changes > 0;
}

module.exports = { listItems, getItem, addItem, removeItem };
