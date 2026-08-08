'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async operation with exponential backoff. Used for every outbound call to an
 * exchange or fundamentals provider, per the mandatory "limited retry with backoff" rule.
 */
async function withRetry(fn, { maxRetries = 3, baseDelayMs = 300 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

module.exports = { withRetry };
