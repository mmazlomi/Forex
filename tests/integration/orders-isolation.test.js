'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');

async function json(res) {
  return res.json();
}

test('demo/real order isolation and disabled-live-trading guard', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  // Market data is network-dependent (ccxt); mocked here so this suite runs offline and
  // deterministically, per the "Real Trading with mocked testing" requirement.
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price: 50000,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  }));

  await t.test('a well-formed demo order fills and opens a position', async () => {
    const res = await authedFetch('/api/orders/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000 }),
    });
    const body = await json(res);
    assert.equal(res.status, 201);
    assert.equal(body.data.status, 'filled');
  });

  await t.test('demo order does not appear in the real order history', async () => {
    const res = await authedFetch('/api/orders?mode=real');
    const body = await json(res);
    assert.equal(body.data.length, 0);
  });

  await t.test('demo portfolio shows the open position; real portfolio is untouched', async () => {
    const demoPortfolio = await json(await authedFetch('/api/portfolio?mode=demo'));
    const realPortfolio = await json(await authedFetch('/api/portfolio?mode=real'));
    assert.equal(demoPortfolio.data.openPositions.length, 1);
    assert.equal(realPortfolio.data.openPositions.length, 0);
    assert.equal(realPortfolio.data.balance, 0); // real balance is never fabricated/defaulted
  });

  await t.test('real orders are rejected when ENABLE_LIVE_TRADING is not true, and never fall back to demo', async () => {
    const res = await authedFetch('/api/orders/real', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, confirmationText: 'CONFIRM' }),
    });
    const body = await json(res);
    assert.equal(res.status, 403);
    assert.equal(body.errorCode, 'LIVE_TRADING_DISABLED');

    // Confirm no real position/order was created as a side effect, and demo's position count is unaffected.
    const realPortfolio = await json(await authedFetch('/api/portfolio?mode=real'));
    assert.equal(realPortfolio.data.openPositions.length, 0);
    const demoPortfolio = await json(await authedFetch('/api/portfolio?mode=demo'));
    assert.equal(demoPortfolio.data.openPositions.length, 1); // unchanged by the failed real attempt
  });

});

test('a demo order with an explicit qty trades that exact amount, still bounded by max risk per trade', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price: 50000,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  }));

  // Default demo balance 10000, 1% max risk -> maxRiskAmount 100; stop is 5000 away from entry
  // -> auto-sizing would give 0.02. 0.01 stays under that ceiling, so it should just work.
  await t.test('qty under the risk ceiling is accepted and used exactly', async () => {
    const res = await authedFetch('/api/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, qty: 0.01 }),
    });
    const body = await json(res);
    assert.equal(res.status, 201);
    assert.equal(body.data.status, 'filled');
    assert.equal(body.data.qty, 0.01);
  });

  await t.test('qty over the risk ceiling is rejected, not silently clamped', async () => {
    // A different symbol than the sub-test above, purely to sidestep the (separately-tested)
    // duplicate-order guard, which would otherwise trip first on an identical symbol/side/price
    // submitted again within its 5-second window.
    const res = await authedFetch('/api/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'ETH/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, qty: 0.05 }),
    });
    const body = await json(res);
    assert.equal(body.errorCode, 'RISK_AMOUNT_TOO_LARGE');
    assert.match(body.message, /Maximum amount at this stop distance: 0\.02/);
  });
});

test('invalid mode query parameter is rejected before touching any service', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const res = await authedFetch('/api/portfolio?mode=production');
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.errorCode, 'INVALID_MODE');
});

test('emergency stop blocks new demo orders and reset restores them', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price: 50000,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  }));

  await authedFetch('/api/emergency-stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'demo', reason: 'test' }),
  });

  const blockedRes = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000 }),
  });
  const blockedBody = await json(blockedRes);
  assert.equal(blockedBody.errorCode, 'EMERGENCY_STOP_ACTIVE');

  await authedFetch('/api/emergency-stop/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'demo', confirm: true }),
  });

  const allowedRes = await authedFetch('/api/orders/demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000 }),
  });
  const allowedBody = await json(allowedRes);
  assert.equal(allowedBody.data.status, 'filled');
});
