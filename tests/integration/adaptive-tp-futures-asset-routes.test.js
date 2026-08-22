'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');

async function json(res) {
  return res.json();
}

test('PUT /api/futures/assets/:symbol/adaptive-tp toggles per mode, demo/real independent, validates input', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  await authedFetch('/api/futures/assets?mode=demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 }),
  });
  await authedFetch('/api/futures/assets?mode=real', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 2 }),
  });

  const demoOn = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT/adaptive-tp?mode=demo&exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal((await json(demoOn)).data.adaptive_tp_enabled, 1);

  const real = await json(await authedFetch('/api/futures/assets?mode=real'));
  assert.equal(real.data[0].adaptive_tp_enabled, 0, 'toggling demo must not affect the real entry');

  const invalidMode = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT/adaptive-tp?exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(invalidMode.status, 400);

  const invalidBody = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT/adaptive-tp?mode=demo&exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(invalidBody.status, 400);
  assert.equal((await json(invalidBody)).errorCode, 'VALIDATION_ERROR');

  const notFound = await authedFetch('/api/futures/assets/ETH%2FUSDT%3AUSDT/adaptive-tp?mode=demo&exchange=kucoin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(notFound.status, 404);
  assert.equal((await json(notFound)).errorCode, 'ASSET_NOT_FOUND');
});
