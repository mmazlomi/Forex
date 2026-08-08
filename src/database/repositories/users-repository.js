'use strict';

const { getDb } = require('../connection');

function createUser(username, passwordHash) {
  const db = getDb();
  const createdAtUtc = new Date().toISOString();
  const result = db
    .prepare('INSERT INTO users (username, password_hash, created_at_utc) VALUES (?, ?, ?)')
    .run(username, passwordHash, createdAtUtc);
  return getUserById(Number(result.lastInsertRowid));
}

function getUserByUsername(username) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function getUserById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function countUsers() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

module.exports = { createUser, getUserByUsername, getUserById, countUsers };
