'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('../../config/config');
const { applySchema } = require('./schema');

let db = null;

function getDb() {
  if (db) return db;

  const isInMemory = config.databasePath === ':memory:';
  const dbPath = isInMemory ? ':memory:' : path.resolve(process.cwd(), config.databasePath);
  if (!isInMemory) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  if (!isInMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  applySchema(db);

  return db;
}

/** Test-only: drops the cached connection so a fresh in-memory DB is created on next getDb(). */
function resetForTests() {
  if (db) db.close();
  db = null;
}

module.exports = { getDb, resetForTests };
