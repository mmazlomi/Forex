'use strict';

process.env.DATABASE_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const usersRepository = require('../../src/database/repositories/users-repository');
const positionsRepository = require('../../src/database/repositories/positions-repository');
const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
const portfolioService = require('../../src/services/portfolio/portfolio-service');
const futuresPortfolioService = require('../../src/services/portfolio/futures-portfolio-service');
const portfolioRepository = require('../../src/database/repositories/portfolio-repository');
const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');

let userId;

test.beforeEach(() => {
  resetForTests();
  userId = usersRepository.createUser('partial-exit-user', 'irrelevant-hash').id;
});

test('insertPosition backfills initial_qty from qty when not explicitly given', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });
  assert.equal(p.initial_qty, 10);
  assert.equal(p.adaptive_tp_enabled, 0);
  assert.equal(p.realized_pnl_partial_sum, 0);
});

test('recordPartialExit decrements remaining qty, accumulates realized_pnl_partial_sum, and stamps the fired tier', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });

  const afterTp1 = positionsRepository.recordPartialExit('demo', userId, p.id, {
    level: 1, qty: 2.5, price: 110, pnl: 25, feePercent: 0.1, closedAtUtc: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(afterTp1.qty, 7.5);
  assert.equal(afterTp1.realized_pnl_partial_sum, 25);
  assert.equal(afterTp1.tp1_filled_at_utc, '2026-01-01T00:00:00.000Z');
  assert.equal(afterTp1.tp1_fill_price, 110);
  assert.equal(afterTp1.initial_qty, 10, 'initial_qty is never touched by a partial fire');
  const legs1 = JSON.parse(afterTp1.partial_exits_json);
  assert.equal(legs1.length, 1);
  assert.deepEqual(legs1[0], { level: 1, qty: 2.5, price: 110, feePercent: 0.1, pnl: 25, closedAtUtc: '2026-01-01T00:00:00.000Z' });

  const afterTp2 = positionsRepository.recordPartialExit('demo', userId, p.id, {
    level: 2, qty: 3.5, price: 115, pnl: 52.5, closedAtUtc: '2026-01-01T01:00:00.000Z',
  });
  assert.equal(afterTp2.qty, 4);
  assert.equal(afterTp2.realized_pnl_partial_sum, 77.5);
  assert.equal(JSON.parse(afterTp2.partial_exits_json).length, 2);
});

test('a 3-leg partial-exit-then-final-close accumulates to the correct total realized P&L and correct balance delta', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });
  const startingBalance = portfolioRepository.ensureInitialized('demo', userId, 0).balance;

  positionsRepository.recordPartialExit('demo', userId, p.id, { level: 1, qty: 2.5, price: 110, pnl: 25 }); // TP1: 25
  positionsRepository.recordPartialExit('demo', userId, p.id, { level: 2, qty: 3.5, price: 120, pnl: 70 }); // TP2: 70
  // Simulate the order service crediting balance for each partial leg as it fires (Stage D's job) —
  // portfolio-service.closePosition only credits the FINAL leg, so the test replicates that contract here.
  portfolioRepository.setBalance('demo', userId, startingBalance + 25 + 70);

  // Remaining 4 qty closes via trailing/manual at 130 -> final leg pnl = (130-100)*4 = 120
  const closed = portfolioService.closePosition('demo', userId, p.id, 130, 'take_profit');

  assert.equal(closed.realizedPnl, 25 + 70 + 120, 'realized_pnl on the row is the sum of every leg');
  assert.equal(closed.realized_pnl, 215);
  assert.equal(closed.qty, 4, 'qty column reflects the remaining (now fully closed) quantity, not original');

  const finalBalance = portfolioRepository.ensureInitialized('demo', userId, 0).balance;
  assert.equal(finalBalance, startingBalance + 25 + 70 + 120, 'balance was only credited once per leg, no double-count on final close');
});

test('closePosition with zero partial exits is byte-identical to pre-adaptive behavior (realized_pnl_partial_sum stays 0)', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 5, entryPrice: 100 });
  const closed = portfolioService.closePosition('demo', userId, p.id, 120);
  assert.equal(closed.realizedPnl, 100); // (120-100)*5
  assert.equal(closed.realized_pnl, 100);
});

test('recordPartialExit throws when the same tier is fired twice (defense in depth against duplicate partial-close orders)', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });
  positionsRepository.recordPartialExit('demo', userId, p.id, { level: 1, qty: 2.5, price: 110, pnl: 25 });
  assert.throws(() => {
    positionsRepository.recordPartialExit('demo', userId, p.id, { level: 1, qty: 1, price: 111, pnl: 2.75 });
  }, /already filled/);
});

test('recordPartialExit rejects an invalid level', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });
  assert.throws(() => {
    positionsRepository.recordPartialExit('demo', userId, p.id, { level: 4, qty: 1, price: 110, pnl: 10 });
  }, /Invalid TP level/);
});

test('recordPartialExit is ownership-scoped: a mismatched userId is a no-op returning null', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });
  const otherUserId = usersRepository.createUser('other-user', 'irrelevant-hash').id;
  const result = positionsRepository.recordPartialExit('demo', otherUserId, p.id, { level: 1, qty: 1, price: 110, pnl: 10 });
  assert.equal(result, null);
});

test('short position partial-exit-then-final-close accumulates correctly (direction-aware)', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell', qty: 10, entryPrice: 100 });
  // A short profits on a fall: TP1 at 90 closing 2 qty -> pnl = (100-90)*2 = 20
  positionsRepository.recordPartialExit('demo', userId, p.id, { level: 1, qty: 2, price: 90, pnl: 20 });
  const closed = portfolioService.closePosition('demo', userId, p.id, 80); // remaining 8 qty at 80 -> (100-80)*8=160
  assert.equal(closed.realized_pnl, 20 + 160);
});

