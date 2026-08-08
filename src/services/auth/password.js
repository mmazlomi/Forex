'use strict';

const crypto = require('crypto');

const KEY_LENGTH = 64;

/** Returns `salt:hash` (both hex) — the salt travels with the hash, nothing else to store. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const candidate = crypto.scryptSync(password, salt, KEY_LENGTH);
  // timingSafeEqual requires equal-length buffers, which scrypt with a fixed KEY_LENGTH always
  // produces — a mismatched stored hash (corrupt data, not an attacker) would only ever be a
  // programmer error, not a real length-varying input.
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword };
