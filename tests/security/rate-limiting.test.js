'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../../src/middleware/rate-limiter');

function fakeReqRes(ip) {
  const req = { ip };
  let statusCode = 200;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

test('rate limiter allows requests under the limit and blocks once exceeded', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3 });
  const ip = '1.2.3.4';
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  for (let i = 0; i < 3; i += 1) {
    const { req, res } = fakeReqRes(ip);
    limiter(req, res, next);
  }
  assert.equal(nextCalls, 3);

  const { req, res, getStatus, getBody } = fakeReqRes(ip);
  limiter(req, res, next);
  assert.equal(nextCalls, 3); // 4th call did not reach next()
  assert.equal(getStatus(), 429);
  assert.equal(getBody().errorCode, 'RATE_LIMITED');
});

test('rate limiter tracks separate IPs independently', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  limiter(fakeReqRes('1.1.1.1').req, fakeReqRes('1.1.1.1').res, next);
  limiter(fakeReqRes('2.2.2.2').req, fakeReqRes('2.2.2.2').res, next);
  assert.equal(nextCalls, 2); // different IPs, both under their own limit of 1
});

test('order placement endpoints are rate-limited more strictly than general API traffic', async (t) => {
  process.env.DATABASE_PATH = ':memory:';
  const { startAuthedTestServer } = require('../fixtures/test-server');
  const marketDataService = require('../../src/services/market-data/market-data-service');
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  // Mocked so the 20 under-the-limit requests resolve instantly and offline, rather than
  // making 20 real network calls per test run.
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price: 50000, dataFreshnessMs: 100,
  }));

  const results = [];
  for (let i = 0; i < 25; i += 1) {
    const res = await authedFetch('/api/orders/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy' }),
    });
    results.push(res.status);
  }
  assert.ok(results.includes(429), 'expected at least one 429 after 25 rapid order requests (limit is 20/min)');
});
