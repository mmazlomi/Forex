'use strict';

// Time-of-day/day-of-week filter — see docs/reversal-strategy/STRATEGY_SPEC.md §12. Disabled by
// default (crypto trades 24/7); exists for experimenting with FX-style session/weekend
// restrictions on crypto data, or for genuine FX use in a future broker-integrated phase.

const { SESSION_PRESETS } = require('./config');

function resolveHourRange(session) {
  return typeof session === 'string' ? SESSION_PRESETS[session] : session;
}

function isWithinAnySession(tsUtc, allowedSessions) {
  const hour = new Date(tsUtc).getUTCHours();
  return allowedSessions.some((s) => {
    const range = resolveHourRange(s);
    if (!range) return false;
    const { startHourUtc, endHourUtc } = range;
    if (startHourUtc <= endHourUtc) return hour >= startHourUtc && hour < endHourUtc;
    return hour >= startHourUtc || hour < endHourUtc; // wraps midnight (e.g. 22-6)
  });
}

/** @returns {boolean} whether a bar at `tsUtc` (ms epoch) is allowed to trade under config.sessionFilter */
function isSessionAllowed(tsUtc, config) {
  const { sessionFilter } = config;
  if (!sessionFilter.enabled) return true;

  const day = new Date(tsUtc).getUTCDay(); // 0=Sunday .. 6=Saturday
  if (sessionFilter.excludeWeekends && (day === 0 || day === 6)) return false;
  if (sessionFilter.excludeFriday && day === 5) return false;
  if (!sessionFilter.allowedSessions || sessionFilter.allowedSessions.length === 0) return true;
  return isWithinAnySession(tsUtc, sessionFilter.allowedSessions);
}

module.exports = { isSessionAllowed, isWithinAnySession };
