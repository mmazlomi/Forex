'use strict';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at_utc TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- One row per user (user_id itself is the PK) — each account stores its own Real Trading API
-- key/secret independently. api_key/api_secret are stored encrypted (see
-- src/services/security/secret-encryption.js), never in plaintext. Was a single shared singleton
-- row before per-user isolation; see migrateRealExchangeCredentialsUserId below.
CREATE TABLE IF NOT EXISTS real_exchange_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  exchange_name TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  api_secret_encrypted TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'spot',
  asset_type TEXT NOT NULL CHECK (asset_type IN ('crypto','stock')),
  default_timeframe TEXT NOT NULL DEFAULT '1h',
  added_at_utc TEXT NOT NULL,
  auto_trade_enabled INTEGER NOT NULL DEFAULT 0,
  strategy_id TEXT NOT NULL DEFAULT 'balanced',
  strategy_mode TEXT NOT NULL DEFAULT 'manual',
  selected_strategy_ids_json TEXT,
  strategy_selection_updated_at_utc TEXT,
  UNIQUE(user_id, symbol, exchange)
);

CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts_utc INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, exchange, timeframe, ts_utc)
);

CREATE TABLE IF NOT EXISTS fundamentals_cache (
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  field_group TEXT NOT NULL,
  data_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  fetched_at_utc TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL,
  PRIMARY KEY (symbol, asset_type, field_group)
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts_utc TEXT NOT NULL,
  price REAL,
  technical_score REAL,
  fundamental_score REAL,
  final_score REAL,
  status TEXT NOT NULL CHECK (status IN ('BUY','SELL','HOLD','NO_DATA')),
  confidence REAL,
  reasons_json TEXT,
  technical_summary_json TEXT,
  fundamental_summary_json TEXT,
  entry REAL,
  stop_loss REAL,
  take_profit REAL,
  risk_reward_ratio REAL,
  data_quality TEXT,
  warnings_json TEXT,
  strategy_version TEXT NOT NULL,
  strategy_id TEXT,
  source_mode TEXT NOT NULL CHECK (source_mode IN ('backtest','demo','real')),
  combined_strategy_ids_json TEXT,
  combined_votes_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_ts ON signals(symbol, ts_utc);

CREATE TABLE IF NOT EXISTS risk_settings (
  user_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('demo','real')),
  max_risk_per_trade_percent REAL NOT NULL,
  max_daily_loss_percent REAL NOT NULL,
  max_open_positions INTEGER NOT NULL,
  max_order_value REAL NOT NULL,
  min_risk_reward_ratio REAL NOT NULL,
  max_portfolio_exposure_percent REAL NOT NULL,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (user_id, mode)
);

-- Futures-specific risk settings, separate from risk_settings (spot) because futures needs a
-- max_leverage field spot has no concept of, and a leveraged account's other limits (order
-- value, exposure percent) reasonably differ from spot's.
CREATE TABLE IF NOT EXISTS futures_risk_settings (
  user_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('demo','real')),
  max_risk_per_trade_percent REAL NOT NULL,
  max_daily_loss_percent REAL NOT NULL,
  max_open_positions INTEGER NOT NULL,
  max_order_value REAL NOT NULL,
  min_risk_reward_ratio REAL NOT NULL,
  max_portfolio_exposure_percent REAL NOT NULL,
  max_leverage REAL NOT NULL,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (user_id, mode)
);

-- Split into two tables rather than a nullable user_id in one: SQLite treats multiple NULLs in a
-- UNIQUE/PK column as distinct, so an ON CONFLICT upsert for a "global, no owner" row would
-- insert a duplicate on every single toggle instead of updating the same row. emergency_stop_global
-- is a genuine instance-wide admin panic button (any logged-in user may trigger/reset it — no
-- role/admin system exists in this app) that halts everyone regardless of their own per-user
-- state; emergency_stop_user holds each account's own demo/real stop.
CREATE TABLE IF NOT EXISTS emergency_stop_global (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  activated_at_utc TEXT,
  reset_at_utc TEXT
);

