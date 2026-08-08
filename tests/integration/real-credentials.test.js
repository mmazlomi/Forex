'use strict';

// Own process (node --test isolates files): ENABLE_LIVE_TRADING=true but deliberately NO
// REAL_EXCHANGE_NAME/REAL_API_KEY/REAL_API_SECRET in .env, so credentials must come entirely
// from the database (or be absent) — proves the DB path actually feeds real-orders.js/
// exchange-client-factory.js, not just the .env path already covered by
// real-trading-enabled.test.js.
process.env.ENABLE_LIVE_TRADING = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');

function fakeSnapshot() {
  return {
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price: 50000,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  };
}

// Grouped into two top-level tests (each doing exactly one startAuthedTestServer() signup)
// rather than one signup per assertion — POST /api/auth/signup is deliberately rate-limited to
// 5/minute/IP to deter abuse (auth-routes.js), and a fresh signup per assertion here would blow
// straight through that limit since these all run within milliseconds of each other.

test('validation: unrecognized exchange id and missing key/secret are rejected, status starts "not configured"', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  await t.test('GET status reflects "not configured" before anything is saved', async () => {
    const res = await authedFetch('/api/real-exchange-credentials');
    const body = await res.json();
    assert.equal(body.data.configured, false);
    assert.equal(body.data.source, 'none');
  });

  await t.test('PUT rejects an unrecognized exchange id', async () => {
    const res = await authedFetch('/api/real-exchange-credentials', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchangeName: 'not-a-real-exchange', apiKey: 'k', apiSecret: 's' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.errorCode, 'VALIDATION_ERROR');
  });

  await t.test('PUT rejects a missing apiKey/apiSecret', async () => {
    const res = await authedFetch('/api/real-exchange-credentials', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchangeName: 'kucoin', apiKey: '', apiSecret: '' }),
    });
    assert.equal(res.status, 400);
  });
});

test('full lifecycle: missing -> saved (masked, never round-tripped, unblocks a real order) -> cleared', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => fakeSnapshot());

  await t.test('a real order is rejected with MISSING_REAL_CREDENTIALS when nothing is configured anywhere', async () => {
    const res = await authedFetch('/api/orders/real', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, confirmationText: 'CONFIRM' }),
    });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.errorCode, 'MISSING_REAL_CREDENTIALS');
  });

  await t.test('saving credentials via PUT: status reflects them, never returns the raw key/secret', async () => {
    const saveRes = await authedFetch('/api/real-exchange-credentials', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchangeName: 'kucoin', apiKey: 'my-real-secret-api-key-12345', apiSecret: 'my-real-secret-value-67890' }),
    });
    assert.equal(saveRes.status, 200);
    const saveBody = await saveRes.json();
    assert.equal(saveBody.data.configured, true);
    assert.equal(saveBody.data.source, 'database');
    assert.ok(!JSON.stringify(saveBody).includes('my-real-secret-api-key-12345'));
    assert.ok(!JSON.stringify(saveBody).includes('my-real-secret-value-67890'));

    const statusRes = await authedFetch('/api/real-exchange-credentials');
    const statusBody = await statusRes.json();
    assert.equal(statusBody.data.configured, true);
    assert.equal(statusBody.data.exchangeName, 'kucoin');
    assert.ok(!JSON.stringify(statusBody).includes('my-real-secret-api-key-12345'));
  });

  await t.test('a real order no longer fails with MISSING_REAL_CREDENTIALS once saved', async () => {
    const fakeExchange = {
      fetchBalance: async () => ({ free: { USDT: 10000 } }),
      createOrder: async (symbol, type, side, qty) => ({ id: 'exch-order-1', symbol, type, side, qty }),
    };
    t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeExchange);

    const orderRes = await authedFetch('/api/orders/real', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, confirmationText: 'CONFIRM' }),
    });
    const orderBody = await orderRes.json();
    assert.equal(orderRes.status, 201);
    assert.equal(orderBody.data.status, 'filled');
  });

  await t.test('DELETE clears database-stored credentials back to "not configured" (no .env fallback in this test env)', async () => {
    const clearRes = await authedFetch('/api/real-exchange-credentials', { method: 'DELETE' });
    const clearBody = await clearRes.json();
    assert.equal(clearBody.data.configured, false);

    const statusRes = await authedFetch('/api/real-exchange-credentials');
    const statusBody = await statusRes.json();
    assert.equal(statusBody.data.configured, false);
  });
});
