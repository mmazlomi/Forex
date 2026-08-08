'use strict';

// ccxt has no Nobitex support at all, so this is a hand-written adapter against Nobitex's own
// REST API (see src/services/exchanges/custom-exchanges/nobitex-exchange.js and
// docs/architecture.md §16). These tests mock fetch entirely — no real network calls — and
// assert against the exact request/response shapes taken from Nobitex's official docs
// (https://github.com/nobitex/docs-api).

const test = require('node:test');
const assert = require('node:assert/strict');
const NobitexExchange = require('../../src/services/exchanges/custom-exchanges/nobitex-exchange');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, statusText: 'OK', json: async () => body };
}

// loadMarkets() now derives the live market list from /market/stats called with no
// srcCurrency/dstCurrency filter (Nobitex returns stats for every market it currently offers,
// keyed by "base-quote") rather than a hand-maintained static list — a stale static list is what
// caused real "InvalidCurrency" failures for renamed/delisted assets (MATIC->POL, RNDR->RENDER,
// EOS/TON delisted entirely). This fixture stands in for that live response in every test below.
function marketStatsFixture() {
  return {
    'btc-usdt': { isClosed: false, bestSell: '65010', bestBuy: '65000', volumeSrc: '10', volumeDst: '650000', latest: '65000', mark: '65005', dayLow: '64000', dayHigh: '66000', dayOpen: '64500', dayClose: '65000', dayChange: '0.7' },
    'btc-rls': { isClosed: false, bestSell: '750360000', bestBuy: '750350000', volumeSrc: '0.3', volumeDst: '1', latest: '750350000', mark: '750400000', dayLow: '0', dayHigh: '0', dayOpen: '0', dayClose: '0', dayChange: '9.38' },
    '1m_btt-rls': { isClosed: true, bestSell: '0', bestBuy: '0', volumeSrc: '0', volumeDst: '0', latest: '0', mark: '498570', dayLow: '0', dayHigh: '0', dayOpen: '0', dayClose: '0', dayChange: '0' },
  };
}

function mockFetchDispatcher(t, handlers) {
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const urlStr = String(url);
    if (!urlStr.includes('?') && urlStr.endsWith('/market/stats')) {
      return jsonResponse({ status: 'ok', stats: marketStatsFixture(), global: {} });
    }
    for (const [match, handler] of handlers) {
      if (urlStr.includes(match)) return handler(urlStr, opts);
    }
    throw new Error(`unexpected URL in test: ${urlStr}`);
  });
}

test('loadMarkets derives markets from live /market/stats, including multiplier-prefixed tokens and closed-market active:false', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, []);
  await client.loadMarkets();

  assert.deepEqual(client.markets['BTC/USDT'], { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true });
  assert.deepEqual(client.markets['BTC/IRT'], { id: 'BTCIRT', symbol: 'BTC/IRT', base: 'BTC', quote: 'IRT', active: true, spot: true });
  // "1m_btt-rls" -> base "1M_BTT", quote "IRT" — must not be mis-split by a naive fixed-length cut.
  assert.deepEqual(client.markets['1M_BTT/IRT'], { id: '1M_BTTIRT', symbol: '1M_BTT/IRT', base: '1M_BTT', quote: 'IRT', active: false, spot: true });
});

test('timeframes map to Nobitex resolutions and omit "1w" (no weekly resolution exists on Nobitex)', () => {
  const client = new NobitexExchange();
  assert.equal(client.timeframes['1m'], '1');
  assert.equal(client.timeframes['1h'], '60');
  assert.equal(client.timeframes['4h'], '240');
  assert.equal(client.timeframes['1d'], 'D');
  assert.equal(client.timeframes['1w'], undefined);
});

