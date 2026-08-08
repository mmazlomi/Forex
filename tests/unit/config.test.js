'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../../config/config');

function loadConfigWithEnv(envOverrides) {
  const savedEnv = { ...process.env };
  Object.assign(process.env, envOverrides);
  delete require.cache[CONFIG_PATH];
  try {
    return { config: require(CONFIG_PATH), error: null };
  } catch (error) {
    return { config: null, error };
  } finally {
    process.env = savedEnv;
    delete require.cache[CONFIG_PATH];
  }
}

test('config defaults PORT to 3450 when unset', () => {
  const { config } = loadConfigWithEnv({ PORT: '' });
  assert.equal(config.port, 3450);
});

test('config parses a custom PORT correctly', () => {
  const { config } = loadConfigWithEnv({ PORT: '4321' });
  assert.equal(config.port, 4321);
});

test('config throws on a non-numeric PORT rather than silently defaulting', () => {
  const { error } = loadConfigWithEnv({ PORT: 'not-a-number' });
  assert.ok(error);
});

// Real exchange credentials can now also be set from the UI (stored encrypted in the database,
// see real-credentials-resolver.js) instead of only .env, and the database isn't connected yet
// at config-load time — so this case no longer fails at boot. Credential completeness is instead
// checked fresh on every real-order attempt (real-orders.js's MISSING_REAL_CREDENTIALS
// rejection, covering both .env and database sources — see
// tests/integration/real-trading-enabled.test.js for that "fails safe" guarantee).
test('ENABLE_LIVE_TRADING=true without .env real credentials no longer fails at boot (checked at request time instead)', () => {
  const { config, error } = loadConfigWithEnv({
    ENABLE_LIVE_TRADING: 'true', REAL_EXCHANGE_NAME: '', REAL_API_KEY: '', REAL_API_SECRET: '',
  });
  assert.equal(error, null);
  assert.equal(config.enableLiveTrading, true);
});

test('ENABLE_LIVE_TRADING=true with all real credentials present passes validation', () => {
  const { config, error } = loadConfigWithEnv({
    ENABLE_LIVE_TRADING: 'true', REAL_EXCHANGE_NAME: 'kucoin', REAL_API_KEY: 'k', REAL_API_SECRET: 's',
  });
  assert.equal(error, null);
  assert.equal(config.enableLiveTrading, true);
});

test('ENABLE_LIVE_TRADING defaults to false (demo is the default mode)', () => {
  const { config } = loadConfigWithEnv({ ENABLE_LIVE_TRADING: '' });
  assert.equal(config.enableLiveTrading, false);
});

test('rejects an out-of-bounds MAX_RISK_PER_TRADE_PERCENT', () => {
  const { error } = loadConfigWithEnv({ MAX_RISK_PER_TRADE_PERCENT: '150' });
  assert.ok(error);
});
