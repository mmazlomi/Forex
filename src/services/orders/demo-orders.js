'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../../../config/config');
const marketDataService = require('../market-data/market-data-service');
const portfolioService = require('../portfolio/portfolio-service');
const riskSettingsRepository = require('../../database/repositories/risk-settings-repository');
const emergencyStopRepository = require('../../database/repositories/emergency-stop-repository');
const ordersRepository = require('../../database/repositories/orders-repository');
const positionsRepository = require('../../database/repositories/positions-repository');
const logger = require('../logging/logger');
const { validateTrade } = require('../risk/validate-trade');

const MODE = 'demo';
const DUPLICATE_WINDOW_MS = 5000;
const MAX_DATA_AGE_MS = 5 * 60 * 1000;

function defaultRiskSettings(userId) {
  return riskSettingsRepository.ensureDefaults(userId, MODE, {
    maxRiskPerTradePercent: config.maxRiskPerTradePercent,
    maxDailyLossPercent: config.maxDailyLossPercent,
    maxOpenPositions: config.maxOpenPositions,
    maxOrderValue: config.maxOrderValue,
    minRiskRewardRatio: config.minRiskRewardRatio,
    maxPortfolioExposurePercent: 50,
  });
}

function persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode, message, idempotencyKey, signalId }) {
  return ordersRepository.insertOrder(MODE, userId, {
    id,
    symbol,
    side,
    qty: 0,
    price: price ?? 0,
    stopLoss: stopLoss ?? null,
    takeProfit: takeProfit ?? null,
    status: 'rejected',
    rejectReason: `${reasonCode}: ${message}`,
    idempotencyKey: idempotencyKey ?? null,
    createdAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
  });
}

const PENDING_ORDER_TYPES = ['limit', 'stop_market', 'stop_limit'];

/**
 * Places a simulated Demo order for this user. BUY opens a new (long) position sized by the risk
 * pipeline; SELL closes an existing open position for the symbol (v1 is long-only spot — no
 * shorting). Never calls any exchange order endpoint, regardless of code path.
 *
 * Market orders (orderType omitted/'market') fill synchronously exactly as before this comment
 * was added — that whole path is untouched. Every other order type is always stored
 * `status: 'pending'` and left for pending-orders-watcher.js's next poll cycle to evaluate,
 * *even if* the given limit/trigger price already happens to be crossed by the current price at
 * submission time — there's no "fill immediately if already marketable" fast path in this phase.
 * That's a deliberate simplicity trade-off (one fill code path, always via the watcher, instead
 * of two), not an oversight — worst case it adds one poll interval (default 30s) of latency to an
 * order that would've filled instantly on a real exchange.
 */
