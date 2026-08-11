'use strict';

const { getDb } = require('../connection');

function listAssets(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM assets WHERE user_id = ? ORDER BY symbol').all(userId);
}

function getAsset(userId, symbol, exchange) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM assets WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .get(userId, symbol, exchange);
}

function addAsset(userId, { symbol, exchange, market = 'spot', assetType, defaultTimeframe = '1h', strategyId = 'balanced' }) {
  const db = getDb();
  const addedAtUtc = new Date().toISOString();
  db.prepare(
    `INSERT INTO assets (user_id, symbol, exchange, market, asset_type, default_timeframe, added_at_utc, strategy_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, symbol, exchange, market, assetType, defaultTimeframe, addedAtUtc, strategyId);
  return getAsset(userId, symbol, exchange);
}

function removeAsset(userId, symbol, exchange) {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM assets WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(userId, symbol, exchange);
  return result.changes > 0;
}

function setAutoTrade(userId, symbol, exchange, enabled) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET auto_trade_enabled = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(enabled ? 1 : 0, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Intentionally NOT scoped by user_id, even though Demo/Real portfolios, orders, positions, and
// risk settings are all per-user (see architecture.md's per-user isolation section) — the AI
// auto-trader itself is still one shared background process (a single scheduler, not one instance
// per user), so it must see every account's auto-trade-enabled watchlist entries in one query,
// then act on each using that row's own user_id. See auto-trader.js's processAsset.
function listAutoTradeEnabled() {
  const db = getDb();
  return db.prepare('SELECT * FROM assets WHERE auto_trade_enabled = 1').all();
}

function setStrategy(userId, symbol, exchange, strategyId) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET strategy_id = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(strategyId, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// default_timeframe drives both manual "Load"/Generate Signal defaults and — for auto-trade-
// enabled assets — which candle timeframe auto-trader.js actually analyzes on each cycle (see
// its generateSignal() call), so changing this genuinely changes what the AI auto-trader does
// for this asset, not just a display default.
function setTimeframe(userId, symbol, exchange, defaultTimeframe) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET default_timeframe = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(defaultTimeframe, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Moves this watchlist entry to a different exchange in place, instead of the user having to
// remove and re-add it (see addAsset's UNIQUE(user_id, symbol, exchange) — this is a real key
// change, not a plain field update like setStrategy/setTimeframe above). Caller is responsible
// for checking the destination (symbol, newExchange) isn't already on the watchlist and that the
// symbol actually exists there, since this only touches the DB row.
function setExchange(userId, symbol, oldExchange, newExchange) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET exchange = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(newExchange, userId, symbol, oldExchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, newExchange);
}

// One-time claim for pre-account watchlist rows (user_id IS NULL, left behind by the schema
// migration — see schema.js). Called once, only for the very first account ever created, so the
// original single-user watchlist isn't silently orphaned/invisible once accounts exist.
function claimOrphanedAssets(userId) {
  const db = getDb();
  db.prepare('UPDATE assets SET user_id = ? WHERE user_id IS NULL').run(userId);
}

// 'manual' (default, unchanged behavior) keeps using the single strategy_id above via
// auto-trader.js's existing path. 'auto' opts this asset into the strategy-selector scheduler
// (src/services/scheduler/strategy-selector.js), which periodically backtests every built-in
// strategy and fills in selected_strategy_ids_json below — auto-trader.js then combines those
// selected strategies' live signals via majority vote instead of using strategy_id at all.
// Switching back to 'manual' does not clear a prior selection (selected_strategy_ids_json is
// simply ignored while in 'manual' mode), so flipping back to 'auto' later resumes from what was
// last selected rather than starting cold.
function setStrategyMode(userId, symbol, exchange, mode) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET strategy_mode = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(mode, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Called only by strategy-selector.js's runCycle() after a successful backtest ranking —
// strategyIds is stored as JSON (SQLite has no native array type) alongside a fresh timestamp so
// the Watchlist tab can show "last evaluated" next to the current selection.
function setSelectedStrategies(userId, symbol, exchange, strategyIds) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET selected_strategy_ids_json = ?, strategy_selection_updated_at_utc = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(JSON.stringify(strategyIds), new Date().toISOString(), userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Intentionally NOT scoped by user_id — same documented exception as listAutoTradeEnabled()
// above: strategy-selector.js is one shared background scheduler that must see every account's
// auto-mode assets in one query, then act on each using that row's own user_id.
function listAutoStrategyModeAssets() {
  const db = getDb();
  return db.prepare("SELECT * FROM assets WHERE strategy_mode = 'auto'").all();
}

module.exports = {
  listAssets, getAsset, addAsset, removeAsset, setAutoTrade, listAutoTradeEnabled, setStrategy, setTimeframe,
  setExchange, setStrategyMode, setSelectedStrategies, listAutoStrategyModeAssets,
  claimOrphanedAssets,
};
