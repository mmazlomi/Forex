'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../../config/config');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12; // recommended IV length for GCM

// Real exchange API credentials, once movable into the database via the UI (see
// real-exchange-credentials-repository.js), still shouldn't sit in the SQLite file as plaintext
// — the DB is more likely than .env to end up in a casual backup/copy. Encrypted at rest with a
// key that lives in its own file (matched by the existing `*.key` .gitignore pattern), separate
// from the database file itself. This is defense in depth, not a complete solution: anyone with
// full filesystem access to the server gets both files regardless.
function keyFilePath() {
  return path.resolve(path.dirname(path.resolve(process.cwd(), config.databasePath)), 'credential-encryption.key');
}

let cachedKey = null;

function loadOrCreateKey() {
  if (cachedKey) return cachedKey;

  // Same convention as connection.js's :memory: database — an ephemeral, process-only key,
  // never touching disk. Without this, resolving a file path from the literal string ":memory:"
  // would write a real key file into the project directory on every test run.
  if (config.databasePath === ':memory:') {
    cachedKey = crypto.randomBytes(KEY_LENGTH);
    return cachedKey;
  }

  const filePath = keyFilePath();
  if (fs.existsSync(filePath)) {
    cachedKey = fs.readFileSync(filePath);
    if (cachedKey.length !== KEY_LENGTH) {
      throw new Error(`Credential encryption key at ${filePath} is the wrong length — refusing to use it.`);
    }
    return cachedKey;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  cachedKey = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(filePath, cachedKey, { mode: 0o600 });
  return cachedKey;
}

/** Returns "iv:authTag:ciphertext", all hex-encoded. */
function encryptSecret(plaintext) {
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptSecret(stored) {
  const key = loadOrCreateKey();
  // Split into exactly 3 parts rather than checking each part's truthiness — an empty-string
  // secret (e.g. Nobitex's unused apiSecret placeholder, see custom-exchanges/nobitex-exchange.js)
  // legitimately encrypts to an empty ciphertext, which is a valid but falsy `''`, not malformed.
  const parts = String(stored || '').split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted credential value.');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (!ivHex || !authTagHex) {
    throw new Error('Malformed encrypted credential value.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
