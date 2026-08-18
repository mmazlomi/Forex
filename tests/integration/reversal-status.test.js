'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const liveEngine = require('../../src/services/reversal-strategy/live-engine');

// GET /api/reversal/status is the read-only HTTP surface over live-engine.js#getLiveStatus, used
// by the Signals Setting Results table to show an LSR-tagged asset's live progress through
// Sweep -> Divergence -> CHOCH -> Retest -> Entry instead of a static "trades elsewhere" notice.
// The underlying state-machine logic is covered in tests/unit/reversal-strategy/live-engine.test.js
// — this only covers the controller's validation and response shaping, so getLiveStatus itself is
// mocked here rather than driven for real.

test('GET /api/reversal/status requires symbol, exchange, market, and mode', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const missingSymbol = await authedFetch('/api/reversal/status?exchange=kucoin&market=futures&mode=demo');
  assert.equal(missingSymbol.status, 400);

  const badMarket = await authedFetch('/api/reversal/status?symbol=BTC%2FUSDT%3AUSDT&exchange=kucoin&market=stonks&mode=demo');
  assert.equal(badMarket.status, 400);

  const badMode = await authedFetch('/api/reversal/status?symbol=BTC%2FUSDT%3AUSDT&exchange=kucoin&market=futures&mode=paper');
  assert.equal(badMode.status, 400);
});

test('GET /api/reversal/status returns a null state with an explanatory label when no cycle has run yet', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  t.mock.method(liveEngine, 'getLiveStatus', () => null);

  const res = await authedFetch('/api/reversal/status?symbol=BTC%2FUSDT%3AUSDT&exchange=kucoin&market=futures&mode=demo');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.state, null);
  assert.match(body.data.label, /No cycle has run yet/);
});

test('GET /api/reversal/status returns the curated status with a human-readable label', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);
  const asOfTsUtc = '2026-08-18T07:00:00.000Z';
  t.mock.method(liveEngine, 'getLiveStatus', () => ({ state: 'WAITING_FOR_CHOCH', direction: 'bullish', chochLevel: 61234.5, sweptLevel: 60000, asOfTsUtc }));

  const res = await authedFetch('/api/reversal/status?symbol=BTC%2FUSDT%3AUSDT&exchange=kucoin&market=futures&mode=demo');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.state, 'WAITING_FOR_CHOCH');
  assert.equal(body.data.direction, 'bullish');
  assert.equal(body.data.chochLevel, 61234.5);
  assert.equal(body.data.asOfTsUtc, asOfTsUtc);
  assert.match(body.data.label, /CHOCH/);
});
