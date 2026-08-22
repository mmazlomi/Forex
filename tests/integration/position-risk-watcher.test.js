'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.ENABLE_LIVE_TRADING = 'true';
process.env.REAL_EXCHANGE_NAME = 'kucoin';
process.env.REAL_API_KEY = 'test-key';
process.env.REAL_API_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const usersRepository = require('../../src/database/repositories/users-repository');
const positionsRepository = require('../../src/database/repositories/positions-repository');
const ordersRepository = require('../../src/database/repositories/orders-repository');
const portfolioRepository = require('../../src/database/repositories/portfolio-repository');
const futuresPositionsRepository = require('../../src/database/repositories/futures-positions-repository');
const futuresOrdersRepository = require('../../src/database/repositories/futures-orders-repository');
const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
const realExchangeCredentialsRepository = require('../../src/database/repositories/real-exchange-credentials-repository');
const marketDataService = require('../../src/services/market-data/market-data-service');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const { placeDemoOrder } = require('../../src/services/orders/demo-orders');
const { placeRealOrder } = require('../../src/services/orders/real-orders');
const { placeDemoFuturesOrder } = require('../../src/services/orders/futures-demo-orders');
const { placeRealFuturesOrder } = require('../../src/services/orders/futures-real-orders');
const positionRiskWatcher = require('../../src/services/scheduler/position-risk-watcher');

function mockSpotPrice(t, price) {
  t.mock.method(marketDataService, 'getSnapshot', async () => ({
    symbol: 'BTC/USDT', exchange: 'kucoin', status: 'ok', price, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

function mockFuturesPrice(t, price) {
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => ({
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price, dataFreshnessMs: 500, asOfUtc: new Date().toISOString(),
  }));
}

function fakeRealSpotClient() {
  return {
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-spot-1', status: 'closed' }),
  };
}

function fakeRealFuturesClient() {
  return {
    fetchBalance: async () => ({ free: { USDT: 10000 } }),
    createOrder: async () => ({ id: 'ex-fut-1', status: 'closed' }),
    fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', liquidationPrice: 30000 }],
  };
}

let testUserId;
test.beforeEach(() => {
  resetForTests();
  testUserId = usersRepository.createUser('risk-watcher-test-user', 'irrelevant-hash').id;
  portfolioRepository.ensureInitialized('demo', testUserId, 10000);
  portfolioRepository.ensureInitialized('real', testUserId, 10000);
  futuresPortfolioRepository.ensureInitialized('demo', testUserId, 10000);
  futuresPortfolioRepository.ensureInitialized('real', testUserId, 10000);
});

test('spot demo: a position is closed once price falls to its stored stop-loss', async (t) => {
  mockSpotPrice(t, 100);
  const buy = await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130 });
  assert.equal(buy.status, 'filled');
  assert.ok(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'));

  mockSpotPrice(t, 85); // through the stop-loss
  await positionRiskWatcher.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), undefined);
  const orders = ordersRepository.listOrders('demo', testUserId, {});
  assert.equal(orders.length, 2);
  assert.equal(orders[0].side, 'sell'); // most recent first
  assert.equal(orders[0].price, 85);
});

test('spot demo: a position is closed once price rises to its stored take-profit', async (t) => {
  mockSpotPrice(t, 100);
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130 });

  mockSpotPrice(t, 135); // through the take-profit
  await positionRiskWatcher.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), undefined);
});

test('spot demo: a position between its stop-loss and take-profit is left open', async (t) => {
  mockSpotPrice(t, 100);
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130 });

  mockSpotPrice(t, 110);
  await positionRiskWatcher.runCycle();

  assert.ok(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'));
});

test('spot demo: a position already protected by a pending OCO exit is left alone by the watcher (no duplicate/competing close)', async (t) => {
  mockSpotPrice(t, 100);
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130 });
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'sell', orderType: 'oco', stopLoss: 90, takeProfit: 130 });
  assert.equal(ordersRepository.listPendingOrders('demo').length, 2);

  mockSpotPrice(t, 135); // through the take-profit, but the OCO leg is the one that should get it, not this watcher
  await positionRiskWatcher.runCycle();

  assert.ok(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), 'still open — the watcher deferred to the existing pending OCO exit');
  assert.equal(ordersRepository.listOrders('demo', testUserId, {}).filter((o) => o.side === 'sell' && o.status === 'filled').length, 0);
});