CREATE TABLE IF NOT EXISTS emergency_stop_user (
  user_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK (scope IN ('demo','real')),
  active INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  activated_at_utc TEXT,
  reset_at_utc TEXT,
  PRIMARY KEY (user_id, scope)
);

CREATE TABLE IF NOT EXISTS demo_portfolio (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance REAL NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_positions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  opened_at_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_price REAL,
  closed_at_utc TEXT,
  realized_pnl REAL
);

CREATE TABLE IF NOT EXISTS demo_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  idempotency_key TEXT,
  created_at_utc TEXT NOT NULL,
  filled_at_utc TEXT,
  signal_id TEXT REFERENCES signals(id),
  realized_pnl REAL,
  order_type TEXT NOT NULL DEFAULT 'market',
  limit_price REAL,
  trigger_price REAL,
  oco_group_id TEXT,
  cancelled_at_utc TEXT,
  exchange TEXT
);

CREATE TABLE IF NOT EXISTS real_portfolio (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance REAL NOT NULL,
  wallet_balances_json TEXT,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS real_positions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  opened_at_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_price REAL,
  closed_at_utc TEXT,
  realized_pnl REAL
);

CREATE TABLE IF NOT EXISTS real_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  idempotency_key TEXT,
  exchange_order_id TEXT,
  created_at_utc TEXT NOT NULL,
  filled_at_utc TEXT,
  signal_id TEXT REFERENCES signals(id),
  realized_pnl REAL,
  order_type TEXT NOT NULL DEFAULT 'market',
  limit_price REAL,
  trigger_price REAL,
  oco_group_id TEXT,
  cancelled_at_utc TEXT,
  exchange TEXT
);

CREATE TABLE IF NOT EXISTS real_audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  order_id TEXT,
  request_json TEXT,
  response_json TEXT,
  created_at_utc TEXT NOT NULL
);

-- Phase 2 (Futures, KuCoin-only): fully separate tables from demo_*/real_* spot tables, not a
-- shared table with a mode column — same demo_X/real_X-pair convention as the rest of this file,
-- resolved through mode-tables.js. Kept separate because futures symbols use a different ccxt
-- format (BASE/QUOTE:SETTLE) and carry concepts (leverage, margin, liquidation) spot never had —
-- see docs/architecture.md Phase 2 section.
CREATE TABLE IF NOT EXISTS demo_futures_portfolio (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance REAL NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_futures_positions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  leverage REAL NOT NULL,
  margin_mode TEXT NOT NULL DEFAULT 'isolated',
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  liquidation_price REAL,
  stop_loss REAL,
  take_profit REAL,
  opened_at_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_price REAL,
  closed_at_utc TEXT,
  realized_pnl REAL
);

CREATE TABLE IF NOT EXISTS demo_futures_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('open_long','open_short','close')),
  leverage REAL NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  idempotency_key TEXT,
  created_at_utc TEXT NOT NULL,
  filled_at_utc TEXT,
  signal_id TEXT REFERENCES signals(id),
  realized_pnl REAL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto'))
);

CREATE TABLE IF NOT EXISTS real_futures_portfolio (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance REAL NOT NULL,
  wallet_balances_json TEXT,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS real_futures_positions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  leverage REAL NOT NULL,
  margin_mode TEXT NOT NULL DEFAULT 'isolated',
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  liquidation_price REAL,
  stop_loss REAL,
  take_profit REAL,
  opened_at_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_price REAL,
  closed_at_utc TEXT,
  realized_pnl REAL
);

CREATE TABLE IF NOT EXISTS real_futures_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('open_long','open_short','close')),
  leverage REAL NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  idempotency_key TEXT,
  exchange_order_id TEXT,
  created_at_utc TEXT NOT NULL,
  filled_at_utc TEXT,
  signal_id TEXT REFERENCES signals(id),
  realized_pnl REAL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto'))
);

