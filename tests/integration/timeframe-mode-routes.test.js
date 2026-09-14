'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');

test('PUT /api/assets/:symbol/timeframe-mode sets auto and manual timeframe modes for spot assets', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const userRes = await authedFetch('/api/auth/me');
  const userBody = await userRes.json();
  const userId = userBody.data.id;

  assetsRepository.addAsset(userId, {
    symbol: 'BTC/USDT',
    exchange: 'kucoin',
    market: 'spot',
    assetType: 'crypto',
  });

  // Switch to auto
  const autoRes = await authedFetch('/api/assets/BTC%2FUSDT/timeframe-mode?exchange=kucoin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto' }),
  });
  assert.equal(autoRes.status, 200);
  const autoBody = await autoRes.json();
  assert.equal(autoBody.success, true);
  assert.equal(autoBody.data.timeframe_mode, 'auto');

  // Switch back to manual
  const manualRes = await authedFetch('/api/assets/BTC%2FUSDT/timeframe-mode?exchange=kucoin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'manual' }),
  });
  assert.equal(manualRes.status, 200);
  const manualBody = await manualRes.json();
  assert.equal(manualBody.data.timeframe_mode, 'manual');

  // Validation: bad mode
  const badRes = await authedFetch('/api/assets/BTC%2FUSDT/timeframe-mode?exchange=kucoin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'invalid' }),
  });
  assert.equal(badRes.status, 400);

  // Validation: missing exchange
  const noExRes = await authedFetch('/api/assets/BTC%2FUSDT/timeframe-mode', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto' }),
  });
  assert.equal(noExRes.status, 400);

  // 404: unknown symbol
  const notFoundRes = await authedFetch('/api/assets/ETH%2FUSDT/timeframe-mode?exchange=kucoin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto' }),
  });
  assert.equal(notFoundRes.status, 404);
});

test('PUT /api/futures/assets/:symbol/timeframe-mode sets auto and manual timeframe modes for futures assets', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const userRes = await authedFetch('/api/auth/me');
  const userBody = await userRes.json();
  const userId = userBody.data.id;

  futuresAssetsRepository.addAsset('demo', userId, {
    symbol: 'ETH/USDT:USDT',
    exchange: 'binance',
    leverage: 3,
  });

  // Switch to auto
  const autoRes = await authedFetch('/api/futures/assets/ETH%2FUSDT%3AUSDT/timeframe-mode?mode=demo&exchange=binance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto' }),
  });
  assert.equal(autoRes.status, 200);
  const autoBody = await autoRes.json();
  assert.equal(autoBody.success, true);
  assert.equal(autoBody.data.timeframe_mode, 'auto');

  // Switch back to manual
  const manualRes = await authedFetch('/api/futures/assets/ETH%2FUSDT%3AUSDT/timeframe-mode?mode=demo&exchange=binance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'manual' }),
  });
  assert.equal(manualRes.status, 200);
  const manualBody = await manualRes.json();
  assert.equal(manualBody.data.timeframe_mode, 'manual');

  // Validation: bad mode
  const badRes = await authedFetch('/api/futures/assets/ETH%2FUSDT%3AUSDT/timeframe-mode?mode=demo&exchange=binance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'dynamic' }),
  });
  assert.equal(badRes.status, 400);

  // 404: unknown symbol
  const notFoundRes = await authedFetch('/api/futures/assets/SOL%2FUSDT%3AUSDT/timeframe-mode?mode=demo&exchange=binance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto' }),
  });
  assert.equal(notFoundRes.status, 404);
});