async function placeDemoOrder({ userId, symbol, exchange, side, stopLoss, takeProfit, qty, idempotencyKey, signalId, orderType, limitPrice, triggerPrice, strategyId, timeframe, trailingPercent, reason }) {
  const id = uuidv4();
  side = side.toLowerCase();
  orderType = (orderType || 'market').toLowerCase();

  if (idempotencyKey) {
    const existing = ordersRepository.findByIdempotencyKey(MODE, userId, idempotencyKey);
    if (existing) return existing;
  }

  const snapshot = await marketDataService.getSnapshot({ symbol, exchange });
  if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, reasonCode: 'INVALID_PRICE', message: snapshot.error || 'Market price unavailable', idempotencyKey, signalId });
  }
  const price = snapshot.price;

  if (emergencyStopRepository.isActive(MODE, userId)) {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'EMERGENCY_STOP_ACTIVE', message: 'Demo trading is halted by an active emergency stop.', idempotencyKey, signalId });
  }

  const isDuplicate = !!ordersRepository.findRecentSimilarOrder(MODE, userId, { symbol, side, price, windowMs: DUPLICATE_WINDOW_MS });
  if (isDuplicate) {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'DUPLICATE_ORDER', message: 'An equivalent order was just submitted.', idempotencyKey, signalId });
  }

  // OCO is exit-only (protects/closes an existing position with a linked take-profit + stop-loss
  // pair). A standalone (non-OCO) Limit/Stop-Market/Stop-Limit sell is also a real, valid exit
  // order — e.g. just a take-profit limit sell with no linked stop — placed as a single pending
  // order against the open position. Both are checked ahead of the generic side==='sell' branch
  // below, which is Market-only and always means "close now."
  if (side === 'sell' && orderType === 'oco') {
    return placeDemoOcoExit({ userId, symbol, exchange, price, stopLoss, takeProfit, idempotencyKey, signalId });
  }

  if (side === 'sell' && PENDING_ORDER_TYPES.includes(orderType)) {
    if ((orderType === 'limit' || orderType === 'stop_limit') && typeof limitPrice !== 'number') {
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'MISSING_LIMIT_PRICE', message: `orderType "${orderType}" requires a numeric limitPrice.`, idempotencyKey, signalId });
    }
    if ((orderType === 'stop_market' || orderType === 'stop_limit') && typeof triggerPrice !== 'number') {
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'MISSING_TRIGGER_PRICE', message: `orderType "${orderType}" requires a numeric triggerPrice.`, idempotencyKey, signalId });
    }
    return placeDemoPendingSell({ userId, symbol, exchange, orderType, limitPrice, triggerPrice, price, idempotencyKey, signalId });
  }

  if (side === 'sell') {
    return closeDemoPosition({ id, userId, symbol, price, idempotencyKey, signalId, reason });
  }

  if (side !== 'buy') {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'INVALID_SIDE', message: `Unknown order side "${side}"`, idempotencyKey, signalId });
  }

  if (typeof stopLoss !== 'number' || typeof takeProfit !== 'number') {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'MISSING_RISK_PARAMS', message: 'stopLoss and takeProfit are required to open a position.', idempotencyKey, signalId });
  }

  if (orderType !== 'market') {
    if (!PENDING_ORDER_TYPES.includes(orderType)) {
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'INVALID_ORDER_TYPE', message: `Unknown orderType "${orderType}".`, idempotencyKey, signalId });
    }
    if ((orderType === 'limit' || orderType === 'stop_limit') && typeof limitPrice !== 'number') {
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'MISSING_LIMIT_PRICE', message: `orderType "${orderType}" requires a numeric limitPrice.`, idempotencyKey, signalId });
    }
    if ((orderType === 'stop_market' || orderType === 'stop_limit') && typeof triggerPrice !== 'number') {
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'MISSING_TRIGGER_PRICE', message: `orderType "${orderType}" requires a numeric triggerPrice.`, idempotencyKey, signalId });
    }
    return placeDemoPendingBuy({ id, userId, symbol, exchange, orderType, limitPrice, triggerPrice, stopLoss, takeProfit, qty, price, snapshot, idempotencyKey, signalId });
  }

  const riskSettings = toRiskSettingsShape(defaultRiskSettings(userId));
  const portfolio = portfolioService.getSnapshot(MODE, userId);

  const validation = validateTrade({
    mode: MODE,
    emergencyStopActive: false, // already checked above
    liveTradingEnabled: true, // n/a for demo
    dataQuality: snapshot.dataFreshnessMs > MAX_DATA_AGE_MS ? 'insufficient' : 'good',
    dataAgeMs: snapshot.dataFreshnessMs,
    maxDataAgeMs: MAX_DATA_AGE_MS,
    entryPrice: price,
    stopLossPrice: stopLoss,
    takeProfitPrice: takeProfit,
    riskSettings,
    balance: portfolio.balance,
    openPositionsCount: portfolio.openPositions.length,
    dailyLossSoFar: portfolio.dailyLossSoFar,
    currentExposureValue: portfolio.exposureValue,
    isDuplicate: false, // already checked above
    qtyOverride: qty,
  });

  if (!validation.accepted) {
    logger.warn('demo-orders', `Demo order rejected for ${symbol}: ${validation.reasonCode}`, { message: validation.message }, MODE);
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: validation.reasonCode, message: validation.message, idempotencyKey, signalId });
  }

  const position = portfolioService.openPosition(MODE, userId, { symbol, exchange, side: 'buy', qty: validation.positionSize, entryPrice: price, stopLoss, takeProfit, signalId, strategyId, timeframe, trailingPercent });

  const order = ordersRepository.insertOrder(MODE, userId, {
    id,
    symbol,
    side: 'buy',
    qty: validation.positionSize,
    price,
    stopLoss,
    takeProfit,
    status: 'filled',
    rejectReason: null,
    idempotencyKey: idempotencyKey ?? null,
    createdAtUtc: new Date().toISOString(),
    filledAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
  });

  logger.info('demo-orders', `Demo BUY filled for ${symbol}`, { qty: validation.positionSize, price, positionId: position.id }, MODE);
  return order;
}

