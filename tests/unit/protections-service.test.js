'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protectionsService = require('../../src/services/risk/protections-service');

test('protectionsService: symbol starts without active cooldown', () => {
  protectionsService.resetAllCooldowns();
  const status = protectionsService.isCooldownActive('ETH/USDT', 'demo');
  assert.equal(status.active, false);
});

test('protectionsService: activates cooldown after stoploss threshold reached in window', () => {
  protectionsService.resetAllCooldowns();
  const symbol = 'SOL/USDT';

  // First stop-loss: threshold not yet reached (needs 2)
  const first = protectionsService.recordStopLoss(symbol, 'demo');
  assert.equal(first.cooldownActivated, false);
  assert.equal(protectionsService.isCooldownActive(symbol, 'demo').active, false);

  // Second stop-loss: triggers cooldown
  const second = protectionsService.recordStopLoss(symbol, 'demo');
  assert.equal(second.cooldownActivated, true);
  assert.ok(second.cooldownMinutes > 0);

  // Verification
  const activeStatus = protectionsService.isCooldownActive(symbol, 'demo');
  assert.equal(activeStatus.active, true);
  assert.ok(activeStatus.remainingMinutes > 0);

  // List all
  const all = protectionsService.getAllActiveCooldowns();
  assert.ok(all.some((c) => c.symbol === symbol));

  // Reset
  protectionsService.resetCooldown(symbol, 'demo');
  assert.equal(protectionsService.isCooldownActive(symbol, 'demo').active, false);
});

test('protectionsService: recordReversalExit immediately activates a cooldown and tracks stop-loss', () => {
  protectionsService.resetAllCooldowns();
  const symbol = 'ETH/USDT';

  // Single reversal exit immediately activates a 15m cooldown
  protectionsService.recordReversalExit(symbol, 'demo', 15);

  const status = protectionsService.isCooldownActive(symbol, 'demo');
  assert.equal(status.active, true);
  assert.ok(status.remainingMinutes <= 15 && status.remainingMinutes > 0);

  // Clean up
  protectionsService.resetAllCooldowns();
});

