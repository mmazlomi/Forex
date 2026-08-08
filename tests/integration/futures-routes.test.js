'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');

async function json(res) {
  return res.json();
}

function mockPrice(t, price = 60000) {
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => ({
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

test('futures routes: watchlist CRUD, order placement, and portfolio isolation from spot', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  mockPrice(t);

  await t.test('POST /api/futures/assets?mode=demo adds a watchlist entry', async () => {
    const res = await authedFetch('/api/futures/assets?mode=demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 5 }),
    });
    const body = await json(res);
    assert.equal(res.status, 201);
    assert.equal(body.data.symbol, 'BTC/USDT:USDT');
    assert.equal(body.data.leverage, 5);
  });

  await t.test('POST /api/futures/assets requires a valid mode query param', async () => {
    const res = await authedFetch('/api/futures/assets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'ETH/USDT:USDT', exchange: 'kucoin' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).errorCode, 'INVALID_MODE');
  });

  await t.test('POST /api/futures/assets rejects a non-KuCoin exchange', async () => {
    const res = await authedFetch('/api/futures/assets?mode=demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'ETH/USDT:USDT', exchange: 'binance' }),
    });
    assert.equal(res.status, 400);
  });

  await t.test('GET /api/futures/assets?mode=demo lists it back; mode=real is empty', async () => {
    const demo = await json(await authedFetch('/api/futures/assets?mode=demo'));
    assert.equal(demo.data.length, 1);
    const real = await json(await authedFetch('/api/futures/assets?mode=real'));
    assert.equal(real.data.length, 0);
  });

  await t.test('the same symbol can be independently added to the real watchlist with different leverage', async () => {
    const res = await authedFetch('/api/futures/assets?mode=real', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', leverage: 2 }),
    });
    const body = await json(res);
    assert.equal(res.status, 201);
    assert.equal(body.data.leverage, 2);

    const demo = await json(await authedFetch('/api/futures/assets?mode=demo'));
    assert.equal(demo.data[0].leverage, 5, 'demo entry for the same symbol is untouched');
  });

  await t.test('PUT auto-trade toggle only affects the specified mode', async () => {
    const res1 = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT/auto-trade?mode=demo&exchange=kucoin', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    assert.equal((await json(res1)).data.auto_trade_enabled, 1);

    const real = await json(await authedFetch('/api/futures/assets?mode=real'));
    assert.equal(real.data[0].auto_trade_enabled, 0, 'toggling demo auto-trade must not affect the real entry');

    const res2 = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT/auto-trade?mode=real&exchange=kucoin', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    const body2 = await json(res2);
    assert.equal(body2.data.auto_trade_enabled, 1);
    assert.match(body2.message, /ENABLE_FUTURES_AUTO_TRADING/); // server hasn't set the env flag in this test run
  });

  await t.test('PUT timeframe updates default_timeframe and rejects an unsupported value', async () => {
    const res = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT/timeframe?mode=demo&exchange=kucoin', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultTimeframe: '4h' }),
    });
    const body = await json(res);
    assert.equal(res.status, 200);
    assert.equal(body.data.default_timeframe, '4h');

    const real = await json(await authedFetch('/api/futures/assets?mode=real'));
    assert.equal(real.data[0].default_timeframe, '1h', 'changing demo timeframe must not affect the real entry');

    const invalid = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT/timeframe?mode=demo&exchange=kucoin', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultTimeframe: '3h' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).errorCode, 'VALIDATION_ERROR');
  });

  await t.test('POST /api/futures/orders/demo opens a long position', async () => {
    const res = await authedFetch('/api/futures/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000 }),
    });
    const body = await json(res);
    assert.equal(res.status, 201);
    assert.equal(body.data.status, 'filled');
    assert.equal(body.data.action, 'open_long');
  });

  await t.test('GET /api/futures/portfolio?mode=demo shows the open position; real is untouched', async () => {
    const demo = await json(await authedFetch('/api/futures/portfolio?mode=demo'));
    const real = await json(await authedFetch('/api/futures/portfolio?mode=real'));
    assert.equal(demo.data.openPositions.length, 1);
    assert.equal(demo.data.openPositions[0].side, 'long');
    assert.equal(real.data.openPositions.length, 0);
  });

  await t.test('futures portfolio is isolated from spot portfolio', async () => {
    const spotDemo = await json(await authedFetch('/api/portfolio?mode=demo'));
    assert.equal(spotDemo.data.openPositions.length, 0); // the futures position must not leak into spot's list
  });

  await t.test('a second open_long for the same symbol is rejected (one-way mode)', async () => {
    mockPrice(t, 60001); // dodge the duplicate-order-window guard (separately tested elsewhere)
    const res = await authedFetch('/api/futures/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000 }),
    });
    const body = await json(res);
    assert.equal(body.errorCode, 'POSITION_ALREADY_OPEN');
    assert.equal(res.status, 409);
  });

  await t.test('real futures orders are rejected when ENABLE_LIVE_TRADING is not true', async () => {
    const res = await authedFetch('/api/futures/orders/real', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000, confirmationText: 'CONFIRM' }),
    });
    const body = await json(res);
    assert.equal(res.status, 403);
    assert.equal(body.errorCode, 'LIVE_TRADING_DISABLED');
  });

  await t.test('DELETE removes only from the specified mode', async () => {
    const res = await authedFetch('/api/futures/assets/BTC%2FUSDT%3AUSDT?mode=demo&exchange=kucoin', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const demo = await json(await authedFetch('/api/futures/assets?mode=demo'));
    assert.equal(demo.data.length, 0);
    const real = await json(await authedFetch('/api/futures/assets?mode=real'));
    assert.equal(real.data.length, 1, 'the real watchlist entry for the same symbol must survive a demo-mode delete');
  });
});

test('GET /api/futures/risk-settings returns defaults including maxLeverage', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  const body = await json(await authedFetch('/api/futures/risk-settings?mode=demo'));
  assert.equal(body.data.max_leverage, 10);
});