function closeDemoPosition({ id, userId, symbol, price, idempotencyKey, signalId, reason }) {
  const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    return persistRejected({ id, userId, symbol, side: 'sell', price, reasonCode: 'NO_OPEN_POSITION_TO_CLOSE', message: `No open Demo position for ${symbol} (long-only in v1 — SELL only closes an existing position).`, idempotencyKey, signalId });
  }

  const { realizedPnl } = portfolioService.closePosition(MODE, userId, openPosition.id, price, reason ?? 'manual');

  const order = ordersRepository.insertOrder(MODE, userId, {
    id,
    symbol,
    side: 'sell',
    qty: openPosition.qty,
    price,
    stopLoss: null,
    takeProfit: null,
    status: 'filled',
    rejectReason: null,
    idempotencyKey: idempotencyKey ?? null,
    createdAtUtc: new Date().toISOString(),
    filledAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
    realizedPnl,
  });

  logger.info('demo-orders', `Demo SELL closed position for ${symbol}`, { realizedPnl, positionId: openPosition.id }, MODE);
  return order;
}

// Effective price for risk/sizing math per order type — see validate-trade.js's entryPrice
// contract comment. A limit far from the live price must be sized against where it will
// actually fill, not today's price.
function effectivePriceFor(orderType, limitPrice, triggerPrice) {
  if (orderType === 'limit' || orderType === 'stop_limit') return limitPrice;
  if (orderType === 'stop_market') return triggerPrice;
  return undefined;
}

function placeDemoPendingBuy({ id, userId, symbol, exchange, orderType, limitPrice, triggerPrice, stopLoss, takeProfit, qty, price, snapshot, idempotencyKey, signalId }) {
  const effectiveEntryPrice = effectivePriceFor(orderType, limitPrice, triggerPrice);
  const riskSettings = toRiskSettingsShape(defaultRiskSettings(userId));
  const portfolio = portfolioService.getSnapshot(MODE, userId);

  const validation = validateTrade({
    mode: MODE,
    emergencyStopActive: false,
    liveTradingEnabled: true,
    dataQuality: snapshot.dataFreshnessMs > MAX_DATA_AGE_MS ? 'insufficient' : 'good',
    dataAgeMs: snapshot.dataFreshnessMs,
    maxDataAgeMs: MAX_DATA_AGE_MS,
    entryPrice: effectiveEntryPrice,
    stopLossPrice: stopLoss,
    takeProfitPrice: takeProfit,
    riskSettings,
    balance: portfolio.balance,
    openPositionsCount: portfolio.openPositions.length,
    dailyLossSoFar: portfolio.dailyLossSoFar,
    currentExposureValue: portfolio.exposureValue,
    isDuplicate: false,
    qtyOverride: qty,
  });

  if (!validation.accepted) {
    logger.warn('demo-orders', `Demo ${orderType} order rejected for ${symbol}: ${validation.reasonCode}`, { message: validation.message }, MODE);
    return persistRejected({ id, userId, symbol, side: 'buy', stopLoss, takeProfit, price, reasonCode: validation.reasonCode, message: validation.message, idempotencyKey, signalId });
  }

  const order = ordersRepository.insertOrder(MODE, userId, {
    id,
    symbol,
    side: 'buy',
    qty: validation.positionSize,
    price, // live reference price at submission time — not what this order will fill at
    stopLoss,
    takeProfit,
    status: 'pending',
    rejectReason: null,
    idempotencyKey: idempotencyKey ?? null,
    createdAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
    orderType,
    limitPrice: limitPrice ?? null,
    triggerPrice: triggerPrice ?? null,
    exchange,
  });

  logger.info('demo-orders', `Demo ${orderType} BUY order placed (pending) for ${symbol}`, { qty: validation.positionSize, orderId: id }, MODE);
  return order;
}

/** Shared by placeDemoPendingSell and placeDemoOcoExit — one pending sell order (a plain
 * standalone exit, or one leg of an OCO pair when ocoGroupId is set). */
function createPendingDemoSell({ userId, symbol, exchange, qty, price, orderType, limitPrice, triggerPrice, ocoGroupId, idempotencyKey, signalId }) {
  return ordersRepository.insertOrder(MODE, userId, {
    id: uuidv4(), symbol, side: 'sell', qty, price,
    stopLoss: null, takeProfit: null, status: 'pending', rejectReason: null,
    idempotencyKey: idempotencyKey ?? null, createdAtUtc: new Date().toISOString(), signalId: signalId ?? null,
    orderType, limitPrice: limitPrice ?? null, triggerPrice: triggerPrice ?? null, ocoGroupId: ocoGroupId ?? null, exchange,
  });
}

/** A single, standalone pending exit order (e.g. just a take-profit limit sell, no linked stop). */
function placeDemoPendingSell({ userId, symbol, exchange, orderType, limitPrice, triggerPrice, price, idempotencyKey, signalId }) {
  const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    return persistRejected({ id: uuidv4(), userId, symbol, side: 'sell', price, reasonCode: 'NO_OPEN_POSITION_TO_CLOSE', message: `No open Demo position for ${symbol} to place a pending exit order against.`, idempotencyKey, signalId });
  }
  const order = createPendingDemoSell({ userId, symbol, exchange, qty: openPosition.qty, price, orderType, limitPrice, triggerPrice, idempotencyKey, signalId });
  logger.info('demo-orders', `Demo ${orderType} SELL order placed (pending) for ${symbol}`, { orderId: order.id }, MODE);
  return order;
}

/**
 * OCO exit: reuses the caller's stopLoss/takeProfit fields as the two leg prices (stop-loss ->
 * the stop-market leg's trigger; take-profit -> the limit leg's price) rather than introducing a
 * third, redundant price pair — see docs/architecture.md's order-types section. Returns
 * {takeProfitOrder, stopLossOrder} instead of a single order — a deliberate, documented shape
 * difference from every other order type, since this genuinely creates two linked orders.
 */
function placeDemoOcoExit({ userId, symbol, exchange, price, stopLoss, takeProfit, idempotencyKey, signalId }) {
  const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    const rejected = persistRejected({ id: uuidv4(), userId, symbol, side: 'sell', price, reasonCode: 'NO_OPEN_POSITION_FOR_OCO', message: `No open Demo position for ${symbol} to protect with an OCO exit.`, idempotencyKey, signalId });
    return { takeProfitOrder: rejected, stopLossOrder: null };
  }
  if (typeof takeProfit !== 'number' || typeof stopLoss !== 'number') {
    const rejected = persistRejected({ id: uuidv4(), userId, symbol, side: 'sell', price, reasonCode: 'MISSING_RISK_PARAMS', message: 'OCO requires both takeProfit (limit leg) and stopLoss (stop-market leg) prices.', idempotencyKey, signalId });
    return { takeProfitOrder: rejected, stopLossOrder: null };
  }

  const ocoGroupId = uuidv4();
  const takeProfitOrder = createPendingDemoSell({ userId, symbol, exchange, qty: openPosition.qty, price, orderType: 'limit', limitPrice: takeProfit, ocoGroupId, idempotencyKey, signalId });
  const stopLossOrder = createPendingDemoSell({ userId, symbol, exchange, qty: openPosition.qty, price, orderType: 'stop_market', triggerPrice: stopLoss, ocoGroupId, signalId });

  logger.info('demo-orders', `Demo OCO exit placed for ${symbol}`, { ocoGroupId, takeProfitId: takeProfitOrder.id, stopLossId: stopLossOrder.id }, MODE);
  return { takeProfitOrder, stopLossOrder };
}

