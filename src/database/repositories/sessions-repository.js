'use strict';

const { getDb } = require('../connection');

function createSession(token, userId, expiresAtUtc) {
  const db = getDb();
  const createdAtUtc = new Date().toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at_utc, expires_at_utc) VALUES (?, ?, ?, ?)')
    .run(token, userId, createdAtUtc, expiresAtUtc);
}

function getSession(token) {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) || null;
}

function deleteSession(token) {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { createSession, getSession, deleteSession };
