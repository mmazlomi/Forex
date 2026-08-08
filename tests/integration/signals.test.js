'use strict';

process.env.DATABASE_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const usersRepository = require('../../src/database/repositories/users-repository');
const emergencyStopRepository = require('../../src/database/repositories/emergency-stop-repository');
const signalsService = require('../../src/services/signals');

test.beforeEach(() => {
  resetForTests();
});

// Regression test for a real bug: emergencyStopRepository.isActive(scope, userId) requires a
// userId to bind into `SELECT ... WHERE user_id = ?` (see emergency-stop-repository.js), but
// generateSignal() called it as isActive(mode) with no userId at all — every single call (from
// the manual "Generate Signal"/"Generate for Watchlist" buttons, and from every scheduled
// auto-trader cycle) threw "Provided value cannot be bound to SQLite parameter 1" instead of
// generating a signal. No existing test caught this because every other test mocks
// signalsService.generateSignal entirely rather than calling the real implementation.
test('generateSignal completes without throwing for a real user, with no candle data (network-independent path)', async () => {
  const user = usersRepository.createUser('signals-test-user', 'irrelevant-hash');
  // No market-data mocking — in this test environment the real exchange call will fail/return no
  // candles, which is fine: generateSignal's NO_DATA path still unconditionally calls
  // emergencyStopRepository.isActive(mode, userId) before returning, which is exactly the call
  // that used to crash regardless of whether real candle data was available.
  const signal = await signalsService.generateSignal({
    symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto', mode: 'demo', userId: user.id,
  });
  assert.ok(signal.id);
  assert.ok(['BUY', 'SELL', 'HOLD', 'NO_DATA'].includes(signal.status));
});

test('generateSignal does not throw when the calling user\'s own emergency-stop scope is active', async () => {
  const user = usersRepository.createUser('signals-test-user-2', 'irrelevant-hash');
  emergencyStopRepository.setActive('demo', user.id, true, 'test');
  const signal = await signalsService.generateSignal({
    symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto', mode: 'demo', userId: user.id,
  });
  assert.ok(signal.id);
  // Whatever the underlying technical result, an active emergency stop must never let a BUY/SELL
  // signal escape — this is the specific behavior isActive(mode, userId) exists to gate.
  assert.ok(['NO_DATA', 'HOLD'].includes(signal.status));
});
