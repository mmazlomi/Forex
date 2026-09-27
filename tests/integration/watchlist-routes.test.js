'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const watchlistRepository = require('../../src/database/repositories/watchlist-repository');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');

async function json(res) {
  return res.json();
}

test('WatchList routes: CRUD and PUT /api/watchlist/:symbol/exchange', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => ({
    loadMarkets: async () => {},
    markets: { 'BTC/USDT': { symbol: 'BTC/USDT', active: true } },
  }));

  const userRes = await authedFetch('/api/auth/me');
  const user = await json(userRes);

  await t.test('POST /api/watchlist adds an asset', async () => {
    const res = await authedFetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' }),
    });
    const body = await json(res);
    assert.equal(res.status, 201);
    assert.equal(body.data.symbol, 'BTC/USDT');
    assert.equal(body.data.exchange, 'kucoin');
    assert.equal(body.data.asset_type, 'crypto');
  });

  await t.test('PUT /api/watchlist/:symbol/exchange moves a watchlist entry to a different exchange', async () => {
    const res = await authedFetch('/api/watchlist/BTC%2FUSDT/exchange?exchange=kucoin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newExchange: 'mexc' }),
    });
    const body = await json(res);
    assert.equal(res.status, 200);
    assert.equal(body.data.exchange, 'mexc');

    const list = await json(await authedFetch('/api/watchlist'));
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].exchange, 'mexc');
  });

  await t.test('rejects when newExchange equals current exchange', async () => {
    const res = await authedFetch('/api/watchlist/BTC%2FUSDT/exchange?exchange=mexc', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newExchange: 'mexc' }),
    });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.errorCode, 'VALIDATION_ERROR');
  });

  await t.test('rejects when newExchange is missing', async () => {
    const res = await authedFetch('/api/watchlist/BTC%2FUSDT/exchange?exchange=mexc', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.errorCode, 'VALIDATION_ERROR');
  });

  await t.test('rejects when exchange query parameter is missing', async () => {
    const res = await authedFetch('/api/watchlist/BTC%2FUSDT/exchange', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newExchange: 'kucoin' }),
    });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.errorCode, 'VALIDATION_ERROR');
  });

  await t.test('returns 404 when entry does not exist', async () => {
    const res = await authedFetch('/api/watchlist/NONEXISTENT%2FUSDT/exchange?exchange=mexc', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newExchange: 'kucoin' }),
    });
    assert.equal(res.status, 404);
    const body = await json(res);
    assert.equal(body.errorCode, 'ASSET_NOT_FOUND');
  });

  await t.test('returns 409 when target (symbol, newExchange) already exists in watchlist', async () => {
    watchlistRepository.addItem(user.data.id, {
      symbol: 'ETH/USDT',
      exchange: 'kucoin',
      assetType: 'crypto',
    });
    watchlistRepository.addItem(user.data.id, {
      symbol: 'ETH/USDT',
      exchange: 'mexc',
      assetType: 'crypto',
    });

    const res = await authedFetch('/api/watchlist/ETH%2FUSDT/exchange?exchange=kucoin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newExchange: 'mexc' }),
    });
    assert.equal(res.status, 409);
    const body = await json(res);
    assert.equal(body.errorCode, 'VALIDATION_ERROR');
  });

  await t.test('moves stock asset type without ccxt check', async () => {
    watchlistRepository.addItem(user.data.id, {
      symbol: 'AAPL',
      exchange: 'nasdaq',
      assetType: 'stock',
    });

    const res = await authedFetch('/api/watchlist/AAPL/exchange?exchange=nasdaq', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newExchange: 'nyse' }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.data.exchange, 'nyse');
  });
});
