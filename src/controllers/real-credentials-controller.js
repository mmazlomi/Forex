'use strict';

const ccxt = require('ccxt');
const { CUSTOM_EXCHANGES } = require('../services/exchanges/custom-exchange-registry');
const realExchangeCredentialsRepository = require('../database/repositories/real-exchange-credentials-repository');
const { resolveRealCredentials } = require('../services/exchanges/real-credentials-resolver');
const { sendSuccess, sendError } = require('../utils/http-response');
const logger = require('../services/logging/logger');

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}${'*'.repeat(Math.max(key.length - 8, 4))}${key.slice(-4)}`;
}

// Never returns the actual key/secret — this is a write-only secret store from the API's
// perspective, same convention as GitHub/most secret managers: you can tell something is
// configured and get a masked preview to sanity-check it's the right one, never the full value
// back.
async function getStatus(req, res) {
  const credentials = resolveRealCredentials(req.user.id);
  sendSuccess(res, {
    configured: !!credentials.name,
    source: credentials.name ? credentials.source : 'none',
    exchangeName: credentials.name || null,
    apiKeyPreview: maskKey(credentials.apiKey),
  });
}

async function setCredentials(req, res) {
  const { exchangeName, apiKey, apiSecret } = req.body || {};
  const id = String(exchangeName || '').toLowerCase().trim();
  const ExchangeClass = CUSTOM_EXCHANGES[id] || ccxt[id];
  if (!id || !ExchangeClass) {
    return sendError(res, 'VALIDATION_ERROR', `"${exchangeName}" is not a recognized exchange id.`);
  }
  const secretRequired = !ExchangeClass.NO_SECRET_NEEDED;
  if (!apiKey || (secretRequired && !apiSecret)) {
    return sendError(res, 'VALIDATION_ERROR', secretRequired
      ? 'apiKey and apiSecret are both required.'
      : 'apiKey is required.');
  }

  // The `real_exchange_credentials` schema has both columns NOT NULL — exchanges that don't use
  // a secret (Nobitex) still get a stored (encrypted) empty placeholder; it's simply never read.
  realExchangeCredentialsRepository.set(req.user.id, id, apiKey, secretRequired ? apiSecret : '');
  logger.info('real-credentials', `Real exchange credentials updated by ${req.user.username} (exchange: ${id})`, {}, 'real');
  sendSuccess(res, { configured: true, source: 'database', exchangeName: id, apiKeyPreview: maskKey(apiKey) }, 'Real exchange credentials saved.');
}

async function clearCredentials(req, res) {
  realExchangeCredentialsRepository.clear(req.user.id);
  logger.info('real-credentials', `Real exchange credentials cleared by ${req.user.username}`, {}, 'real');
  const credentials = resolveRealCredentials(req.user.id); // may now fall back to .env (legacy owner only)
  sendSuccess(res, {
    configured: !!credentials.name,
    source: credentials.name ? credentials.source : 'none',
    exchangeName: credentials.name || null,
    apiKeyPreview: maskKey(credentials.apiKey),
  }, 'Database-stored credentials cleared.');
}

module.exports = { getStatus, setCredentials, clearCredentials };
