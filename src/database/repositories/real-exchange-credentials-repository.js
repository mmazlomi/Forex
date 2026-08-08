'use strict';

const { getDb } = require('../connection');
const { encryptSecret, decryptSecret } = require('../../services/security/secret-encryption');

/** Returns { exchangeName, apiKey, apiSecret, updatedAtUtc } (decrypted) or null if this user hasn't stored a credential. */
function get(userId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM real_exchange_credentials WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    exchangeName: row.exchange_name,
    apiKey: decryptSecret(row.api_key_encrypted),
    apiSecret: decryptSecret(row.api_secret_encrypted),
    updatedAtUtc: row.updated_at_utc,
  };
}

function set(userId, exchangeName, apiKey, apiSecret) {
  const db = getDb();
  const updatedAtUtc = new Date().toISOString();
  db.prepare(
    `INSERT INTO real_exchange_credentials (user_id, exchange_name, api_key_encrypted, api_secret_encrypted, updated_at_utc)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       exchange_name = excluded.exchange_name,
       api_key_encrypted = excluded.api_key_encrypted,
       api_secret_encrypted = excluded.api_secret_encrypted,
       updated_at_utc = excluded.updated_at_utc`
  ).run(userId, exchangeName, encryptSecret(apiKey), encryptSecret(apiSecret), updatedAtUtc);
}

function clear(userId) {
  const db = getDb();
  db.prepare('DELETE FROM real_exchange_credentials WHERE user_id = ?').run(userId);
}

module.exports = { get, set, clear };
