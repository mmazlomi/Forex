'use strict';

// Two users, one shared server/DB (see signUpSecondUser's comment on why this can't just be two
// startAuthedTestServer() calls) — proving the per-user data isolation migration actually holds
// at the HTTP boundary: one account can never see, list, cancel, or dedupe-collide with another
// account's orders/positions/portfolio, even when both place structurally identical requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer, signUpSecondUser } = require('../fixtures/test-server');
const marketDataService = require('../../src/services/market-data/market-data-service');

async function json(res) {
  return res.json();
}

test('cross-user order/position/portfolio isolation', async (t) => {
  const { close, baseUrl, authedFetch: aliceFetch } = await startAuthedTestServer();
  t.after(close);
  const { authedFetch: bobFetch } = await signUpSecondUser(baseUrl);

  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price: 50000,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  }));

  await t.test('alice opens a demo position; bob sees none of it', async () => {
    const res = await aliceFetch('/api/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000 }),
    });
    const body = await json(res);
    assert.equal(res.status, 201);
    assert.equal(body.data.status, 'filled');

    const aliceOrders = await json(await aliceFetch('/api/orders?mode=demo'));
    assert.equal(aliceOrders.data.length, 1);

    const bobOrders = await json(await bobFetch('/api/orders?mode=demo'));
    assert.equal(bobOrders.data.length, 0, "bob's order list must not include alice's order");

    const bobPortfolio = await json(await bobFetch('/api/portfolio?mode=demo'));
    assert.equal(bobPortfolio.data.openPositions.length, 0, "bob's portfolio must not include alice's position");
    assert.equal(bobPortfolio.data.balance, 10000, "bob's balance must be his own fresh default, not affected by alice's trade");
  });

  await t.test("bob cannot cancel alice's pending order — gets ORDER_NOT_FOUND, not a leak or a successful cancel", async () => {
    const pendingRes = await aliceFetch('/api/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // stopLoss/takeProfit are relative to the LIMIT price (40000) this order will actually
        // fill at, not the current 50000 market price — 35000/65000 keeps 40000 strictly between
        // them, a valid setup (see validate-trade.js's ENTRY_OUTSIDE_RISK_RANGE check).
        symbol: 'ETH/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 35000, takeProfit: 65000,
        orderType: 'limit', limitPrice: 40000, // far below the mocked 50000 price -> stays pending
      }),
    });
    const pendingOrder = (await json(pendingRes)).data;
    assert.equal(pendingOrder.status, 'pending');

    const cancelAsBob = await bobFetch(`/api/orders/demo/${pendingOrder.id}/cancel`, { method: 'POST' });
    const cancelBody = await json(cancelAsBob);
    assert.equal(cancelAsBob.status, 404);
    assert.equal(cancelBody.errorCode, 'ORDER_NOT_FOUND');

    // Confirm it's genuinely untouched — alice can still cancel her own order afterward.
    const cancelAsAlice = await aliceFetch(`/api/orders/demo/${pendingOrder.id}/cancel`, { method: 'POST' });
    assert.equal(cancelAsAlice.status, 200);
  });

  await t.test('idempotency keys do not dedupe across users — bob gets his own order, not a cached copy of the same key from alice', async () => {
    const sharedKey = 'shared-idempotency-key-across-users';

    const aliceRes = await aliceFetch('/api/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'SOL/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, idempotencyKey: sharedKey }),
    });
    const aliceOrder = (await json(aliceRes)).data;
    assert.equal(aliceOrder.status, 'filled');

    const bobRes = await bobFetch('/api/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'SOL/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 45000, takeProfit: 65000, idempotencyKey: sharedKey }),
    });
    const bobOrder = (await json(bobRes)).data;
    assert.equal(bobRes.status, 201);
    assert.equal(bobOrder.status, 'filled');
    assert.notEqual(bobOrder.id, aliceOrder.id, "bob's order must be genuinely his own, not alice's cached idempotent response");

    const bobOrders = await json(await bobFetch('/api/orders?mode=demo'));
    assert.equal(bobOrders.data.length, 1);
  });
});