-- Futures-specific watchlists, mirroring 'assets' (spot) but genuinely SEPARATE per mode —
-- demo_futures_assets and real_futures_assets can hold entirely different symbols, same
-- demo_X/real_X convention as every other Phase 2 table (positions/orders/portfolio), resolved
-- via mode-tables.js's futuresAssetsTable(mode). A symbol being on the real list at all, with its
-- own auto_trade_enabled=1, IS the per-symbol real-auto-trade opt-in — it only takes effect if the
-- server-wide ENABLE_FUTURES_AUTO_TRADING env flag is also set (layered consent, checked in
-- futures-auto-trader.js). Previously a single shared table with two flags on one row; split after
-- the user explicitly asked for fully independent Demo/Real watchlists (see
-- migrateFuturesAssetsSplit below for the one-time migration off the old shape).
CREATE TABLE IF NOT EXISTS demo_futures_assets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'kucoin',
  leverage REAL NOT NULL DEFAULT 3,
  strategy_id TEXT NOT NULL DEFAULT 'balanced',
  default_timeframe TEXT NOT NULL DEFAULT '1h',
  added_at_utc TEXT NOT NULL,
  auto_trade_enabled INTEGER NOT NULL DEFAULT 0,
  strategy_mode TEXT NOT NULL DEFAULT 'manual',
  selected_strategy_ids_json TEXT,
  strategy_selection_updated_at_utc TEXT,
  UNIQUE(user_id, symbol, exchange)
);

CREATE TABLE IF NOT EXISTS real_futures_assets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'kucoin',
  leverage REAL NOT NULL DEFAULT 3,
  strategy_id TEXT NOT NULL DEFAULT 'balanced',
  default_timeframe TEXT NOT NULL DEFAULT '1h',
  added_at_utc TEXT NOT NULL,
  auto_trade_enabled INTEGER NOT NULL DEFAULT 0,
  strategy_mode TEXT NOT NULL DEFAULT 'manual',
  selected_strategy_ids_json TEXT,
  strategy_selection_updated_at_utc TEXT,
  UNIQUE(user_id, symbol, exchange)
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  initial_capital REAL NOT NULL,
  fee_percent REAL NOT NULL,
  slippage_percent REAL NOT NULL,
  strategy_version TEXT NOT NULL,
  strategy_id TEXT,
  created_at_utc TEXT NOT NULL,
  metrics_json TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES backtest_runs(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL,
  qty REAL NOT NULL,
  entered_at_utc TEXT NOT NULL,
  exited_at_utc TEXT,
  pnl REAL,
  signal_id TEXT REFERENCES signals(id),
  exit_reason TEXT
);