test('spot real: a position is closed on the real exchange once price crosses its stop-loss', async (t) => {
  realExchangeCredentialsRepository.set(testUserId, 'kucoin', 'test-key', 'test-secret');
  mockSpotPrice(t, 100);
  const client = fakeRealSpotClient();
  t.mock.method(exchangeClientFactory, 'getRealExchange', () => client);
  const buy = await placeRealOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 130, unlockConfirmed: true });
  assert.equal(buy.status, 'filled');

  const createOrderCalls = [];
  t.mock.method(client, 'createOrder', async (...args) => { createOrderCalls.push(args); return { id: 'ex-spot-close', status: 'closed' }; });

  mockSpotPrice(t, 85);
  await positionRiskWatcher.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('real', testUserId, 'BTC/USDT'), undefined);
  assert.equal(createOrderCalls.length, 1);
  assert.equal(createOrderCalls[0][2], 'sell');
});

test('futures demo (long): closes when price falls through the stop-loss', async (t) => {
  mockFuturesPrice(t, 60000);
  await placeDemoFuturesOrder({ userId: testUserId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 3, stopLoss: 50000, takeProfit: 80000 });
  assert.ok(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'));

  mockFuturesPrice(t, 49000);
  await positionRiskWatcher.runCycle();

  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'), undefined);
  const orders = futuresOrdersRepository.listOrders('demo', testUserId, {});
  assert.equal(orders[0].action, 'close');
  assert.equal(orders[0].source, 'auto');
});

test('futures demo (short): stop-loss and take-profit are inverted relative to a long, and the watcher gets the direction right', async (t) => {
  mockFuturesPrice(t, 60000);
  await placeDemoFuturesOrder({ userId: testUserId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_short', leverage: 3, stopLoss: 65000, takeProfit: 50000 });
  assert.ok(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'));

  mockFuturesPrice(t, 62000); // between take-profit (50000) and stop-loss (65000) — should stay open
  await positionRiskWatcher.runCycle();
  assert.ok(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'));

  mockFuturesPrice(t, 49000); // through the short's take-profit
  await positionRiskWatcher.runCycle();
  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'), undefined);
});

test('futures real: closes on the real exchange (reduceOnly) once price crosses its take-profit', async (t) => {
  realExchangeCredentialsRepository.set(testUserId, 'kucoin', 'test-key', 'test-secret');
  mockFuturesPrice(t, 60000);
  const client = fakeRealFuturesClient();
  t.mock.method(exchangeClientFactory, 'getRealFuturesExchange', () => client);
  const opened = await placeRealFuturesOrder({ userId: testUserId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_long', leverage: 3, stopLoss: 50000, takeProfit: 80000, unlockConfirmed: true });
  assert.equal(opened.status, 'filled');

  const createOrderCalls = [];
  t.mock.method(client, 'createOrder', async (...args) => { createOrderCalls.push(args); return { id: 'ex-fut-close', status: 'closed' }; });

  mockFuturesPrice(t, 81000);
  await positionRiskWatcher.runCycle();

  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('real', testUserId, 'BTC/USDT:USDT'), undefined);
  assert.equal(createOrderCalls.length, 1);
  assert.equal(createOrderCalls[0][2], 'sell'); // closing a long
  assert.deepEqual(createOrderCalls[0][4], undefined);
  assert.equal(createOrderCalls[0][5].reduceOnly, true);
});

test('spot demo trailing stop: ratchets up as price rises, then closes at the RATCHETED stop, not the original one', async (t) => {
  mockSpotPrice(t, 100);
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 1000, trailingPercent: 5 });
  const opened = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.equal(opened.stop_loss, 90);
  assert.equal(opened.trailing_high_water_mark, 100);

  mockSpotPrice(t, 150); // new high — should ratchet stop_loss up to 150 * 0.95 = 142.5, well above the original 90
  await positionRiskWatcher.runCycle();
  const afterRise = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.equal(afterRise.trailing_high_water_mark, 150);
  assert.equal(afterRise.stop_loss, 142.5);

  mockSpotPrice(t, 145); // below the original stop-loss (90 -> long gone) but still above the ratcheted one (142.5) — must stay open
  await positionRiskWatcher.runCycle();
  assert.ok(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), 'the ratcheted stop, not the original, is what should govern now');

  mockSpotPrice(t, 140); // through the ratcheted stop (142.5)
  await positionRiskWatcher.runCycle();
  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), undefined);
  const closeOrder = ordersRepository.listOrders('demo', testUserId, {})[0];
  assert.equal(closeOrder.side, 'sell');
  assert.equal(closeOrder.price, 140);
});

test('spot demo: a position with no trailingPercent never has its stop_loss touched by the watcher', async (t) => {
  mockSpotPrice(t, 100);
  await placeDemoOrder({ userId: testUserId, symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', stopLoss: 90, takeProfit: 1000 });

  mockSpotPrice(t, 150);
  await positionRiskWatcher.runCycle();

  const position = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.equal(position.stop_loss, 90, 'no trailing_percent set — the original stop must be untouched regardless of price');
  assert.equal(position.trailing_high_water_mark, null);
});

test('futures demo (short) trailing stop: ratchets down as price falls, closes at the ratcheted stop', async (t) => {
  mockFuturesPrice(t, 60000);
  await placeDemoFuturesOrder({
    userId: testUserId, symbol: 'BTC/USDT:USDT', exchange: 'kucoin', action: 'open_short', leverage: 3,
    stopLoss: 65000, takeProfit: 1000, trailingPercent: 2,
  });
  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT').stop_loss, 65000);

  mockFuturesPrice(t, 50000); // new low for a short — ratchets stop_loss down to 50000 * 1.02 = 51000
  await positionRiskWatcher.runCycle();
  const afterFall = futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT');
  assert.equal(afterFall.trailing_high_water_mark, 50000);
  assert.equal(afterFall.stop_loss, 51000);

  mockFuturesPrice(t, 50800); // ticked back up a bit but still below the ratcheted stop (51000) and the original (65000) — should stay open
  await positionRiskWatcher.runCycle();
  assert.ok(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'));

  mockFuturesPrice(t, 51500); // through the ratcheted stop
  await positionRiskWatcher.runCycle();
  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'), undefined);
});

test('runCycle never throws when a mode has no open positions at all', async () => {
  await assert.doesNotReject(() => positionRiskWatcher.runCycle());
});

test('getStatus reports whether the watcher is currently running', () => {
  const status = positionRiskWatcher.getStatus();
  assert.equal(typeof status.running, 'boolean');
  assert.ok(status.intervalMs >= 5000);
});

// --- Adaptive Take-Profit: multi-tier partial exits, reversal exit, post-TP1 trailing ---

const portfolioService = require('../../src/services/portfolio/portfolio-service');
const futuresPortfolioService = require('../../src/services/portfolio/futures-portfolio-service');

function fakeAtrCandles(count = 30, { start = 100, step = 0.5 } = {}) {
  const now = Date.now();
  const candles = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    price += step;
    candles.push({ tsUtc: now - (count - i) * 3600_000, open: price - 0.2, high: price + 1, low: price - 1, close: price, volume: 10 + i });
  }
  return candles;
}

test('adaptive spot: a price gap through the poll interval fires every crossed tier in one cycle and fully closes at the last one', async (t) => {
  mockSpotPrice(t, 100);
  const position = portfolioService.openPosition('demo', testUserId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100, stopLoss: 80,
    adaptiveTp: {
      tp1Price: 110, tp1QtyPercent: 25, tp2Price: 120, tp2QtyPercent: 35, tp3Price: 130, tp3QtyPercent: 40,
    },
  });

  mockSpotPrice(t, 135); // gapped straight past TP1, TP2, and TP3
  await positionRiskWatcher.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), undefined, 'fully closed after the last tier');
  const orders = ordersRepository.listOrders('demo', testUserId, {});
  const sellOrders = orders.filter((o) => o.side === 'sell' && o.status === 'filled');
  assert.equal(sellOrders.length, 3, 'one order per fired tier (TP1, TP2, final close covering TP3)');
  const totalQty = sellOrders.reduce((sum, o) => sum + o.qty, 0);
  assert.ok(Math.abs(totalQty - 10) < 1e-9, 'every unit of the original position was accounted for');

  const closed = positionsRepository.listAllClosedPositions('demo', testUserId).find((p) => p.id === position.id);
  assert.ok(closed.realized_pnl > 0);
});

