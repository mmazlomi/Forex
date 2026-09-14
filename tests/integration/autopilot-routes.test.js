'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');

test('PUT /api/assets/:symbol/autopilot enables and disables autopilot for spot assets', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  // Directly insert asset in DB to avoid live exchange network latency in CI/test
  const userRes = await authedFetch('/api/auth/me');
  const userBody = await userRes.json();
  const userId = userBody.data.id;

  assetsRepository.addAsset(userId, {
    symbol: 'BTC/USDT',
    exchange: 'kucoin',
    market: 'spot',
    assetType: 'crypto',
  });

  // Enable autopilot via HTTP API
  const enableRes = await authedFetch('/api/assets/BTC%2FUSDT/autopilot?exchange=kucoin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enableRes.status, 200);
  const enableBody = await enableRes.json();
  assert.equal(enableBody.success, true);
  assert.equal(enableBody.data.autopilot_enabled, 1);
  assert.equal(enableBody.data.strategy_mode, 'auto');
  assert.equal(enableBody.data.timeframe_mode, 'auto');
  assert.equal(enableBody.data.trailing_mode, 'atr');
  assert.equal(enableBody.data.adaptive_tp_enabled, 1);
  assert.equal(enableBody.data.auto_trade_enabled, 1);

  // Disable autopilot via HTTP API
  const disableRes = await authedFetch('/api/assets/BTC%2FUSDT/autopilot?exchange=kucoin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableRes.status, 200);
  const disableBody = await disableRes.json();
  assert.equal(disableBody.success, true);
  assert.equal(disableBody.data.autopilot_enabled, 0);

  // Validation errors
  const noExchangeRes = await authedFetch('/api/assets/BTC%2FUSDT/autopilot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(noExchangeRes.status, 400);

  const badBodyRes = await authedFetch('/api/assets/BTC%2FUSDT/autopilot?exchange=kucoin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' }),
  });
  assert.equal(badBodyRes.status, 400);
});

test('PUT /api/futures/assets/:symbol/autopilot enables and disables autopilot for demo futures', async (t) => {
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

  const enableRes = await authedFetch('/api/futures/assets/ETH%2FUSDT%3AUSDT/autopilot?mode=demo&exchange=binance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enableRes.status, 200);
  const enableBody = await enableRes.json();
  assert.equal(enableBody.data.autopilot_enabled, 1);
  assert.equal(enableBody.data.strategy_mode, 'auto');
  assert.equal(enableBody.data.timeframe_mode, 'auto');
  assert.equal(enableBody.data.trailing_mode, 'atr');
  assert.equal(enableBody.data.adaptive_tp_enabled, 1);
  assert.equal(enableBody.data.auto_trade_enabled, 1);

  const disableRes = await authedFetch('/api/futures/assets/ETH%2FUSDT%3AUSDT/autopilot?mode=demo&exchange=binance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableRes.status, 200);
  const disableBody = await disableRes.json();
  assert.equal(disableBody.data.autopilot_enabled, 0);
});
