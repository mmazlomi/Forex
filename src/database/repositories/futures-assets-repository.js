'use strict';

const { getDb } = require('../connection');
const { futuresAssetsTable } = require('./mode-tables');

function listAssets(mode, userId) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY symbol`).all(userId);
}

function getAsset(mode, userId, symbol, exchange) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND symbol = ? AND exchange = ?`).get(userId, symbol, exchange);
}

function addAsset(mode, userId, { symbol, exchange = 'kucoin', leverage = 3, strategyId = 'balanced', defaultTimeframe = '1h' }) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  const addedAtUtc = new Date().toISOString();
  db.prepare(
    `INSERT INTO ${table} (user_id, symbol, exchange, leverage, strategy_id, default_timeframe, added_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, symbol, exchange, leverage, strategyId, defaultTimeframe, addedAtUtc);
  return getAsset(mode, userId, symbol, exchange);
}

function removeAsset(mode, userId, symbol, exchange) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  const result = db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND symbol = ? AND exchange = ?`).run(userId, symbol, exchange);
  return result.changes > 0;
}

// A single flag now, not two — mode itself (which table this reads/writes) already expresses
// Demo vs Real. Enabling this on the real_futures_assets table is a symbol's per-asset opt-in
// into real auto-trading; it only actually takes effect if the server-wide
// ENABLE_FUTURES_AUTO_TRADING env flag is also set (checked in futures-auto-trader.js).
function setAutoTrade(mode, userId, symbol, exchange, enabled) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  const result = db
    .prepare(`UPDATE ${table} SET auto_trade_enabled = ? WHERE user_id = ? AND symbol = ? AND exchange = ?`)
    .run(enabled ? 1 : 0, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(mode, userId, symbol, exchange);
}

function setLeverage(mode, userId, symbol, exchange, leverage) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  const result = db
    .prepare(`UPDATE ${table} SET leverage = ? WHERE user_id = ? AND symbol = ? AND exchange = ?`)
    .run(leverage, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(mode, userId, symbol, exchange);
}

// Not scoped by user_id, same reasoning as assets-repository.js's listAutoTradeEnabled(): there
// is one shared background futures auto-trader, which must see every account's enabled rows.
function listAutoTradeEnabled(mode) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE auto_trade_enabled = 1`).all();
}

function setStrategy(mode, userId, symbol, exchange, strategyId) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  const result = db
    .prepare(`UPDATE ${table} SET strategy_id = ? WHERE user_id = ? AND symbol = ? AND exchange = ?`)
    .run(strategyId, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(mode, userId, symbol, exchange);
}

// Same effect as assets-repository.js's setTimeframe(): drives which candle timeframe
// futures-auto-trader.js actually analyzes for this asset on each cycle, not just a display default.
function setTimeframe(mode, userId, symbol, exchange, defaultTimeframe) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  const result = db
    .prepare(`UPDATE ${table} SET default_timeframe = ? WHERE user_id = ? AND symbol = ? AND exchange = ?`)
    .run(defaultTimeframe, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(mode, userId, symbol, exchange);
}

// Same effect as assets-repository.js's setStrategyMode()/setSelectedStrategies() — see those
// comments. Demo and Real each opt into 'auto' mode independently, exactly like every other
// per-asset setting on these fully-separate watchlists.
function setStrategyMode(mode, userId, symbol, exchange, strategyMode) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  const result = db
    .prepare(`UPDATE ${table} SET strategy_mode = ? WHERE user_id = ? AND symbol = ? AND exchange = ?`)
    .run(strategyMode, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(mode, userId, symbol, exchange);
}

function setSelectedStrategies(mode, userId, symbol, exchange, strategyIds) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  const result = db
    .prepare(`UPDATE ${table} SET selected_strategy_ids_json = ?, strategy_selection_updated_at_utc = ? WHERE user_id = ? AND symbol = ? AND exchange = ?`)
    .run(JSON.stringify(strategyIds), new Date().toISOString(), userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(mode, userId, symbol, exchange);
}

// Not scoped by user_id, same reasoning as listAutoTradeEnabled() above — strategy-selector.js
// needs every account's auto-mode rows for this mode in one query.
function listAutoStrategyModeAssets(mode) {
  const db = getDb();
  const table = futuresAssetsTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE strategy_mode = 'auto'`).all();
}

module.exports = {
  listAssets, getAsset, addAsset, removeAsset, setAutoTrade, setLeverage,
  listAutoTradeEnabled, setStrategy, setTimeframe,
  setStrategyMode, setSelectedStrategies, listAutoStrategyModeAssets,
};