test('adaptive spot: trailing never ratchets before TP1 fires, even as price moves favorably', async (t) => {
  mockSpotPrice(t, 100);
  portfolioService.openPosition('demo', testUserId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100, stopLoss: 80,
    adaptiveTp: { tp1Price: 130, tp1QtyPercent: 25, recommendedTrailingMultiplier: 2 },
  });

  mockSpotPrice(t, 120); // favorable, but still below TP1 (130)
  await positionRiskWatcher.runCycle();

  const position = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.ok(position, 'still open — TP1 never fired');
  assert.equal(position.trailing_percent, null, 'trailing must stay dormant until TP1 fires');
  assert.equal(position.stop_loss, 80, 'stop-loss untouched');
});

test('adaptive spot: trailing seeds from recommended_trailing_multiplier the moment TP1 fires, then ratchets normally afterward', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => fakeAtrCandles());
  mockSpotPrice(t, 100);
  portfolioService.openPosition('demo', testUserId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100, stopLoss: 80,
    adaptiveTp: { tp1Price: 110, tp1QtyPercent: 25, tp2Price: 200, tp2QtyPercent: 35, tp3Price: 300, tp3QtyPercent: 40, recommendedTrailingMultiplier: 2 },
  });

  mockSpotPrice(t, 111); // fires TP1 only
  await positionRiskWatcher.runCycle();

  let position = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.ok(position, 'still open — 75% remains');
  assert.ok(position.tp1_filled_at_utc);
  assert.ok(typeof position.trailing_percent === 'number' && position.trailing_percent > 0, 'trailing seeded on the same cycle TP1 fired');
  assert.equal(position.trailing_high_water_mark, 111);

  mockSpotPrice(t, 150); // rises further — should ratchet the now-active trailing stop
  await positionRiskWatcher.runCycle();
  position = positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT');
  assert.equal(position.trailing_high_water_mark, 150);
  assert.ok(position.stop_loss > 80, 'trailing stop has ratcheted up above the original stop-loss');
});

