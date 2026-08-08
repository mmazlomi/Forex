'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maskString, maskObject, maskKnownSecrets } = require('../../src/utils/mask-secrets');

test('maskString redacts the middle of a long string but keeps it recognizable', () => {
  const masked = maskString('sk_live_abcdef123456');
  assert.notEqual(masked, 'sk_live_abcdef123456');
  assert.ok(masked.startsWith('sk'));
  assert.ok(masked.includes('*'));
});

test('maskString fully masks very short strings', () => {
  assert.equal(maskString('abc'), '****');
});

test('maskObject redacts fields whose key looks secret-shaped', () => {
  const masked = maskObject({ apiKey: 'supersecretvalue123', username: 'alice' });
  assert.notEqual(masked.apiKey, 'supersecretvalue123');
  assert.equal(masked.username, 'alice'); // non-secret fields pass through untouched
});

test('maskObject recurses into nested objects', () => {
  const masked = maskObject({ credentials: { apiSecret: 'nestedsecretvalue' } });
  assert.notEqual(masked.credentials.apiSecret, 'nestedsecretvalue');
});

test('maskKnownSecrets redacts every exact occurrence of a configured secret value', () => {
  const secret = 'MyRealApiSecretValue123';
  const text = `Exchange rejected key ${secret} — retry with a valid ${secret}`;
  const masked = maskKnownSecrets(text, [secret]);
  assert.ok(!masked.includes(secret));
});

test('maskKnownSecrets leaves unrelated content untouched (no over-masking)', () => {
  const text = 'Real order rejected for BTC/USDT: LIVE_TRADING_DISABLED';
  const masked = maskKnownSecrets(text, ['SomeUnrelatedSecretAbc']);
  assert.equal(masked, text); // reason codes and messages must stay readable
});

test('maskKnownSecrets ignores empty/short values so it cannot mask everything', () => {
  const text = 'order id ab';
  const masked = maskKnownSecrets(text, ['', 'ab']);
  assert.equal(masked, text); // 'ab' is below the 4-char minimum
});
