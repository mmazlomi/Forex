'use strict';

const { sendError } = require('../utils/http-response');

/**
 * Minimal in-memory fixed-window rate limiter (no external dependency). Fine for a
 * single-process hobby deployment; a multi-instance deployment would need a shared store.
 */
function createRateLimiter({ windowMs, maxRequests }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Without this, `hits` only ever grows — every distinct client IP that has ever made a
  // request keeps a permanent entry, since expired entries are only replaced (not removed) the
  // next time that same IP happens to hit the limiter again. Sweeping expired entries on a
  // timer bounds the map to roughly the set of clients active within the last windowMs.
  const sweepHandle = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweepHandle.unref === 'function') sweepHandle.unref();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > maxRequests) {
      return sendError(res, 'RATE_LIMITED', 'Too many requests — please slow down.', 429);
    }
    next();
  };
}

module.exports = { createRateLimiter };
