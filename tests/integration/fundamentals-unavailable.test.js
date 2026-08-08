'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');

test('stock fundamentals return "unavailable" (never fabricated) when no API key is configured', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const res = await authedFetch('/api/fundamentals?symbol=AAPL&assetType=stock');
  const body = await res.json();
  assert.equal(res.status, 200);

  for (const [field, entry] of Object.entries(body.data.fields)) {
    if (['fdv', 'circulatingSupply', 'totalSupply', 'volume24h', 'liquidity', 'exchangeListings', 'events'].includes(field)) {
      assert.equal(entry.value, 'not_applicable', `${field} should be not_applicable for a stock`);
    } else {
      assert.equal(entry.value, 'unavailable', `${field} should be unavailable without an API key, not fabricated`);
    }
  }
});

test('an invalid assetType is rejected with a clear validation error, not silently defaulted', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const res = await authedFetch('/api/fundamentals?symbol=AAPL&assetType=commodity');
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.errorCode, 'VALIDATION_ERROR');
});
