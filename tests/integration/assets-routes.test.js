'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');

async function json(res) {
  return res.json();
}

test('PUT /api/assets/:symbol/timeframe updates default_timeframe and validates against SUPPORTED_TIMEFRAMES', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  await authedFetch('/api/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto', defaultTimeframe: '1h' }),
  });

  const res = await authedFetch('/api/assets/BTC%2FUSDT/timeframe?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultTimeframe: '4h' }),
  });
  const body = await json(res);
  assert.equal(res.status, 200);
  assert.equal(body.data.default_timeframe, '4h');

  const list = await json(await authedFetch('/api/assets'));
  assert.equal(list.data[0].default_timeframe, '4h');

  const invalid = await authedFetch('/api/assets/BTC%2FUSDT/timeframe?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultTimeframe: 'not-a-timeframe' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await json(invalid)).errorCode, 'VALIDATION_ERROR');

  const missingExchange = await authedFetch('/api/assets/BTC%2FUSDT/timeframe', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultTimeframe: '4h' }),
  });
  assert.equal(missingExchange.status, 400);

  const notFound = await authedFetch('/api/assets/ETH%2FUSDT/timeframe?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultTimeframe: '4h' }),
  });
  assert.equal(notFound.status, 404);
  assert.equal((await json(notFound)).errorCode, 'ASSET_NOT_FOUND');
});

test('PUT /api/assets/:symbol/exchange moves a watchlist entry to a different exchange', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  await authedFetch('/api/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto', defaultTimeframe: '1h' }),
  });

  const res = await authedFetch('/api/assets/BTC%2FUSDT/exchange?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newExchange: 'mexc' }),
  });
  const body = await json(res);
  assert.equal(res.status, 200);
  assert.equal(body.data.exchange, 'mexc');

  const list = await json(await authedFetch('/api/assets'));
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].exchange, 'mexc');

  const sameExchange = await authedFetch('/api/assets/BTC%2FUSDT/exchange?exchange=mexc', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newExchange: 'mexc' }),
  });
  assert.equal(sameExchange.status, 400);
  assert.equal((await json(sameExchange)).errorCode, 'VALIDATION_ERROR');

  const missingNewExchange = await authedFetch('/api/assets/BTC%2FUSDT/exchange?exchange=mexc', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(missingNewExchange.status, 400);

  const notFound = await authedFetch('/api/assets/ETH%2FUSDT/exchange?exchange=mexc', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newExchange: 'kucoin' }),
  });
  assert.equal(notFound.status, 404);
  assert.equal((await json(notFound)).errorCode, 'ASSET_NOT_FOUND');

  await authedFetch('/api/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'ETH/USDT', exchange: 'kucoin', assetType: 'crypto', defaultTimeframe: '1h' }),
  });
  await authedFetch('/api/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'ETH/USDT', exchange: 'mexc', assetType: 'crypto', defaultTimeframe: '1h' }),
  });
  const conflict = await authedFetch('/api/assets/ETH%2FUSDT/exchange?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newExchange: 'mexc' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await json(conflict)).errorCode, 'VALIDATION_ERROR');
});
