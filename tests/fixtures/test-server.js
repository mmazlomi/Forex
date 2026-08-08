'use strict';

// Must run before any project module (especially config/config.js) is required, so every
// test file that uses this fixture gets an isolated in-memory DB instead of touching
// data/trading-bot.sqlite. node --test runs each file in its own process, so this is safe.
process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { createApp } = require('../../server');
const { resetForTests } = require('../../src/database/connection');

/** Boots the app on an ephemeral port and returns { baseUrl, close }. */
function startTestServer() {
  resetForTests();
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let testUserCounter = 0;

/**
 * Same as startTestServer(), but also signs up a fresh account and returns an `authedFetch`
 * helper that attaches the resulting session cookie — every /api/* route except /api/auth/* and
 * /api/health now requires a logged-in session (see server.js), so any integration test that
 * exercises those routes over real HTTP needs this instead of plain startTestServer() + fetch().
 *
 * Pass `{ username: 'hoseini' }` for tests that rely on the `.env` REAL_EXCHANGE_NAME/REAL_API_KEY/
 * REAL_API_SECRET fallback — that fallback only applies to the legacy data owner account (see
 * real-credentials-resolver.js), so a test signing up as any other username gets
 * MISSING_REAL_CREDENTIALS instead. Omit it (the default, an auto-incrementing test-user-N) for
 * everything else, including any test that needs to prove isolation FROM hoseini's account.
 */
async function startAuthedTestServer({ username } = {}) {
  const { baseUrl, close } = startTestServer();
  testUserCounter += 1;
  const resolvedUsername = username || `test-user-${testUserCounter}`;
  const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: resolvedUsername, password: 'test-password-123' }),
  });
  const setCookieHeader = signupRes.headers.get('set-cookie');
  const cookie = setCookieHeader ? setCookieHeader.split(';')[0] : null;
  if (!cookie) throw new Error('Test fixture failed to obtain a session cookie from /api/auth/signup');

  function authedFetch(path, opts = {}) {
    return fetch(`${baseUrl}${path}`, { ...opts, headers: { ...(opts.headers || {}), Cookie: cookie } });
  }

  return { baseUrl, close, cookie, authedFetch };
}

/**
 * Signs up a SECOND (or third, etc.) independent account against an ALREADY-RUNNING server from
 * startAuthedTestServer(), without touching the DB connection — resetForTests() is a global
 * singleton reset (see src/database/connection.js), so calling startAuthedTestServer() again
 * would wipe out the first user's data entirely rather than adding a second account alongside it.
 * Use this for cross-user isolation tests: one startAuthedTestServer() call for the first user,
 * then one or more signUpSecondUser(baseUrl) calls for every additional account, all sharing the
 * same server/DB so their data can be checked against each other.
 */
async function signUpSecondUser(baseUrl, { username } = {}) {
  testUserCounter += 1;
  const resolvedUsername = username || `test-user-${testUserCounter}`;
  const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: resolvedUsername, password: 'test-password-123' }),
  });
  const setCookieHeader = signupRes.headers.get('set-cookie');
  const cookie = setCookieHeader ? setCookieHeader.split(';')[0] : null;
  if (!cookie) throw new Error('Test fixture failed to obtain a session cookie from /api/auth/signup');

  function authedFetch(path, opts = {}) {
    return fetch(`${baseUrl}${path}`, { ...opts, headers: { ...(opts.headers || {}), Cookie: cookie } });
  }

  return { cookie, authedFetch };
}

module.exports = { startTestServer, startAuthedTestServer, signUpSecondUser };