/** Used by pending-orders-watcher.js once it confirms a pending BUY's limit/trigger condition is
 *  met. `order` already carries its owning user_id — no separate userId parameter needed. */
function finalizeDemoBuyFill(order, fillPrice) {
  const userId = order.user_id;
  const position = portfolioService.openPosition(MODE, userId, {
    symbol: order.symbol, exchange: order.exchange ?? null, side: 'buy',
    qty: order.qty, entryPrice: fillPrice, stopLoss: order.stop_loss, takeProfit: order.take_profit,
    signalId: order.signal_id,
  });
  const updated = ordersRepository.updateOrderStatus(MODE, userId, order.id, { status: 'filled', filledAtUtc: new Date().toISOString(), price: fillPrice });
  logger.info('demo-orders', `Demo ${order.order_type} BUY filled for ${order.symbol}`, { qty: order.qty, fillPrice, positionId: position.id }, MODE);
  return updated;
}

/** Used by pending-orders-watcher.js for a pending SELL/OCO-leg (order type limit or stop_market on the sell side). */
function finalizeDemoSellFill(order, fillPrice) {
  const userId = order.user_id;
  const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, order.symbol);
  if (!openPosition) {
    // The position this order was meant to close is already gone (e.g. closed manually while
    // this order sat pending) — nothing left to sell. Cancel rather than error.
    return cancelDemoOrder(order);
  }
  // A resting stop_market leg (standalone or the stop half of an OCO pair) is functionally a
  // stop-loss exit; a resting limit leg (standalone or the OCO take-profit half) is a take-profit
  // exit — same convention position-risk-watcher.js uses for its own live-triggered closes.
  const reason = order.order_type === 'stop_market' ? 'stop_loss' : 'take_profit';
  const { realizedPnl } = portfolioService.closePosition(MODE, userId, openPosition.id, fillPrice, reason);
  const updated = ordersRepository.updateOrderStatus(MODE, userId, order.id, { status: 'filled', filledAtUtc: new Date().toISOString(), realizedPnl, price: fillPrice });
  logger.info('demo-orders', `Demo ${order.order_type} SELL filled for ${order.symbol}`, { realizedPnl, positionId: openPosition.id }, MODE);
  return updated;
}

/** Used by pending-orders-watcher.js (OCO sibling-cancel) and the manual cancel endpoint. */
function cancelDemoOrder(order) {
  return ordersRepository.updateOrderStatus(MODE, order.user_id, order.id, { status: 'cancelled', cancelledAtUtc: new Date().toISOString() });
}

function toRiskSettingsShape(row) {
  return {
    maxRiskPerTradePercent: row.max_risk_per_trade_percent,
    maxDailyLossPercent: row.max_daily_loss_percent,
    maxOpenPositions: row.max_open_positions,
    maxOrderValue: row.max_order_value,
    minRiskRewardRatio: row.min_risk_reward_ratio,
    maxPortfolioExposurePercent: row.max_portfolio_exposure_percent,
  };
}

module.exports = { placeDemoOrder, finalizeDemoBuyFill, finalizeDemoSellFill, cancelDemoOrder };
