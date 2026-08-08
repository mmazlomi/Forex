'use strict';

const { getDb } = require('../connection');

function insertLog({ level, mode, category, message, metaJson, createdAtUtc }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO logs (level, mode, category, message, meta_json, created_at_utc)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(level, mode, category, message, metaJson, createdAtUtc);
}

function listLogs({ level, mode, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (level) {
    clauses.push('level = ?');
    params.push(level);
  }
  if (mode) {
    clauses.push('mode = ?');
    params.push(mode);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  return rows;
}

module.exports = { insertLog, listLogs };
