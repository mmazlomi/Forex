'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startAuthedTestServer } = require('../fixtures/test-server');
const assetsRepository = require('../../src/database/repositories/assets-repository');
const futuresAssetsRepository = require('../../src/database/repositories/futures-assets-repository');
const optimizer = require('../../src/services/backtesting/optimizer');

test('GET /api/backtest/autopilot/matrix returns configuration, scheduler status, and asset list', async (t) => {
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
  assetsRepository.setSelectedStrategies(userId, 'BTC/USDT', 'kucoin', ['trend-following', 'momentum']);

  futuresAssetsRepository.addAsset('demo', userId, {
    symbol: 'ETH/USDT:USDT',
    exchange: 'kucoin',
    leverage: 3,
  });

  const res = await authedFetch('/api/backtest/autopilot/matrix');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.data.config);
  assert.equal(typeof body.data.config.lookbackDays, 'number');
  assert.ok(body.data.scheduler);
  assert.ok(Array.isArray(body.data.assets));

  const btcSpot = body.data.assets.find((a) => a.symbol === 'BTC/USDT' && a.market === 'spot');
  assert.ok(btcSpot);
  assert.equal(btcSpot.evaluated, true);
  assert.deepEqual(btcSpot.selectedStrategies, ['trend-following', 'momentum']);

  const ethDemo = body.data.assets.find((a) => a.symbol === 'ETH/USDT:USDT' && a.market === 'futures-demo');
  assert.ok(ethDemo);
  assert.equal(ethDemo.evaluated, false);
});

test('POST /api/backtest/autopilot/evaluate-asset returns detailed win-rate breakdown for candidate strategies', async (t) => {
  const { close, authedFetch } = await startAuthedTestServer();
  t.after(close);

  t.mock.method(optimizer, 'optimizeStrategy', async () => ({
    combinationsRun: 15,
    leaderboard: [
      { strategyId: 'trend-following', strategyName: 'Trend Following', buyThreshold: 0.3, sellThreshold: -0.3, metrics: { winRatePercent: 75.0, tradeCount: 12, totalPnlPercent: 8.5, maxDrawdownPercent: 3.2 } },
      { strategyId: 'momentum', strategyName: 'Momentum', buyThreshold: 0.2, sellThreshold: -0.2, metrics: { winRatePercent: 62.5, tradeCount: 8, totalPnlPercent: 5.1, maxDrawdownPercent: 4.1 } },
      { strategyId: 'balanced', strategyName: 'Balanced', buyThreshold: 0.4, sellThreshold: -0.4, metrics: { winRatePercent: 45.0, tradeCount: 6, totalPnlPercent: -1.2, maxDrawdownPercent: 5.5 } },
    ],
  }));

  const res = await authedFetch('/api/backtest/autopilot/evaluate-asset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: 'BTC/USDT',
      exchange: 'kucoin',
      timeframe: '4h',
      market: 'spot',
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.symbol, 'BTC/USDT');
  assert.equal(body.data.timeframe, '4h');
  assert.ok(Array.isArray(body.data.strategies));
  assert.equal(body.data.strategies.length, 3);
  assert.deepEqual(body.data.selected, ['trend-following', 'momentum', 'balanced']);
});
