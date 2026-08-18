'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const { scoringRejectionReason } = require('../../src/services/signals/strategies');

// Regression test for a real production bug (2026-08-14): the manual "Generate Signal" button
// (and the legacy single-timeframe "Run Backtest"/"Optimize") never guarded against the
// Liquidity Sweep Reversal strategy id — since it's deliberately excluded from strategies.js's
// STRATEGIES map (it's a stateful multi-timeframe sequence, not a per-candle weighted score),
// passing it to getStrategy() silently fell back to "balanced" and produced a signal/backtest
// result completely unrelated to the strategy actually configured on the asset (a user saw a
// spurious SELL signal for an LSR-tagged asset that the real LSR engine never generated and that
// could never have resulted in a trade). See strategies.js#scoringRejectionReason.

async function json(res) {
  return res.json();
}

test('scoringRejectionReason: null for every real weighted strategy, a message for the LSR id', () => {
  assert.equal(scoringRejectionReason('balanced'), null);
  assert.equal(scoringRejectionReason('trend-following'), null);
  assert.equal(scoringRejectionReason(undefined), null);
  const reason = scoringRejectionReason('liquidity-sweep-reversal');
  assert.ok(reason);
  assert.match(reason, /Liquidity Sweep Reversal/);
});

test('POST /api/signals/analyze rejects the LSR strategy id instead of silently scoring as "balanced"', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const res = await authedFetch('/api/signals/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto', strategyId: 'liquidity-sweep-reversal' }),
  });
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.match(body.message, /Liquidity Sweep Reversal/);
});

test('POST /api/backtest rejects the LSR strategy id instead of silently backtesting "balanced"', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const res = await authedFetch('/api/backtest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT', exchange: 'kucoin', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z',
      strategyId: 'liquidity-sweep-reversal',
    }),
  });
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.match(body.message, /Liquidity Sweep Reversal/);
});

test('POST /api/backtest/optimize rejects a strategyIds array containing the LSR id', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  const res = await authedFetch('/api/backtest/optimize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT', exchange: 'kucoin', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z',
      strategyIds: ['balanced', 'liquidity-sweep-reversal'],
    }),
  });
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.match(body.message, /Liquidity Sweep Reversal/);
});