CREATE TABLE IF NOT EXISTS backtest_equity_curve (
  run_id TEXT NOT NULL REFERENCES backtest_runs(id),
  ts_utc TEXT NOT NULL,
  equity REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL,
  mode TEXT,
  category TEXT,
  message TEXT NOT NULL,
  meta_json TEXT,
  created_at_utc TEXT NOT NULL
);
`;

// One-time migration for databases created before user accounts existed: `assets` originally
// had no `user_id` column and a table-level UNIQUE(symbol, exchange) constraint (global, not
// per-owner). SQLite's ALTER TABLE can add a column but cannot change an existing UNIQUE
// constraint, so bringing an old `assets` table up to the current schema (UNIQUE(user_id,
// symbol, exchange), so two different accounts can each watch the same symbol) requires the
// standard SQLite rebuild-and-copy pattern, done once, transactionally. A brand-new database
// never hits this — CREATE TABLE IF NOT EXISTS above already creates `assets` with the final
// shape, so `user_id` is present from the start and this function is a no-op.
function migrateAssetsUserId(db) {
  const columns = db.prepare('PRAGMA table_info(assets)').all();
  const hasUserId = columns.some((c) => c.name === 'user_id');
  if (hasUserId) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE assets RENAME TO assets_pre_auth_migration');
    db.exec(`
      CREATE TABLE assets (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        market TEXT NOT NULL DEFAULT 'spot',
        asset_type TEXT NOT NULL CHECK (asset_type IN ('crypto','stock')),
        default_timeframe TEXT NOT NULL DEFAULT '1h',
        added_at_utc TEXT NOT NULL,
        auto_trade_enabled INTEGER NOT NULL DEFAULT 0,
        strategy_id TEXT NOT NULL DEFAULT 'balanced',
        UNIQUE(user_id, symbol, exchange)
      )
    `);
    db.exec(`
      INSERT INTO assets (id, user_id, symbol, exchange, market, asset_type, default_timeframe, added_at_utc, auto_trade_enabled, strategy_id)
      SELECT id, NULL, symbol, exchange, market, asset_type, default_timeframe, added_at_utc, auto_trade_enabled, strategy_id
      FROM assets_pre_auth_migration
    `);
    db.exec('DROP TABLE assets_pre_auth_migration');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// One-time migration for databases created before per-currency wallet balances existed:
// CREATE TABLE IF NOT EXISTS above only takes effect for a brand-new real_portfolio table, so an
// existing one needs its new (nullable, so no backfill needed) column added explicitly.
function migrateRealPortfolioWalletBalances(db) {
  const columns = db.prepare('PRAGMA table_info(real_portfolio)').all();
  const hasColumn = columns.some((c) => c.name === 'wallet_balances_json');
  if (hasColumn) return;
  db.exec('ALTER TABLE real_portfolio ADD COLUMN wallet_balances_json TEXT');
}

// One-time migration for databases created before automatic multi-strategy selection existed:
// assets/demo_futures_assets/real_futures_assets each gain strategy_mode ('manual', the existing
// single-strategy_id behavior unchanged for every pre-existing row, or 'auto', opted into
// per-row via the Watchlist tab), plus two nullable columns the strategy-selector scheduler
// fills in once it's run at least one successful backtest cycle for that asset. No backfill
// needed beyond strategy_mode's own DEFAULT 'manual' (applied automatically to existing rows by
// ALTER TABLE ADD COLUMN ... DEFAULT).
function migrateAddStrategySelectionColumns(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === 'strategy_mode')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN strategy_mode TEXT NOT NULL DEFAULT 'manual'`);
  }
  if (!columns.some((c) => c.name === 'selected_strategy_ids_json')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN selected_strategy_ids_json TEXT`);
  }
  if (!columns.some((c) => c.name === 'strategy_selection_updated_at_utc')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN strategy_selection_updated_at_utc TEXT`);
  }
}

// Companion to migrateAddStrategySelectionColumns above: signals persisted by the new combined
// (majority-vote) signal path record which strategies contributed and how each voted, for full
// transparency beyond the single strategy_id column (which still gets set to a synthetic joined
// string like "trend-following+momentum" for existing single-string display paths).
function migrateAddCombinedSignalColumns(db) {
  const columns = db.prepare('PRAGMA table_info(signals)').all();
  if (!columns.some((c) => c.name === 'combined_strategy_ids_json')) {
    db.exec('ALTER TABLE signals ADD COLUMN combined_strategy_ids_json TEXT');
  }
  if (!columns.some((c) => c.name === 'combined_votes_json')) {
    db.exec('ALTER TABLE signals ADD COLUMN combined_votes_json TEXT');
  }
}

