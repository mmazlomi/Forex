'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSessionAllowed } = require('../../../src/services/reversal-strategy/session-filter');
const { mergeConfig } = require('../../../src/services/reversal-strategy/config');

function utc(y, m, d, h) {
  return Date.UTC(y, m - 1, d, h, 0, 0);
}

test('disabled by default: every hour/day is allowed', () => {
  const config = mergeConfig();
  assert.equal(config.sessionFilter.enabled, false);
  assert.equal(isSessionAllowed(utc(2026, 1, 3, 3), config), true); // a Saturday at 3am UTC
});

test('named session presets restrict to the configured UTC hour ranges', () => {
  const config = mergeConfig({ sessionFilter: { enabled: true, allowedSessions: ['london'] } }); // 08:00-16:00 UTC
  assert.equal(isSessionAllowed(utc(2026, 3, 10, 9), config), true); // Tuesday 09:00 UTC, inside London
  assert.equal(isSessionAllowed(utc(2026, 3, 10, 20), config), false); // 20:00 UTC, outside London
});

test('multiple allowed sessions are combined with OR', () => {
  const config = mergeConfig({ sessionFilter: { enabled: true, allowedSessions: ['asian', 'newYork'] } });
  assert.equal(isSessionAllowed(utc(2026, 3, 10, 2), config), true); // Asian session (00-08)
  assert.equal(isSessionAllowed(utc(2026, 3, 10, 14), config), true); // New York session (13-21)
  assert.equal(isSessionAllowed(utc(2026, 3, 10, 10), config), false); // between sessions
});

test('excludeWeekends blocks Saturday and Sunday regardless of hour', () => {
  const config = mergeConfig({ sessionFilter: { enabled: true, excludeWeekends: true, allowedSessions: [] } });
  assert.equal(isSessionAllowed(utc(2026, 3, 14, 12), config), false); // Saturday
  assert.equal(isSessionAllowed(utc(2026, 3, 15, 12), config), false); // Sunday
  assert.equal(isSessionAllowed(utc(2026, 3, 16, 12), config), true); // Monday
});

test('excludeFriday blocks only Friday', () => {
  const config = mergeConfig({ sessionFilter: { enabled: true, excludeFriday: true, allowedSessions: [] } });
  assert.equal(isSessionAllowed(utc(2026, 3, 13, 12), config), false); // Friday
  assert.equal(isSessionAllowed(utc(2026, 3, 12, 12), config), true); // Thursday
});

test('a custom {startHourUtc, endHourUtc} object works alongside named presets, including a midnight-wrapping range', () => {
  const config = mergeConfig({ sessionFilter: { enabled: true, allowedSessions: [{ startHourUtc: 22, endHourUtc: 6 }] } });
  assert.equal(isSessionAllowed(utc(2026, 3, 10, 23), config), true); // wraps past midnight
  assert.equal(isSessionAllowed(utc(2026, 3, 10, 3), config), true);
  assert.equal(isSessionAllowed(utc(2026, 3, 10, 12), config), false);
});
