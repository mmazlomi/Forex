'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');

async function json(res) {
  return res.json();
}

test('PUT /api/assets/:symbol/adaptive-tp toggles the opt-in flag, defaults to off, validates input', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  await authedFetch('/api/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto' }),
  });

  const list = await json(await authedFetch('/api/assets'));
  assert.equal(list.data[0].adaptive_tp_enabled, 0, 'off by default');

  const on = await authedFetch('/api/assets/BTC%2FUSDT/adaptive-tp?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  const onBody = await json(on);
  assert.equal(on.status, 200);
  assert.equal(onBody.data.adaptive_tp_enabled, 1);

  const off = await authedFetch('/api/assets/BTC%2FUSDT/adaptive-tp?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await json(off)).data.adaptive_tp_enabled, 0);

  const missingExchange = await authedFetch('/api/assets/BTC%2FUSDT/adaptive-tp', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(missingExchange.status, 400);

  const invalidBody = await authedFetch('/api/assets/BTC%2FUSDT/adaptive-tp?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }),
  });
  assert.equal(invalidBody.status, 400);
  assert.equal((await json(invalidBody)).errorCode, 'VALIDATION_ERROR');

  const notFound = await authedFetch('/api/assets/ETH%2FUSDT/adaptive-tp?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(notFound.status, 404);
  assert.equal((await json(notFound)).errorCode, 'ASSET_NOT_FOUND');
});
