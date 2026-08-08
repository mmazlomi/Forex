'use strict';

// Deliberately NOT setting ENABLE_LIVE_TRADING here — proving that viewing/syncing balance is a
// read-only action that works regardless of the live-trading kill-switch, unlike actually
// placing an order (real-orders.js requires it). See docs for the "portfolio didn't show after
// entering an API key" fix this covers: balance previously only ever synced as a side effect of
// placing an order, so there was no way to just check it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');

test('syncing real balance: missing credentials, then a successful sync without ENABLE_LIVE_TRADING, then an exchange failure', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  await t.test('rejected with MISSING_REAL_CREDENTIALS when nothing is configured', async () => {
    const res = await authedFetch('/api/portfolio/real/sync-balance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin' }),
    });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.errorCode, 'MISSING_REAL_CREDENTIALS');
  });

  await t.test('rejected with VALIDATION_ERROR when symbol/exchange are missing', async () => {
    const res = await authedFetch('/api/portfolio/real/sync-balance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  await t.test('saving credentials then syncing succeeds and updates the portfolio — no ENABLE_LIVE_TRADING needed', async () => {
    await authedFetch('/api/real-exchange-credentials', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchangeName: 'kucoin', apiKey: 'k', apiSecret: 's' }),
    });

    // A multi-currency wallet (IRT, USDT, BTC, plus a zero-balance currency the exchange still
    // reports) — an exchange like Nobitex can hold several at once, which is exactly what
    // motivated returning the full breakdown alongside the single quote-scoped balance.
    const fakeExchange = { fetchBalance: async () => ({ free: { USDT: 1234.56, IRT: 5000000, BTC: 0.01, ETH: 0 } }) };
    t.mock.method(exchangeClientFactory, 'getRealExchange', () => fakeExchange);

    const res = await authedFetch('/api/portfolio/real/sync-balance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.balance, 1234.56); // scoped to the requested symbol's quote currency (USDT)
    // Full breakdown: sorted descending by amount, zero-balance currencies excluded.
    assert.deepEqual(body.data.walletBalances, [
      { currency: 'IRT', amount: 5000000 },
      { currency: 'USDT', amount: 1234.56 },
      { currency: 'BTC', amount: 0.01 },
    ]);

    // Persisted, not just returned from the sync call itself — a later, independent GET (e.g.
    // switching to the Real tab on a fresh page load) must show the same breakdown without
    // requiring another live exchange call.
    const portfolioRes = await authedFetch('/api/portfolio?mode=real');
    const portfolioBody = await portfolioRes.json();
    assert.equal(portfolioBody.data.balance, 1234.56);
    assert.deepEqual(portfolioBody.data.walletBalances, [
      { currency: 'IRT', amount: 5000000 },
      { currency: 'USDT', amount: 1234.56 },
      { currency: 'BTC', amount: 0.01 },
    ]);
  });

  await t.test('a failed exchange call is surfaced as EXCHANGE_UNAVAILABLE and leaves the stored balance untouched', async () => {
    const failingExchange = { fetchBalance: async () => { throw new Error('simulated outage'); } };
    t.mock.method(exchangeClientFactory, 'getRealExchange', () => failingExchange);

    const res = await authedFetch('/api/portfolio/real/sync-balance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin' }),
    });
    const body = await res.json();
    assert.equal(res.status, 422);
    assert.equal(body.errorCode, 'EXCHANGE_UNAVAILABLE');

    const portfolioRes = await authedFetch('/api/portfolio?mode=real');
    const portfolioBody = await portfolioRes.json();
    assert.equal(portfolioBody.data.balance, 1234.56); // unchanged from the previous successful sync
  });
});
