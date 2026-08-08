'use strict';

const config = require('../../../config/config');
const realExchangeCredentialsRepository = require('../../database/repositories/real-exchange-credentials-repository');
const usersRepository = require('../../database/repositories/users-repository');

// The one pre-existing account whose real trading history predates per-user isolation — see
// schema.js's LEGACY_DATA_OWNER_USERNAME. The `.env` REAL_EXCHANGE_NAME/REAL_API_KEY/
// REAL_API_SECRET fallback is a bridge for this one account only; every other user must configure
// their own credentials via the UI, so nobody can ever accidentally trade on hoseini's account
// through a shared `.env` fallback.
const LEGACY_DATA_OWNER_USERNAME = 'hoseini';

function isLegacyDataOwner(userId) {
  const user = usersRepository.getUserByUsername(LEGACY_DATA_OWNER_USERNAME);
  return !!user && user.id === userId;
}

/**
 * Resolves Real Trading credentials for this user, fresh on every call (never cached) — DB-stored
 * credentials (settable from the UI, see real-credentials-controller.js) take precedence over
 * `.env`'s REAL_EXCHANGE_NAME/REAL_API_KEY/REAL_API_SECRET if both are present, so saving
 * credentials via the UI is what a user would expect to take effect. The `.env` fallback applies
 * only when `userId` is the legacy data owner (see isLegacyDataOwner above) — every other user
 * with no DB row gets nothing configured, never someone else's `.env` credentials. Returns
 * `{ name: '', apiKey: '', apiSecret: '', source: 'database'|'env'|'none' }` — empty strings (not
 * null/undefined) when nothing is configured either way, matching config.js's existing shape so
 * callers don't need to special-case this.
 */
function resolveRealCredentials(userId) {
  const stored = realExchangeCredentialsRepository.get(userId);
  if (stored) {
    return { name: stored.exchangeName, apiKey: stored.apiKey, apiSecret: stored.apiSecret, source: 'database' };
  }
  if (isLegacyDataOwner(userId)) {
    return { name: config.realExchange.name, apiKey: config.realExchange.apiKey, apiSecret: config.realExchange.apiSecret, source: 'env' };
  }
  return { name: '', apiKey: '', apiSecret: '', source: 'none' };
}

module.exports = { resolveRealCredentials };
