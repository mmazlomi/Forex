'use strict';

process.env.DATABASE_PATH = ':memory:'; // keeps the encryption key ephemeral/in-process, no disk writes

const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptSecret, decryptSecret } = require('../../src/services/security/secret-encryption');

test('encryptSecret/decryptSecret round-trips a normal value', () => {
  const original = 'my-super-secret-api-key-12345';
  assert.equal(decryptSecret(encryptSecret(original)), original);
});

// Regression test: an empty-string secret (e.g. Nobitex's unused apiSecret placeholder — see
// custom-exchanges/nobitex-exchange.js NO_SECRET_NEEDED) encrypts to a valid but empty
// ciphertext ("iv:authTag:" with nothing after the last colon). decryptSecret() used to check
// each split part's truthiness, and an empty string is falsy, so this legitimately-encrypted
// empty secret was rejected as "malformed" — breaking GET /api/real-exchange-credentials for
// any exchange that doesn't need a secret. Fixed to check part *count*, not truthiness.
test('encryptSecret/decryptSecret round-trips an empty-string value', () => {
  assert.equal(decryptSecret(encryptSecret('')), '');
});

test('decryptSecret rejects genuinely malformed input', () => {
  assert.throws(() => decryptSecret('not-even-colon-separated'), /Malformed/);
  assert.throws(() => decryptSecret('only:two-parts'), /Malformed/);
  assert.throws(() => decryptSecret(''), /Malformed/);
});

test('decryptSecret rejects a tampered ciphertext (GCM auth tag mismatch)', () => {
  const encrypted = encryptSecret('a real secret');
  const [iv, authTag, ciphertext] = encrypted.split(':');
  const tampered = `${iv}:${authTag}:${ciphertext.slice(0, -2)}ff`;
  assert.throws(() => decryptSecret(tampered));
});
