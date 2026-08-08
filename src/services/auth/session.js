'use strict';

const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { generateSessionToken, SESSION_TTL_MS };