test('fetchTicker maps /market/stats fields and uses the "rls" currency code for IRT pairs', async (t) => {
  const client = new NobitexExchange();
  let requestedUrl;
  mockFetchDispatcher(t, [
    ['/market/stats?', async (url) => {
      requestedUrl = url;
      return jsonResponse({ status: 'ok', stats: { 'btc-rls': { latest: '750350000', mark: '750400000', dayChange: '9.38', volumeSrc: '0.292948' } } });
    }],
  ]);
  await client.loadMarkets();

  const ticker = await client.fetchTicker('BTC/IRT');
  assert.ok(requestedUrl.includes('srcCurrency=btc'));
  assert.ok(requestedUrl.includes('dstCurrency=rls')); // not "irt" — see nobitexCurrencyCode()
  assert.equal(ticker.last, 75035000); // Rial (750350000) -> Toman (/10) — see RIALS_PER_TOMAN
  assert.equal(ticker.percentage, 9.38); // a ratio, not a currency amount — never scaled
  assert.equal(ticker.baseVolume, 0.292948); // base-asset units, not Rial/Toman — never scaled
  assert.equal(ticker.timestamp, undefined); // /market/stats has no timestamp field — not fabricated
});

test('fetchTicker falls back to the "mark" reference price when a closed/illiquid market reports latest:"0"', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, [
    ['/market/stats?', async () => jsonResponse({
      status: 'ok',
      stats: { '1m_btt-rls': { isClosed: true, latest: '0', mark: '498570', dayChange: '0', volumeSrc: '0' } },
    })],
  ]);
  await client.loadMarkets();

  const ticker = await client.fetchTicker('1M_BTT/IRT');
  assert.equal(ticker.last, 49857); // not 0, and Rial (498570) -> Toman (/10) — mark is a real Nobitex-provided reference price, not fabricated
});

test('fetchTicker reports last:null (not a fabricated 0) when both latest and mark are unavailable', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, [
    ['/market/stats?', async () => jsonResponse({ status: 'ok', stats: { 'btc-usdt': { latest: '0', mark: '0' } } })],
  ]);
  await client.loadMarkets();

  const ticker = await client.fetchTicker('BTC/USDT');
  assert.equal(ticker.last, null);
});

test('fetchOHLCV converts the columnar {t,o,h,l,c,v} response to row [ts_ms,o,h,l,c,v] tuples', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, [
    ['/market/udf/history', async () => jsonResponse({
      s: 'ok',
      t: [1562095800, 1562182200],
      o: [146272500, 150551000],
      h: [155869600, 161869500],
      l: [140062400, 150551000],
      c: [151440200, 157000000],
      v: [18.221362316, 9.8592626506],
    })],
  ]);
  await client.loadMarkets();

  const rows = await client.fetchOHLCV('BTC/IRT', '1d', undefined, 200);
  assert.equal(rows.length, 2);
  // seconds -> ms, and Rial OHLC prices -> Toman (/10) — volume (last element) is base-asset units, never scaled
  assert.deepEqual(rows[0], [1562095800000, 14627250, 15586960, 14006240, 15144020, 18.221362316]);
});

test('fetchOHLCV does not scale prices for a non-IRT (already-USDT) market', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, [
    ['/market/udf/history', async () => jsonResponse({ s: 'ok', t: [1562095800], o: [65000], h: [65500], l: [64500], c: [65200], v: [1.5] })],
  ]);
  await client.loadMarkets();

  const rows = await client.fetchOHLCV('BTC/USDT', '1d', undefined, 200);
  assert.deepEqual(rows[0], [1562095800000, 65000, 65500, 64500, 65200, 1.5]);
});

test('fetchOHLCV returns [] (not an error) when Nobitex reports no_data', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, [['/market/udf/history', async () => jsonResponse({ s: 'no_data' })]]);
  await client.loadMarkets();
  const rows = await client.fetchOHLCV('BTC/IRT', '1h', undefined, 200);
  assert.deepEqual(rows, []);
});

test('fetchOHLCV rejects "1w" before ever making a network call', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, []);
  await client.loadMarkets();
  await assert.rejects(() => client.fetchOHLCV('BTC/USDT', '1w', undefined, 200), /does not publish/);
});

