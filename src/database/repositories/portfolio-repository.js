'use strict';

const { getDb } = require('../connection');
const { portfolioTable } = require('./mode-tables');

function getPortfolio(mode, userId) {
  const db = getDb();
  const table = portfolioTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).get(userId);
}

function ensureInitialized(mode, userId, initialBalance) {
  const existing = getPortfolio(mode, userId);
  if (existing) return existing;
  const db = getDb();
  const table = portfolioTable(mode);
  db.prepare(`INSERT INTO ${table} (user_id, balance, updated_at_utc) VALUES (?, ?, ?)`).run(
    userId,
    initialBalance,
    new Date().toISOString()
  );
  return getPortfolio(mode, userId);
}

// walletBalances is optional and only meaningful for 'real' (demo_portfolio has no such column —
// demo is a single simulated currency, not a live multi-currency exchange wallet). Omitting it
// leaves the column untouched rather than clearing a previously-synced breakdown on every
// balance-only update (e.g. after a trade closes and portfolio-service.js re-syncs just the
// number).
function setBalance(mode, userId, balance, walletBalances) {
  const db = getDb();
  const table = portfolioTable(mode);
  const updatedAtUtc = new Date().toISOString();
  // Upsert, not update-only: real-orders.js calls this to sync the live exchange balance
  // before the portfolio row has necessarily been initialized for this user — an UPDATE-only
  // would silently no-op there, and a later ensureInitialized() call would then create a fresh
  // row with balance 0, discarding the just-synced value.
  if (walletBalances !== undefined) {
    db.prepare(
      `INSERT INTO ${table} (user_id, balance, wallet_balances_json, updated_at_utc) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, wallet_balances_json = excluded.wallet_balances_json, updated_at_utc = excluded.updated_at_utc`
    ).run(userId, balance, JSON.stringify(walletBalances), updatedAtUtc);
  } else {
    db.prepare(
      `INSERT INTO ${table} (user_id, balance, updated_at_utc) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at_utc = excluded.updated_at_utc`
    ).run(userId, balance, updatedAtUtc);
  }
  return getPortfolio(mode, userId);
}

module.exports = { getPortfolio, ensureInitialized, setBalance };
