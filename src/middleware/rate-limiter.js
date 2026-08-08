'use strict';

const { sendError } = require('../utils/http-response');

/**
 * Minimal in-memory fixed-window rate limiter (no external dependency). Fine for a
 * single-process hobby deployment; a multi-instance deployment would need a shared store.
 */
function createRateLimiter({ windowMs, maxRequests }) {
  const hits = new Map(); // key -> { count, resetAt }

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