test('fetchBalance requires a token and aliases the RLS wallet to IRT as Toman, not raw Rial (app-facing quote naming)', async (t) => {
  const client = new NobitexExchange();
  await assert.rejects(() => client.fetchBalance(), /requires a Token/);

  const authedClient = new NobitexExchange({ apiKey: 'test-token-123' });
  let authHeader;
  mockFetchDispatcher(t, [
    ['/v2/wallets', async (url, opts) => {
      authHeader = opts.headers.Authorization;
      return jsonResponse({
        status: 'ok',
        wallets: { RLS: { id: 1, balance: '1000000', blocked: '200000' }, BTC: { id: 2, balance: '0.5', blocked: '0' } },
      });
    }],
  ]);

  const balance = await authedClient.fetchBalance();
  assert.equal(authHeader, 'Token test-token-123');
  assert.equal(balance.free.RLS, 800000); // raw Rial value, left as-is under its own currency code
  assert.equal(balance.free.IRT, 80000); // aliased AND converted: Rial (800000) -> Toman (/10)
  assert.equal(balance.free.BTC, 0.5);
});

test('createOrder sends execution=market with a price band, confirms fill via a status check, and returns a normalized order', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });

  const calls = [];
  mockFetchDispatcher(t, [
    ['/market/orders/add', async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, body });
      return jsonResponse({ status: 'ok', order: { id: 555 } });
    }],
    ['/market/orders/status', async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return jsonResponse({ status: 'ok', order: { id: 555, status: 'Done', amount: '0.01' } });
    }],
  ]);
  await client.loadMarkets();

  const order = await client.createOrder('BTC/USDT', 'market', 'buy', 0.01, 50000);
  const addCall = calls.find((c) => c.url.includes('/market/orders/add'));
  assert.equal(addCall.body.type, 'buy'); // ccxt "side" -> Nobitex "type"
  assert.equal(addCall.body.execution, 'market');
  assert.equal(addCall.body.srcCurrency, 'btc');
  assert.equal(addCall.body.dstCurrency, 'usdt');
  assert.equal(addCall.body.price, '50000'); // explicit price passed through as the protective band
  assert.equal(order.id, '555');
  assert.equal(order.amount, 0.01);
});

test('createOrder converts an IRT (Toman) price back to Rial before sending it to Nobitex', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });

  const calls = [];
  mockFetchDispatcher(t, [
    ['/market/orders/add', async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, body });
      return jsonResponse({ status: 'ok', order: { id: 558 } });
    }],
    ['/market/orders/status', async () => jsonResponse({ status: 'ok', order: { id: 558, status: 'Done', amount: '0.01' } })],
  ]);
  await client.loadMarkets();

  // Caller supplies 75035000 Toman (the app's own unit, e.g. from a fetchTicker() call) —
  // Nobitex's own order API expects Rial for an rls-quoted market, so this should go out as 10x.
  await client.createOrder('BTC/IRT', 'market', 'buy', 0.01, 75035000);
  const addCall = calls.find((c) => c.url.includes('/market/orders/add'));
  assert.equal(addCall.body.dstCurrency, 'rls');
  assert.equal(addCall.body.price, '750350000');
});

test('createOrder fetches the current price as a protective band when none is supplied', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });

  const calls = [];
  mockFetchDispatcher(t, [
    ['/market/stats?', async () => jsonResponse({ status: 'ok', stats: { 'btc-usdt': { latest: '61000', mark: '61000' } } })],
    ['/market/orders/add', async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, body });
      return jsonResponse({ status: 'ok', order: { id: 556 } });
    }],
    ['/market/orders/status', async () => jsonResponse({ status: 'ok', order: { id: 556, status: 'Done', amount: '0.01' } })],
  ]);
  await client.loadMarkets();

  await client.createOrder('BTC/USDT', 'market', 'buy', 0.01);
  const addCall = calls.find((c) => c.url.includes('/market/orders/add'));
  assert.equal(addCall.body.price, '61000');
});

test('createOrder throws rather than reporting a partial fill as complete', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });
  mockFetchDispatcher(t, [
    ['/market/orders/add', async () => jsonResponse({ status: 'ok', order: { id: 557 } })],
    ['/market/orders/status', async () => jsonResponse({ status: 'ok', order: { id: 557, status: 'Active', unmatchedAmount: '0.005' } })],
  ]);
  await client.loadMarkets();

  await assert.rejects(() => client.createOrder('BTC/USDT', 'market', 'buy', 0.01, 50000), /did not fully fill/);
});

test('createOrder and fetchBalance both throw a clear error without a token, before any network call', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, []);
  await client.loadMarkets();
  await assert.rejects(() => client.createOrder('BTC/USDT', 'market', 'buy', 0.01, 50000), /requires a Token/);
});