test('adaptive spot: a structure_break reversal condition closes the full remaining position with exit_reason "reversal"', async (t) => {
  t.mock.method(marketDataService, 'getCandles', async () => fakeAtrCandles());
  mockSpotPrice(t, 100);
  const position = portfolioService.openPosition('demo', testUserId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100, stopLoss: 80,
    adaptiveTp: {
      tp1Price: 150, tp1QtyPercent: 25,
      exitReversalConditionsJson: JSON.stringify([{ type: 'structure_break', description: 'Loss of key support at 95', level: 95 }]),
    },
  });

  mockSpotPrice(t, 94); // below TP1 (never fires) but broke the stored support level
  await positionRiskWatcher.runCycle();

  assert.equal(positionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT'), undefined);
  const closed = positionsRepository.listAllClosedPositions('demo', testUserId).find((p) => p.id === position.id);
  assert.equal(closed.exit_reason, 'reversal');
});

test('adaptive futures: gap through multiple tiers fires each in order and fully closes at the last one', async (t) => {
  mockFuturesPrice(t, 100);
  const position = futuresPortfolioService.openPosition('demo', testUserId, {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', side: 'long', leverage: 2, qty: 10, entryPrice: 100, stopLoss: 80,
    adaptiveTp: { tp1Price: 110, tp1QtyPercent: 50, tp2Price: 120, tp2QtyPercent: 50 },
  });

  mockFuturesPrice(t, 125); // gapped past both tiers
  await positionRiskWatcher.runCycle();

  assert.equal(futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT'), undefined);
  const closed = futuresPositionsRepository.listAllClosedPositions('demo', testUserId).find((p) => p.id === position.id);
  assert.ok(closed.realized_pnl > 0);
});

test('adaptive spot: partial fills, trailing seed, and final exit all write a dedicated "adaptive-tp" log entry with realizedR on the final exit', async (t) => {
  const logger = require('../../src/services/logging/logger');
  t.mock.method(marketDataService, 'getCandles', async () => fakeAtrCandles());
  const infoSpy = t.mock.method(logger, 'info');

  mockSpotPrice(t, 100);
  portfolioService.openPosition('demo', testUserId, {
    symbol: 'BTC/USDT', exchange: 'kucoin', side: 'buy', qty: 10, entryPrice: 100, stopLoss: 80,
    adaptiveTp: { tp1Price: 110, tp1QtyPercent: 50, tp2Price: 120, tp2QtyPercent: 50, recommendedTrailingMultiplier: 2, rMultiple: 20 },
  });

  mockSpotPrice(t, 111); // fires TP1, leaves 50% open -> partial fill + trailing seed
  await positionRiskWatcher.runCycle();

  const adaptiveLogsAfterTp1 = infoSpy.mock.calls.filter((c) => c.arguments[0] === 'adaptive-tp');
  assert.ok(adaptiveLogsAfterTp1.some((c) => c.arguments[1].includes('TP1 partial fill')));
  assert.ok(adaptiveLogsAfterTp1.some((c) => c.arguments[1].includes('Trailing seeded')));

  mockSpotPrice(t, 121); // fires TP2 -> this closes the full remaining 50%, a final exit
  await positionRiskWatcher.runCycle();

  const finalExitLog = infoSpy.mock.calls.find((c) => c.arguments[0] === 'adaptive-tp' && c.arguments[1].includes('Final exit'));
  assert.ok(finalExitLog, 'a Final exit adaptive-tp log entry was written');
  assert.match(finalExitLog.arguments[1], /\dR\)/, 'the final-exit message includes the realized R-multiple');
  assert.ok(typeof finalExitLog.arguments[2].realizedR === 'number');
});

test('adaptive futures: non-adaptive positions in the same cycle are completely unaffected (regression pin)', async (t) => {
  mockFuturesPrice(t, 100);
  futuresPortfolioService.openPosition('demo', testUserId, {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', side: 'long', leverage: 2, qty: 10, entryPrice: 100, stopLoss: 90, takeProfit: 140,
  });
  mockFuturesPrice(t, 130); // between stop and take-profit, nothing should happen
  await positionRiskWatcher.runCycle();
  const position = futuresPositionsRepository.findOpenPositionBySymbol('demo', testUserId, 'BTC/USDT:USDT');
  assert.ok(position);
  assert.equal(position.qty, 10, 'never touched by any adaptive-TP code path');
});