// One-time migration for databases created before order types (Limit/Stop-Market/Stop-Limit/OCO)
// existed: demo_orders/real_orders originally had no concept of anything but a Market order.
// order_type defaults every existing row to 'market' (correct — every pre-existing order really
// was one), the rest are nullable so no backfill is needed. Applied to both tables since they're
// structurally identical. `exchange` is included here too — orders never needed to remember it
// before (a market order fills synchronously in the same request that already has `exchange` as
// a parameter), but a *pending* order sitting in the DB across polling cycles needs to know which
// exchange to check price against; nullable since existing (already-filled) rows genuinely don't
// have this information and there's nothing to backfill it from.
function migrateOrdersOrderType(db) {
  for (const table of ['demo_orders', 'real_orders']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const names = new Set(columns.map((c) => c.name));
    if (!names.has('order_type')) db.exec(`ALTER TABLE ${table} ADD COLUMN order_type TEXT NOT NULL DEFAULT 'market'`);
    if (!names.has('limit_price')) db.exec(`ALTER TABLE ${table} ADD COLUMN limit_price REAL`);
    if (!names.has('trigger_price')) db.exec(`ALTER TABLE ${table} ADD COLUMN trigger_price REAL`);
    if (!names.has('oco_group_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN oco_group_id TEXT`);
    if (!names.has('cancelled_at_utc')) db.exec(`ALTER TABLE ${table} ADD COLUMN cancelled_at_utc TEXT`);
    if (!names.has('exchange')) db.exec(`ALTER TABLE ${table} ADD COLUMN exchange TEXT`);
  }
}

// One-time migration for databases created before the Futures watchlist was split into fully
// independent Demo/Real lists: the old `futures_assets` table had ONE row per symbol with two
// flags (auto_trade_enabled for Demo, real_auto_trade_enabled for Real) — this copies each row
// into the new demo_futures_assets table (every pre-existing row becomes a Demo entry, since
// Demo was always the safe, always-on-by-default half) and, if it also had
// real_auto_trade_enabled set, ALSO inserts a corresponding row into real_futures_assets
// (auto_trade_enabled=1) — preserving that it was already opted into real auto-trading. A brand
// new database never hits this — CREATE TABLE IF NOT EXISTS above never creates the old
// `futures_assets` table at all, so this is a no-op there.
function migrateFuturesAssetsSplit(db) {
  const oldTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='futures_assets'").all();
  if (oldTable.length === 0) return;

  const rows = db.prepare('SELECT * FROM futures_assets').all();
  const insertDemo = db.prepare(
    `INSERT OR IGNORE INTO demo_futures_assets (user_id, symbol, exchange, leverage, strategy_id, default_timeframe, added_at_utc, auto_trade_enabled)
     VALUES (@userId, @symbol, @exchange, @leverage, @strategyId, @defaultTimeframe, @addedAtUtc, @autoTradeEnabled)`
  );
  const insertReal = db.prepare(
    `INSERT OR IGNORE INTO real_futures_assets (user_id, symbol, exchange, leverage, strategy_id, default_timeframe, added_at_utc, auto_trade_enabled)
     VALUES (@userId, @symbol, @exchange, @leverage, @strategyId, @defaultTimeframe, @addedAtUtc, 1)`
  );

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const shared = {
        userId: row.user_id, symbol: row.symbol, exchange: row.exchange, leverage: row.leverage,
        strategyId: row.strategy_id, defaultTimeframe: row.default_timeframe, addedAtUtc: row.added_at_utc,
      };
      insertDemo.run({ ...shared, autoTradeEnabled: row.auto_trade_enabled });
      if (row.real_auto_trade_enabled) {
        insertReal.run(shared);
      }
    }
    db.exec('DROP TABLE futures_assets');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Shared owner-resolution helper for every per-user migration below. Existing shared rows
// (portfolio balance, positions, orders, credentials, risk settings, emergency stop) are assigned
// to this one legacy account — the only account with real trading history before per-user
// isolation shipped. A DB with no such user (fresh install, test DB) resolves to null, and every
// migration below treats that as "nothing to backfill," not an error.
const LEGACY_DATA_OWNER_USERNAME = 'hoseini';
function resolveLegacyDataOwnerId(db) {
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(LEGACY_DATA_OWNER_USERNAME);
  return row ? row.id : null;
}

// Category A: additive nullable user_id column, no PK/CHECK change. Covers demo_positions,
// real_positions, demo_orders, real_orders, demo_futures_positions, real_futures_positions,
// demo_futures_orders, real_futures_orders, real_audit_log — all originally had no owner concept
// at all (one shared account for every login).
function migrateAddUserIdColumn(db, table, legacyOwnerId) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === 'user_id')) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER REFERENCES users(id)`);
  if (legacyOwnerId != null) {
    db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(legacyOwnerId);
  }
}

// Category B: singleton portfolio (id INTEGER PRIMARY KEY CHECK (id = 1)) -> one row per user
// (user_id itself the PK). Covers demo_portfolio, real_portfolio, demo_futures_portfolio,
// real_futures_portfolio. SQLite can't ALTER a PRIMARY KEY/CHECK constraint in place, so this is
// the standard rebuild-and-copy pattern (see migrateAssetsUserId above).
function migratePortfolioSingletonToUserId(db, table, hasWalletBalances, legacyOwnerId) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === 'user_id')) return;
  if (!columns.some((c) => c.name === 'id')) return; // unexpected shape; nothing to migrate

  const oldTable = `${table}_pre_user_migration`;
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${oldTable}`);
    db.exec(hasWalletBalances
      ? `CREATE TABLE ${table} (
           user_id INTEGER PRIMARY KEY REFERENCES users(id),
           balance REAL NOT NULL,
           wallet_balances_json TEXT,
           updated_at_utc TEXT NOT NULL
         )`
      : `CREATE TABLE ${table} (
           user_id INTEGER PRIMARY KEY REFERENCES users(id),
           balance REAL NOT NULL,
           updated_at_utc TEXT NOT NULL
         )`);
    if (legacyOwnerId != null) {
      db.prepare(hasWalletBalances
        ? `INSERT INTO ${table} (user_id, balance, wallet_balances_json, updated_at_utc)
           SELECT ?, balance, wallet_balances_json, updated_at_utc FROM ${oldTable} WHERE id = 1`
        : `INSERT INTO ${table} (user_id, balance, updated_at_utc)
           SELECT ?, balance, updated_at_utc FROM ${oldTable} WHERE id = 1`
      ).run(legacyOwnerId);
    }
    db.exec(`DROP TABLE ${oldTable}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Category C: mode-only PRIMARY KEY -> composite (user_id, mode). Covers risk_settings,
// futures_risk_settings (the latter has an extra max_leverage column).
function migrateRiskSettingsUserId(db, table, hasMaxLeverage, legacyOwnerId) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === 'user_id')) return;

  const oldTable = `${table}_pre_user_migration`;
  const extraCol = hasMaxLeverage ? 'max_leverage REAL NOT NULL,\n           ' : '';
  const extraColName = hasMaxLeverage ? 'max_leverage, ' : '';
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${oldTable}`);
    db.exec(`
      CREATE TABLE ${table} (
        user_id INTEGER NOT NULL REFERENCES users(id),
        mode TEXT NOT NULL CHECK (mode IN ('demo','real')),
        max_risk_per_trade_percent REAL NOT NULL,
        max_daily_loss_percent REAL NOT NULL,
        max_open_positions INTEGER NOT NULL,
        max_order_value REAL NOT NULL,
        min_risk_reward_ratio REAL NOT NULL,
        max_portfolio_exposure_percent REAL NOT NULL,
        ${extraCol}updated_at_utc TEXT NOT NULL,
        PRIMARY KEY (user_id, mode)
      )
    `);
    if (legacyOwnerId != null) {
      db.prepare(`
        INSERT INTO ${table} (user_id, mode, max_risk_per_trade_percent, max_daily_loss_percent,
          max_open_positions, max_order_value, min_risk_reward_ratio, max_portfolio_exposure_percent,
          ${extraColName}updated_at_utc)
        SELECT ?, mode, max_risk_per_trade_percent, max_daily_loss_percent, max_open_positions,
          max_order_value, min_risk_reward_ratio, max_portfolio_exposure_percent, ${extraColName}updated_at_utc
        FROM ${oldTable}
      `).run(legacyOwnerId);
    }
    db.exec(`DROP TABLE ${oldTable}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Category D: real_exchange_credentials singleton -> one row per user.
function migrateRealExchangeCredentialsUserId(db, legacyOwnerId) {
  const columns = db.prepare('PRAGMA table_info(real_exchange_credentials)').all();
  if (columns.some((c) => c.name === 'user_id')) return;
  if (!columns.some((c) => c.name === 'id')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE real_exchange_credentials RENAME TO real_exchange_credentials_pre_user_migration');
    db.exec(`
      CREATE TABLE real_exchange_credentials (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        exchange_name TEXT NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        api_secret_encrypted TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      )
    `);
    if (legacyOwnerId != null) {
      db.prepare(`
        INSERT INTO real_exchange_credentials (user_id, exchange_name, api_key_encrypted, api_secret_encrypted, updated_at_utc)
        SELECT ?, exchange_name, api_key_encrypted, api_secret_encrypted, updated_at_utc
        FROM real_exchange_credentials_pre_user_migration WHERE id = 1
      `).run(legacyOwnerId);
    }
    db.exec('DROP TABLE real_exchange_credentials_pre_user_migration');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Category E: emergency_stop (scope-only PK, 'global'/'demo'/'real') -> split into
// emergency_stop_global (stays instance-wide, untouched by user scoping) and emergency_stop_user
// (per-account demo/real stops). See the SCHEMA_SQL comment above emergency_stop_global for why
// this is a split rather than a nullable user_id in one composite-key table.
function migrateEmergencyStopSplit(db, legacyOwnerId) {
  const oldTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emergency_stop'").all();
  if (oldTable.length === 0) return;

  const rows = db.prepare('SELECT * FROM emergency_stop').all();
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (row.scope === 'global') {
        db.prepare(
          'INSERT OR REPLACE INTO emergency_stop_global (id, active, reason, activated_at_utc, reset_at_utc) VALUES (1, ?, ?, ?, ?)'
        ).run(row.active, row.reason, row.activated_at_utc, row.reset_at_utc);
      } else if (legacyOwnerId != null) {
        db.prepare(
          'INSERT OR REPLACE INTO emergency_stop_user (user_id, scope, active, reason, activated_at_utc, reset_at_utc) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(legacyOwnerId, row.scope, row.active, row.reason, row.activated_at_utc, row.reset_at_utc);
      }
    }
    db.exec('DROP TABLE emergency_stop');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function applySchema(db) {
  db.exec(SCHEMA_SQL);
  migrateAssetsUserId(db);
  migrateRealPortfolioWalletBalances(db);
  migrateOrdersOrderType(db);
  migrateFuturesAssetsSplit(db);

  const legacyOwnerId = resolveLegacyDataOwnerId(db);
  for (const table of [
    'demo_positions', 'real_positions', 'demo_orders', 'real_orders',
    'demo_futures_positions', 'real_futures_positions', 'demo_futures_orders', 'real_futures_orders',
    'real_audit_log',
  ]) {
    migrateAddUserIdColumn(db, table, legacyOwnerId);
  }
  migratePortfolioSingletonToUserId(db, 'demo_portfolio', false, legacyOwnerId);
  migratePortfolioSingletonToUserId(db, 'real_portfolio', true, legacyOwnerId);
  migratePortfolioSingletonToUserId(db, 'demo_futures_portfolio', false, legacyOwnerId);
  migratePortfolioSingletonToUserId(db, 'real_futures_portfolio', true, legacyOwnerId);
  migrateRiskSettingsUserId(db, 'risk_settings', false, legacyOwnerId);
  migrateRiskSettingsUserId(db, 'futures_risk_settings', true, legacyOwnerId);
  migrateRealExchangeCredentialsUserId(db, legacyOwnerId);
  migrateEmergencyStopSplit(db, legacyOwnerId);

  for (const table of ['assets', 'demo_futures_assets', 'real_futures_assets']) {
    migrateAddStrategySelectionColumns(db, table);
  }
  migrateAddCombinedSignalColumns(db);
}

module.exports = { SCHEMA_SQL, applySchema };
