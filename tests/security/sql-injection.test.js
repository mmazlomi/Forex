'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');

test('SQL-injection-shaped input in query/body params is treated as inert data, never executed', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  // Deterministic/offline stand-in for the exchange client used by POST /api/assets, so this
  // security test doesn't depend on real network access.
  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => ({
    loadMarkets: async () => {},
    markets: {},
  }));

  const injection = "'; DROP TABLE signals; --";

  // GET with an injection-shaped mode value: rejected by validation (not a valid enum),
  // and must not have damaged the schema either way.
  const res1 = await authedFetch(`/api/portfolio?mode=${encodeURIComponent(injection)}`);
  assert.equal(res1.status, 400);

  // GET with an injection-shaped symbol on the logs/signals list endpoints — must come back
  // as a normal (possibly empty) result, not a 500, and must not corrupt the database.
  const res2 = await authedFetch(`/api/signals?symbol=${encodeURIComponent(injection)}`);
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.deepEqual(body2.data, []);

  // Confirm the signals table still exists and is queryable after the injection attempts.
  const res3 = await authedFetch('/api/signals');
  assert.equal(res3.status, 200);

  // POST body field with injection-shaped content (e.g. a malicious symbol) must be stored
  // verbatim as data (or rejected as invalid), never interpreted as SQL.
  const res4 = await authedFetch('/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: injection, exchange: 'kucoin', assetType: 'crypto' }),
  });
  // This exchange lookup will fail validation (symbol won't exist on the exchange) — the
  // important assertion is that it fails safely (400/500-from-network, not a corrupted DB),
  // and the system is still functional afterward:
  assert.ok(res4.status === 400 || res4.status === 500);
  const res5 = await authedFetch('/api/assets');
  assert.equal(res5.status, 200); // table intact, still queryable
});