test('a logical Nobitex failure ({status:"failed"}) is surfaced as a real thrown error, not silently swallowed', async (t) => {
  const client = new NobitexExchange();
  mockFetchDispatcher(t, [
    ['/market/stats?', async () => jsonResponse({ status: 'failed', code: 'InvalidMarketPair', message: 'bad pair' })],
  ]);
  await client.loadMarkets();
  await assert.rejects(() => client.fetchTicker('BTC/USDT'), /InvalidMarketPair/);
});

test('createOrder(type="limit") sends execution=limit with the given price, converted to Rial for an IRT market, and returns status "open" without a confirmation status check', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });
  const calls = [];
  mockFetchDispatcher(t, [
    ['/market/orders/add', async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return jsonResponse({ status: 'ok', order: { id: 900, status: 'Active' } });
    }],
    ['/market/orders/status', async () => { throw new Error('should not be called for a limit order'); }],
  ]);
  await client.loadMarkets();

  const order = await client.createOrder('BTC/IRT', 'limit', 'buy', 0.01, 74000000); // 74,000,000 Toman
  const addCall = calls.find((c) => c.url.includes('/market/orders/add'));
  assert.equal(addCall.body.execution, 'limit');
  assert.equal(addCall.body.price, '740000000'); // Toman -> Rial (x10)
  assert.equal(order.id, '900');
  assert.equal(order.status, 'open');
});

test('createOrder(type="limit") requires an explicit price — no live-ticker fallback', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });
  mockFetchDispatcher(t, []);
  await client.loadMarkets();
  await assert.rejects(() => client.createOrder('BTC/USDT', 'limit', 'buy', 0.01), /requires an explicit price/);
});

test('createOrder rejects any type other than market/limit (stop orders are documented on Nobitex but deliberately unimplemented here)', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });
  mockFetchDispatcher(t, []);
  await client.loadMarkets();
  await assert.rejects(() => client.createOrder('BTC/USDT', 'stop_market', 'buy', 0.01, 50000), /only implements market and limit/);
});

test('fetchOrder maps Nobitex\'s status vocabulary to ccxt-style open/closed/canceled and converts price for an IRT market', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });
  mockFetchDispatcher(t, [
    ['/market/orders/status', async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.id, 900);
      return jsonResponse({ status: 'ok', order: { id: 900, status: 'Active', amount: '0.01', price: '740000000' } });
    }],
  ]);
  await client.loadMarkets();

  const result = await client.fetchOrder('900', 'BTC/IRT');
  assert.equal(result.status, 'open');
  assert.equal(result.price, 74000000); // Rial -> Toman
  assert.equal(result.amount, 0.01);
});

test('fetchOrder maps Done -> closed and Canceled -> canceled', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });
  mockFetchDispatcher(t, [
    ['/market/orders/status', async () => jsonResponse({ status: 'ok', order: { id: 901, status: 'Done', amount: '0.01', price: '65000' } })],
  ]);
  await client.loadMarkets();
  const done = await client.fetchOrder('901', 'BTC/USDT');
  assert.equal(done.status, 'closed');

  mockFetchDispatcher(t, [
    ['/market/orders/status', async () => jsonResponse({ status: 'ok', order: { id: 902, status: 'Canceled', amount: '0.01', price: '65000' } })],
  ]);
  const canceled = await client.fetchOrder('902', 'BTC/USDT');
  assert.equal(canceled.status, 'canceled');
});

test('cancelOrder calls /market/orders/update-status with status:"canceled" and the order id', async (t) => {
  const client = new NobitexExchange({ apiKey: 'test-token-123' });
  const calls = [];
  mockFetchDispatcher(t, [
    ['/market/orders/update-status', async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return jsonResponse({ status: 'ok', updatedStatus: 'Canceled', order: { id: 900, status: 'Canceled', amount: '0.01', price: '65000' } });
    }],
  ]);
  await client.loadMarkets();

  const result = await client.cancelOrder('900', 'BTC/USDT');
  const call = calls.find((c) => c.url.includes('/market/orders/update-status'));
  assert.deepEqual(call.body, { order: 900, status: 'canceled' });
  assert.equal(result.status, 'canceled');
});
