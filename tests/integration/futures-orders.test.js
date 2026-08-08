'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const marketDataService = require('../../src/services/market-data/market-data-service');
const usersRepository = require('../../src/database/repositories/users-repository');

function mockPrice(price) {
  return {
    symbol: 'BTC/USDT:USDT', exchange: 'kucoin', status: 'ok', price,
    changePercent24h: 1, volume24h: 100, marketOpen: true, dataFreshnessMs: 500,
    asOfUtc: new Date().toISOString(),
  };
}

test('futures-demo-orders: open_long, close, and the safety checks around them', async (t) => {
  resetForTests();
  const userId = usersRepository.createUser('futures-orders-user1', 'irrelevant-hash').id;
  const { placeDemoFuturesOrder } = require('../../src/services/orders/futures-demo-orders');
  const futuresPortfolioService = require('../../src/services/portfolio/futures-portfolio-service');
  const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');

  futuresPortfolioRepository.ensureInitialized('demo', userId, 10000);
  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(60000));

  await t.test('rejects open_long missing stopLoss/takeProfit', async () => {
    const order = await placeDemoFuturesOrder({ userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5 });
    assert.equal(order.status, 'rejected');
    assert.match(order.reject_reason, /MISSING_RISK_PARAMS/);
  });

  await t.test('rejects a stop-loss that sits beyond the estimated liquidation price', async () => {
    // 10x leverage (at the default max) on a long -> liquidation is roughly
    // entry*(1 - 1/10 + 0.005) = entry*0.905 = 54300. A stop-loss of 50000 is BELOW that (would
    // never trigger; liquidation happens first).
    const order = await placeDemoFuturesOrder({
      userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 10, stopLoss: 50000, takeProfit: 70000,
    });
    assert.equal(order.status, 'rejected');
    assert.match(order.reject_reason, /STOP_LOSS_BEYOND_LIQUIDATION/);
  });

  await t.test('rejects leverage above the configured max', async () => {
    const order = await placeDemoFuturesOrder({
      userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 999, stopLoss: 58000, takeProfit: 70000,
    });
    assert.equal(order.status, 'rejected');
    assert.match(order.reject_reason, /LEVERAGE_TOO_HIGH/);
  });

  let openedPositionQty;
  await t.test('opens a long position with a well-formed order, recording leverage and an estimated liquidation price', async () => {
    // entry 60000, leverage 5x -> est. liquidation ~48300. stop 50000 is safely above that.
    // riskPerUnit 10000 -> positionSize 0.01 (maxRiskAmount 100/10000) -> notional 600, well
    // under the default maxOrderValue (1000). reward 20000 / risk 10000 = 2.0 >= minRiskReward 1.5.
    const order = await placeDemoFuturesOrder({
      userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000,
    });
    assert.equal(order.status, 'filled');
    assert.equal(order.action, 'open_long');
    assert.equal(order.leverage, 5);
    openedPositionQty = order.qty;

    const snapshot = futuresPortfolioService.getSnapshot('demo', userId);
    assert.equal(snapshot.openPositions.length, 1);
    assert.equal(snapshot.openPositions[0].side, 'long');
    assert.equal(snapshot.openPositions[0].leverage, 5);
    assert.ok(typeof snapshot.openPositions[0].liquidation_price === 'number');
    // marginUsed should be notional/leverage, strictly less than the notional exposure itself.
    assert.ok(snapshot.marginUsed < snapshot.exposureValue);
  });

  await t.test('one-way mode: a second open_long for the same symbol is rejected while one is already open', async () => {
    // A different reference price than the opening order above, purely to sidestep the
    // (separately-tested) duplicate-order guard, which would otherwise trip first on an
    // identical symbol/action/price submitted again within its 5-second window.
    t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(60001));
    const order = await placeDemoFuturesOrder({
      userId, symbol: 'BTC/USDT:USDT', action: 'open_long', leverage: 5, stopLoss: 50000, takeProfit: 80000,
    });
    assert.equal(order.status, 'rejected');
    assert.match(order.reject_reason, /POSITION_ALREADY_OPEN/);
  });

  await t.test('close realizes P&L and frees the symbol for a new position', async () => {
    t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(63000));
    const order = await placeDemoFuturesOrder({ userId, symbol: 'BTC/USDT:USDT', action: 'close' });
    assert.equal(order.status, 'filled');
    assert.equal(order.action, 'close');
    assert.equal(order.qty, openedPositionQty);
    assert.ok(order.realized_pnl > 0); // long, price rose 60000 -> 63000

    const snapshot = futuresPortfolioService.getSnapshot('demo', userId);
    assert.equal(snapshot.openPositions.length, 0);
    assert.equal(snapshot.balance, 10000 + order.realized_pnl);
  });

  await t.test('close with no open position is rejected, not silently a no-op', async () => {
    t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(63001)); // dodge the duplicate-window guard again
    const order = await placeDemoFuturesOrder({ userId, symbol: 'BTC/USDT:USDT', action: 'close' });
    assert.equal(order.status, 'rejected');
    assert.match(order.reject_reason, /NO_OPEN_POSITION_TO_CLOSE/);
  });
});

test('futures-demo-orders: open_short direction (short profits when price falls)', async (t) => {
  resetForTests();
  const userId = usersRepository.createUser('futures-orders-user2', 'irrelevant-hash').id;
  const { placeDemoFuturesOrder } = require('../../src/services/orders/futures-demo-orders');
  const futuresPortfolioRepository = require('../../src/database/repositories/futures-portfolio-repository');
  futuresPortfolioRepository.ensureInitialized('demo', userId, 10000);

  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(60000));
  // entry 60000, leverage 3x -> est. liquidation ~79700 for a short. stop 70000 is safely below
  // that. riskPerUnit 10000 -> positionSize 0.01 -> notional 600. reward 20000/risk 10000 = 2.0.
  const openOrder = await placeDemoFuturesOrder({
    userId, symbol: 'ETH/USDT:USDT', action: 'open_short', leverage: 3, stopLoss: 70000, takeProfit: 40000,
  });
  assert.equal(openOrder.status, 'filled');

  t.mock.method(marketDataService, 'getFuturesSnapshot', async () => mockPrice(55000)); // price fell
  const closeOrder = await placeDemoFuturesOrder({ userId, symbol: 'ETH/USDT:USDT', action: 'close' });
  assert.equal(closeOrder.status, 'filled');
  assert.ok(closeOrder.realized_pnl > 0); // short profits when price falls
});
