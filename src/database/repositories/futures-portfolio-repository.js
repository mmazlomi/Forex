'use strict';

const { getDb } = require('../connection');
const { futuresPortfolioTable } = require('./mode-tables');

function getPortfolio(mode, userId) {
  const db = getDb();
  const table = futuresPortfolioTable(mode);
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).get(userId);
}

function ensureInitialized(mode, userId, initialBalance) {
  const existing = getPortfolio(mode, userId);
  if (existing) return existing;
  const db = getDb();
  const table = futuresPortfolioTable(mode);
  db.prepare(`INSERT INTO ${table} (user_id, balance, updated_at_utc) VALUES (?, ?, ?)`).run(userId, initialBalance, new Date().toISOString());
  return getPortfolio(mode, userId);
}

function setBalance(mode, userId, balance, walletBalances) {
  const db = getDb();
  const table = futuresPortfolioTable(mode);
  const updatedAtUtc = new Date().toISOString();
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
