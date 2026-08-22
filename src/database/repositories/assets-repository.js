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

// A separate, explicit opt-in from auto_trade_enabled above — see schema.js's
// migrateAddRealAutoTradeColumn comment for why spot has two flags on one shared table instead of
// futures' fully-split demo/real tables. Currently only read by reversal-spot-auto-trader.js.
function setRealAutoTrade(userId, symbol, exchange, enabled) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET real_auto_trade_enabled = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(enabled ? 1 : 0, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Same "one shared scheduler, not scoped by user_id" reasoning as listAutoTradeEnabled() above.
function listRealAutoTradeEnabled() {
  const db = getDb();
  return db.prepare('SELECT * FROM assets WHERE real_auto_trade_enabled = 1').all();
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

// Per-asset default trailing-stop distance (percent of price), inherited by a position opened
// from this asset (manually via "Trade from Signal", or by AI Auto-Trade) unless the order itself
// explicitly overrides it. Null (the default) means trailing is off — same "absence = off"
// convention as every other opt-in flag on this table. trailingMode 'atr' means trailingPercent is
// ignored (should be passed as null) — see risk/atr-trailing.js — and a fresh volatility-based
// percent is computed each time a position is opened from this asset instead.
function setTrailingPercent(userId, symbol, exchange, trailingPercent, trailingMode = 'fixed') {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET trailing_percent = ?, trailing_mode = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(trailingPercent, trailingMode, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Opt-in flag for adaptive-take-profit-resolver.js — see schema.js#migrateAddAssetAdaptiveTpColumn.
// Off by default; an asset that never opts in sees zero behavior change from the fixed-formula
// take-profit it already had.
function setAdaptiveTpEnabled(userId, symbol, exchange, enabled) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET adaptive_tp_enabled = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(enabled ? 1 : 0, userId, symbol, exchange);
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

// LSR timeframe selection — orthogonal to strategy_mode/selected_strategy_ids_json above (an LSR
// asset never uses those at all). 'manual' (default) keeps using the global 4h/15m/5m default, or
// this asset's own lsr_htf_timeframe/lsr_signal_timeframe/lsr_entry_timeframe override if set.
// 'auto' opts this asset into lsr-timeframe-selector.js, which periodically backtests a set of
// candidate timeframe triples and fills in lsr_selected_timeframes_json below. Switching back to
// 'manual' does not clear a prior selection, same convention as setStrategyMode.
function setLsrTimeframeMode(userId, symbol, exchange, mode) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET lsr_timeframe_mode = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(mode, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Manual per-asset timeframe override (used only while lsr_timeframe_mode='manual') — each field
// null clears that override back to the global default; only present keys are updated.
function setLsrManualTimeframes(userId, symbol, exchange, { htfTimeframe, signalTimeframe, entryTimeframe }) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET lsr_htf_timeframe = ?, lsr_signal_timeframe = ?, lsr_entry_timeframe = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(htfTimeframe ?? null, signalTimeframe ?? null, entryTimeframe ?? null, userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Called only by lsr-timeframe-selector.js's runCycle() after a successful backtest ranking —
// same "JSON blob + fresh timestamp" shape as setSelectedStrategies above.
function setLsrSelectedTimeframes(userId, symbol, exchange, timeframes) {
  const db = getDb();
  const result = db
    .prepare('UPDATE assets SET lsr_selected_timeframes_json = ?, lsr_timeframe_selection_updated_at_utc = ? WHERE user_id = ? AND symbol = ? AND exchange = ?')
    .run(JSON.stringify(timeframes), new Date().toISOString(), userId, symbol, exchange);
  if (result.changes === 0) return null;
  return getAsset(userId, symbol, exchange);
}

// Not scoped by user_id — same shared-background-scheduler exception as listAutoStrategyModeAssets.
function listLsrAutoTimeframeModeAssets() {
  const db = getDb();
  return db.prepare("SELECT * FROM assets WHERE lsr_timeframe_mode = 'auto'").all();
}

module.exports = {
  listAssets, getAsset, addAsset, removeAsset, setAutoTrade, listAutoTradeEnabled, setStrategy, setTimeframe,
  setExchange, setStrategyMode, setSelectedStrategies, listAutoStrategyModeAssets,
  claimOrphanedAssets, setRealAutoTrade, listRealAutoTradeEnabled, setTrailingPercent,
  setLsrTimeframeMode, setLsrManualTimeframes, setLsrSelectedTimeframes, listLsrAutoTimeframeModeAssets,
  setAdaptiveTpEnabled,
};
