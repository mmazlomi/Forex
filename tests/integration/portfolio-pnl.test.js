'use strict';

process.env.DATABASE_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const portfolioService = require('../../src/services/portfolio/portfolio-service');
const marketDataService = require('../../src/services/market-data/market-data-service');
const usersRepository = require('../../src/database/repositories/users-repository');

let userId;

test.beforeEach(() => {
  resetForTests();
  userId = usersRepository.createUser('pnl-test-user', 'irrelevant-hash').id;
});

test('getPnlSummary is all-zero for a fresh portfolio with no trade history', () => {
  const pnl = portfolioService.getPnlSummary('demo', userId);
  assert.deepEqual(pnl, { totalRealizedPnl: 0, winCount: 0, lossCount: 0, winRatePercent: 0 });
});

test('getPnlSummary aggregates realized P&L and win rate across multiple closed positions', () => {
  const p1 = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 1, entryPrice: 100 });
  portfolioService.closePosition('demo', userId, p1.id, 110); // +10, a win

  const p2 = portfolioService.openPosition('demo', userId, { symbol: 'ETH/USDT', exchange: 'kucoin', side: 'buy', qty: 1, entryPrice: 100 });
  portfolioService.closePosition('demo', userId, p2.id, 90); // -10, a loss

  const p3 = portfolioService.openPosition('demo', userId, { symbol: 'SOL/USDT', exchange: 'kucoin', side: 'buy', qty: 2, entryPrice: 50 });
  portfolioService.closePosition('demo', userId, p3.id, 55); // +10, a win

  const pnl = portfolioService.getPnlSummary('demo', userId);
  assert.equal(pnl.totalRealizedPnl, 10);
  assert.equal(pnl.winCount, 2);
  assert.equal(pnl.lossCount, 1);
  assert.ok(Math.abs(pnl.winRatePercent - (2 / 3) * 100) < 1e-9);
});

test('demo and real P&L are tracked independently', () => {
  const p1 = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 1, entryPrice: 100 });
  portfolioService.closePosition('demo', userId, p1.id, 150);

  const realPnl = portfolioService.getPnlSummary('real', userId);
  assert.equal(realPnl.totalRealizedPnl, 0);
  assert.equal(realPnl.winCount, 0);

  const demoPnl = portfolioService.getPnlSummary('demo', userId);
  assert.equal(demoPnl.totalRealizedPnl, 50);
});

test('getOpenPositionsWithUnrealizedPnl computes unrealized P&L from a live price lookup', async (t) => {
  t.mock.method(marketDataService, 'getSnapshot', async () => ({ status: 'ok', price: 120 }));

  portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 2, entryPrice: 100 });
  const positions = await portfolioService.getOpenPositionsWithUnrealizedPnl('demo', userId);

  assert.equal(positions.length, 1);
  assert.equal(positions[0].currentPrice, 120);
  assert.equal(positions[0].unrealizedPnl, 40); // (120 - 100) * 2
});

test('getOpenPositionsWithUnrealizedPnl fails gracefully (null, not a throw) when the price lookup fails', async (t) => {
  t.mock.method(marketDataService, 'getSnapshot', async () => { throw new Error('network down'); });

  portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 1, entryPrice: 100 });
  const positions = await portfolioService.getOpenPositionsWithUnrealizedPnl('demo', userId);

  assert.equal(positions.length, 1);
  assert.equal(positions[0].currentPrice, null);
  assert.equal(positions[0].unrealizedPnl, null);
});

test('getOpenPositionsWithUnrealizedPnl returns null P&L for a position with no stored exchange (pre-migration data)', async () => {
  const { getDb } = require('../../src/database/connection');
  const db = getDb();
  db.prepare(
    `INSERT INTO demo_positions (user_id, symbol, exchange, side, qty, entry_price, opened_at_utc, status)
     VALUES (?, 'BTC/USDT', NULL, 'buy', 1, 100, ?, 'open')`
  ).run(userId, new Date().toISOString());

  const positions = await portfolioService.getOpenPositionsWithUnrealizedPnl('demo', userId);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].currentPrice, null);
  assert.equal(positions[0].unrealizedPnl, null);
});
