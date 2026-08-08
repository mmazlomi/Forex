'use strict';

const config = require('../../../config/config');
const { maskObject, maskKnownSecrets } = require('../../utils/mask-secrets');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = LEVELS[config.logLevel] ?? LEVELS.info;

const KNOWN_SECRETS = [
  config.demoExchange.apiKey,
  config.demoExchange.apiSecret,
  config.realExchange.apiKey,
  config.realExchange.apiSecret,
  config.fundamentalApiKey,
].filter(Boolean);

let logsRepository = null;
function getLogsRepository() {
  // Lazy require avoids a hard dependency cycle at module-load time.
  if (!logsRepository) {
    logsRepository = require('../../database/repositories/logs-repository');
  }
  return logsRepository;
}

function nowUtc() {
  return new Date().toISOString();
}

function write(level, category, message, meta, mode) {
  if (LEVELS[level] < configuredLevel) return;

  const safeMessage = maskKnownSecrets(String(message), KNOWN_SECRETS);
  const safeMeta = meta ? maskObject(meta) : undefined;
  const createdAtUtc = nowUtc();

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${createdAtUtc}] [${level.toUpperCase()}]${category ? ` [${category}]` : ''} ${safeMessage}`, safeMeta || '');

  try {
    getLogsRepository().insertLog({
      level,
      mode: mode || null,
      category: category || null,
      message: safeMessage,
      metaJson: safeMeta ? JSON.stringify(safeMeta) : null,
      createdAtUtc,
    });
  } catch (err) {
    // Logging must never crash the caller; fall back to console only.
    console.error(`[${nowUtc()}] [ERROR] [logging] Failed to persist log entry: ${err.message}`);
  }
}

module.exports = {
  debug: (category, message, meta, mode) => write('debug', category, message, meta, mode),
  info: (category, message, meta, mode) => write('info', category, message, meta, mode),
  warn: (category, message, meta, mode) => write('warn', category, message, meta, mode),
  error: (category, message, meta, mode) => write('error', category, message, meta, mode),
};
