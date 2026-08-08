'use strict';

const { getDb } = require('../connection');

function insertAuditEntry({ userId, orderId, requestJson, responseJson }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO real_audit_log (user_id, order_id, request_json, response_json, created_at_utc)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId ?? null, orderId, requestJson, responseJson, new Date().toISOString());
}

module.exports = { insertAuditEntry };