// --- Futures twin ---

test('futures: recordPartialExit + closePosition accumulate the same way as spot, leverage-independent P&L math unaffected', () => {
  const p = futuresPortfolioService.openPosition('demo', userId, {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', side: 'long', leverage: 3, qty: 10, entryPrice: 100,
  });
  const startingBalance = futuresPortfolioRepository.ensureInitialized('demo', userId, 0).balance;

  futuresPositionsRepository.recordPartialExit('demo', userId, p.id, { level: 1, qty: 4, price: 110, pnl: 40 });
  futuresPortfolioRepository.setBalance('demo', userId, startingBalance + 40);

  const closed = futuresPortfolioService.closePosition('demo', userId, p.id, 115); // remaining 6 * (115-100) = 90
  assert.equal(closed.realized_pnl, 40 + 90);
  assert.equal(closed.qty, 6);

  const finalBalance = futuresPortfolioRepository.ensureInitialized('demo', userId, 0).balance;
  assert.equal(finalBalance, startingBalance + 40 + 90);
});

test('futures short: closePosition with zero partial exits is byte-identical to pre-adaptive behavior', () => {
  const p = futuresPortfolioService.openPosition('demo', userId, {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', side: 'short', leverage: 2, qty: 5, entryPrice: 100,
  });
  const closed = futuresPortfolioService.closePosition('demo', userId, p.id, 90); // short profits on fall
  assert.equal(closed.realizedPnl, 50); // (100-90)*5
  assert.equal(closed.realized_pnl, 50);
});

test('futures: recordPartialExit throws on duplicate tier fire', () => {
  const p = futuresPortfolioService.openPosition('demo', userId, {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', side: 'long', leverage: 1, qty: 10, entryPrice: 100,
  });
  futuresPositionsRepository.recordPartialExit('demo', userId, p.id, { level: 2, qty: 3, price: 110, pnl: 30 });
  assert.throws(() => {
    futuresPositionsRepository.recordPartialExit('demo', userId, p.id, { level: 2, qty: 1, price: 111, pnl: 11 });
  }, /already filled/);
});

test('partialClosePosition (spot) credits balance for just the leg and matches recordPartialExit bookkeeping', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });
  const startingBalance = portfolioRepository.ensureInitialized('demo', userId, 0).balance;

  const afterTp1 = portfolioService.partialClosePosition('demo', userId, p.id, { level: 1, qty: 2.5, exitPrice: 110 });
  assert.equal(afterTp1.pnl, 25); // (110-100)*2.5
  assert.equal(afterTp1.qty, 7.5);
  assert.equal(afterTp1.realized_pnl_partial_sum, 25);

  const balanceAfterTp1 = portfolioRepository.ensureInitialized('demo', userId, 0).balance;
  assert.equal(balanceAfterTp1, startingBalance + 25);

  const closed = portfolioService.closePosition('demo', userId, p.id, 120); // remaining 7.5 * (120-100) = 150
  assert.equal(closed.realized_pnl, 25 + 150);
  const finalBalance = portfolioRepository.ensureInitialized('demo', userId, 0).balance;
  assert.equal(finalBalance, startingBalance + 25 + 150);
});

test('partialClosePosition throws when the position is not open', () => {
  const p = portfolioService.openPosition('demo', userId, { symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100 });
  portfolioService.closePosition('demo', userId, p.id, 100);
  assert.throws(() => {
    portfolioService.partialClosePosition('demo', userId, p.id, { level: 1, qty: 1, exitPrice: 110 });
  }, /No open position/);
});

test('futures partialClosePosition (short) is direction-aware', () => {
  const p = futuresPortfolioService.openPosition('demo', userId, {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', side: 'short', leverage: 2, qty: 10, entryPrice: 100,
  });
  const result = futuresPortfolioService.partialClosePosition('demo', userId, p.id, { level: 1, qty: 3, exitPrice: 90 });
  assert.equal(result.pnl, 30); // short profits on fall: (100-90)*3
  assert.equal(result.qty, 7);
});

test('openPosition with adaptiveTp writes every adaptive column and flips adaptive_tp_enabled on (spot)', () => {
  const p = portfolioService.openPosition('demo', userId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100,
    adaptiveTp: {
      entryAtr: 2.5, rMultiple: 1.8, entryContextJson: '{"adx":30}',
      tp1Price: 105, tp2Price: 110, tp3Price: 120,
      tp1QtyPercent: 25, tp2QtyPercent: 35, tp3QtyPercent: 40,
      recommendedTrailingMultiplier: 1.5, exitReversalConditionsJson: '{"chochBreak":true}',
    },
  });
  assert.equal(p.adaptive_tp_enabled, 1);
  assert.equal(p.entry_atr, 2.5);
  assert.equal(p.r_multiple, 1.8);
  assert.equal(p.tp1_price, 105);
  assert.equal(p.tp2_price, 110);
  assert.equal(p.tp3_price, 120);
  assert.equal(p.tp1_qty_percent, 25);
  assert.equal(p.tp2_qty_percent, 35);
  assert.equal(p.tp3_qty_percent, 40);
  assert.equal(p.recommended_trailing_multiplier, 1.5);
  assert.equal(p.exit_reversal_conditions_json, '{"chochBreak":true}');
  assert.equal(p.entry_context_json, '{"adx":30}');
});
