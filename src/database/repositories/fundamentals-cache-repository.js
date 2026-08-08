'use strict';

const { getDb } = require('../connection');

function get({ symbol, assetType, fieldGroup }) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM fundamentals_cache WHERE symbol = ? AND asset_type = ? AND field_group = ?`
    )
    .get(symbol, assetType, fieldGroup);
}

function isFresh(row) {
  if (!row) return false;
  return new Date(row.expires_at_utc).getTime() > Date.now();
}

function set({ symbol, assetType, fieldGroup, dataJson, provider, fetchedAtUtc, expiresAtUtc }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO fundamentals_cache (symbol, asset_type, field_group, data_json, provider, fetched_at_utc, expires_at_utc)
     VALUES (@symbol, @assetType, @fieldGroup, @dataJson, @provider, @fetchedAtUtc, @expiresAtUtc)
     ON CONFLICT(symbol, asset_type, field_group) DO UPDATE SET
       data_json = excluded.data_json, provider = excluded.provider,
       fetched_at_utc = excluded.fetched_at_utc, expires_at_utc = excluded.expires_at_utc`
  ).run({ symbol, assetType, fieldGroup, dataJson, provider, fetchedAtUtc, expiresAtUtc });
}

module.exports = { get, set, isFresh };
