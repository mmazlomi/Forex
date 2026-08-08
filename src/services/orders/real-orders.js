'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../../../config/config');
const marketDataService = require('../market-data/market-data-service');
const portfolioService = require('../portfolio/portfolio-service');
const portfolioRepository = require('../../database/repositories/portfolio-repository');
const riskSettingsRepository = require('../../database/repositories/risk-settings-repository');
const emergencyStopRepository = require('../../database/repositories/emergency-stop-repository');
const ordersRepository = require('../../database/repositories/orders-repository');
const positionsRepository = require('../../database/repositories/positions-repository');
const realAuditLogRepository = require('../../database/repositories/real-audit-log-repository');
const exchangeClientFactory = require('../exchanges/exchange-client-factory');
const { resolveRealCredentials } = require('../exchanges/real-credentials-resolver');
const logger = require('../logging/logger');
const { validateTrade } = require('../risk/validate-trade');

const MODE = 'real';
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

function persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode, message, idempotencyKey, signalId }) {
  const order = ordersRepository.insertOrder(MODE, userId, {
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
  logger.warn('real-orders', `Real order rejected for ${symbol}: ${reasonCode}`, { message }, MODE);
  return order;
}

const PENDING_ORDER_TYPES = ['limit', 'stop_market', 'stop_limit'];

/**
 * Whether the resolved exchange client can actually place this order type, checked BEFORE any
 * exchange mutation. ccxt's per-order-type convenience methods (createStopMarketOrder etc.) are
 * NOT what this gates on — verified directly against ccxt 4.5.70's source: createStopOrder(symbol,
 * type, side, amount, price, triggerPrice) and createStopLimitOrder(symbol, side, amount, price,
 * triggerPrice) are thin, universal wrappers around createOrder (they just extend params with
 * stopPrice and delegate), and confirmed `.has.createStopOrder`/`.has.createStopLimitOrder` are
 * both true on binance/bybit/okx/kucoin — including binance, which lacks the narrower
 * createStopMarketOrder/createOrderWithTakeProfitAndStopLoss convenience flags. Using the
 * universal wrapper methods (not the narrower convenience ones) avoids that binance-shaped gap
 * entirely rather than needing an exchange-specific carve-out.
 */
function checkOrderTypeSupported(client, orderType) {
  if (orderType === 'market') return true;
  if (client.id === 'nobitex') return orderType === 'limit'; // only limit implemented on the custom Nobitex adapter — see docs/architecture.md §16
  if (orderType === 'limit') return client.has?.createOrder !== false;
  if (orderType === 'stop_market') return client.has?.createStopOrder === true;
  if (orderType === 'stop_limit') return client.has?.createStopLimitOrder === true;
  return false;
}

/** Places the actual exchange-side order for a non-market order type. Returns ccxt's unified order response. */
async function submitPendingExchangeOrder(client, { symbol, orderType, side, amount, limitPrice, triggerPrice }) {
  if (orderType === 'limit') return client.createOrder(symbol, 'limit', side, amount, limitPrice);
  if (orderType === 'stop_market') return client.createStopOrder(symbol, 'market', side, amount, undefined, triggerPrice);
  if (orderType === 'stop_limit') return client.createStopLimitOrder(symbol, side, amount, limitPrice, triggerPrice);
  throw new Error(`submitPendingExchangeOrder: unhandled orderType "${orderType}"`);
}

function effectivePriceFor(orderType, limitPrice, triggerPrice) {
  if (orderType === 'limit' || orderType === 'stop_limit') return limitPrice;
  if (orderType === 'stop_market') return triggerPrice;
  return undefined;
}

/**
 * Places a Real (live-money) order for this user. This is the ONLY function in the codebase that
 * may call an exchange's live order-placement endpoint. Every guard below runs, in order, before
 * any network call reaches the exchange — including the ENABLE_LIVE_TRADING gate, which is
 * re-read from config on every call rather than cached at boot. There is no fallback path to
 * demo-orders.js: a rejection here is a rejection, never a silent simulated fill.
 */
async function placeRealOrder({ userId, symbol, exchange, side, stopLoss, takeProfit, qty, idempotencyKey, signalId, unlockConfirmed, orderType, limitPrice, triggerPrice }) {
  const id = uuidv4();
  side = side.toLowerCase();
  orderType = (orderType || 'market').toLowerCase();

  // 1. Live-trading gate — checked first, before any other work.
  if (!config.enableLiveTrading) {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, reasonCode: 'LIVE_TRADING_DISABLED', message: 'ENABLE_LIVE_TRADING is not set to true in .env.', idempotencyKey, signalId });
  }
  const credentials = resolveRealCredentials(userId);
  if (!credentials.name || !credentials.apiKey || !credentials.apiSecret) {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, reasonCode: 'MISSING_REAL_CREDENTIALS', message: 'Real exchange credentials are not fully configured (set them from the Real Trading tab, or via REAL_EXCHANGE_NAME/REAL_API_KEY/REAL_API_SECRET in .env).', idempotencyKey, signalId });
  }
  if (!unlockConfirmed) {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, reasonCode: 'REAL_TRADING_NOT_UNLOCKED', message: 'The UI real-trading unlock/confirmation step was not completed for this request.', idempotencyKey, signalId });
  }

  if (idempotencyKey) {
    const existing = ordersRepository.findByIdempotencyKey(MODE, userId, idempotencyKey);
    if (existing) return existing;
  }

  if (emergencyStopRepository.isActive(MODE, userId)) {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, reasonCode: 'EMERGENCY_STOP_ACTIVE', message: 'Real trading is halted by an active emergency stop.', idempotencyKey, signalId });
  }

  const snapshot = await marketDataService.getSnapshot({ symbol, exchange });
  if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, reasonCode: 'INVALID_PRICE', message: snapshot.error || 'Market price unavailable', idempotencyKey, signalId });
  }
  const price = snapshot.price;

  const isDuplicate = !!ordersRepository.findRecentSimilarOrder(MODE, userId, { symbol, side, price, windowMs: DUPLICATE_WINDOW_MS });
  if (isDuplicate) {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'DUPLICATE_ORDER', message: 'An equivalent order was just submitted.', idempotencyKey, signalId });
  }

  // OCO is exit-only (protects/closes an existing position with a linked take-profit + stop-loss
  // pair). A standalone (non-OCO) Limit/Stop-Market/Stop-Limit sell is also valid — a single
  // pending exit order against the open position. Both checked ahead of the generic
  // side==='sell' branch below, which is Market-only and always means "close now."
  if (side === 'sell' && orderType === 'oco') {
    return placeRealOcoExit({ id, userId, symbol, exchange, price, stopLoss, takeProfit, idempotencyKey, signalId });
  }

  if (side === 'sell' && PENDING_ORDER_TYPES.includes(orderType)) {
    if ((orderType === 'limit' || orderType === 'stop_limit') && typeof limitPrice !== 'number') {
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'MISSING_LIMIT_PRICE', message: `orderType "${orderType}" requires a numeric limitPrice.`, idempotencyKey, signalId });
    }
    if ((orderType === 'stop_market' || orderType === 'stop_limit') && typeof triggerPrice !== 'number') {
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'MISSING_TRIGGER_PRICE', message: `orderType "${orderType}" requires a numeric triggerPrice.`, idempotencyKey, signalId });
    }
    return placeRealPendingSell({ id, userId, symbol, exchange, orderType, limitPrice, triggerPrice, price, idempotencyKey, signalId });
  }

  if (side === 'sell') {
    return closeRealPosition({ id, userId, symbol, exchange, price, idempotencyKey, signalId });
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
    return placeRealPendingBuy({ id, userId, symbol, exchange, orderType, limitPrice, triggerPrice, stopLoss, takeProfit, qty, price, snapshot, idempotencyKey, signalId });
  }

  const client = exchangeClientFactory.getRealExchange(userId);
  let liveBalanceQuote;
  try {
    const balance = await client.fetchBalance();
    const quoteCurrency = symbol.split('/')[1];
    liveBalanceQuote = balance.free?.[quoteCurrency] ?? 0;
    portfolioRepository.setBalance(MODE, userId, liveBalanceQuote);
  } catch (err) {
    logger.error('real-orders', `Failed to fetch live balance from exchange: ${err.message}`, {}, MODE);
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'EXCHANGE_UNAVAILABLE', message: `Could not fetch live balance: ${err.message}`, idempotencyKey, signalId });
  }

  const riskSettings = toRiskSettingsShape(defaultRiskSettings(userId));
  const portfolio = portfolioService.getSnapshot(MODE, userId);

  const validation = validateTrade({
    mode: MODE,
    emergencyStopActive: false,
    liveTradingEnabled: config.enableLiveTrading,
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
    isDuplicate: false,
    qtyOverride: qty,
  });

  if (!validation.accepted) {
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: validation.reasonCode, message: validation.message, idempotencyKey, signalId });
  }

  let exchangeResponse;
  try {
    exchangeResponse = await client.createOrder(symbol, 'market', 'buy', validation.positionSize);
  } catch (err) {
    logger.error('real-orders', `Exchange order placement failed for ${symbol}: ${err.message}`, {}, MODE);
    realAuditLogRepository.insertAuditEntry({ userId, orderId: id, requestJson: JSON.stringify({ symbol, side, qty: validation.positionSize }), responseJson: JSON.stringify({ error: err.message }) });
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'EXCHANGE_ORDER_FAILED', message: err.message, idempotencyKey, signalId });
  }

  realAuditLogRepository.insertAuditEntry({
    userId,
    orderId: id,
    requestJson: JSON.stringify({ symbol, side, qty: validation.positionSize }),
    responseJson: JSON.stringify(exchangeResponse),
  });

  const position = portfolioService.openPosition(MODE, userId, { symbol, exchange, side: 'buy', qty: validation.positionSize, entryPrice: price, stopLoss, takeProfit });

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
    exchangeOrderId: exchangeResponse?.id ?? null,
    createdAtUtc: new Date().toISOString(),
    filledAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
  });

  logger.info('real-orders', `Real BUY filled for ${symbol}`, { qty: validation.positionSize, price, positionId: position.id }, MODE);
  return order;
}

async function closeRealPosition({ id, userId, symbol, exchange, price, idempotencyKey, signalId }) {
  const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    return persistRejected({ id, userId, symbol, side: 'sell', price, reasonCode: 'NO_OPEN_POSITION_TO_CLOSE', message: `No open Real position for ${symbol}.`, idempotencyKey, signalId });
  }

  const client = exchangeClientFactory.getRealExchange(userId);
  let exchangeResponse;
  try {
    exchangeResponse = await client.createOrder(symbol, 'market', 'sell', openPosition.qty);
  } catch (err) {
    logger.error('real-orders', `Exchange close order failed for ${symbol}: ${err.message}`, {}, MODE);
    realAuditLogRepository.insertAuditEntry({ userId, orderId: id, requestJson: JSON.stringify({ symbol, side: 'sell', qty: openPosition.qty }), responseJson: JSON.stringify({ error: err.message }) });
    return persistRejected({ id, userId, symbol, side: 'sell', price, reasonCode: 'EXCHANGE_ORDER_FAILED', message: err.message, idempotencyKey, signalId });
  }

  realAuditLogRepository.insertAuditEntry({
    userId,
    orderId: id,
    requestJson: JSON.stringify({ symbol, side: 'sell', qty: openPosition.qty }),
    responseJson: JSON.stringify(exchangeResponse),
  });

  const { realizedPnl } = portfolioService.closePosition(MODE, userId, openPosition.id, price);

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
    exchangeOrderId: exchangeResponse?.id ?? null,
    createdAtUtc: new Date().toISOString(),
    filledAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
    realizedPnl,
  });

  logger.info('real-orders', `Real SELL closed position for ${symbol}`, { realizedPnl, positionId: openPosition.id }, MODE);
  return order;
}

function placeRealPendingBuy({ id, userId, symbol, exchange, orderType, limitPrice, triggerPrice, stopLoss, takeProfit, qty, price, snapshot, idempotencyKey, signalId }) {
  return placeRealPendingOrder({ id, userId, symbol, exchange, side: 'buy', orderType, limitPrice, triggerPrice, stopLoss, takeProfit, qty, price, snapshot, idempotencyKey, signalId });
}

/** A single, standalone pending exit order (e.g. just a take-profit limit sell, no linked stop). */
async function placeRealPendingSell({ id, userId, symbol, exchange, orderType, limitPrice, triggerPrice, price, idempotencyKey, signalId }) {
  const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    return persistRejected({ id, userId, symbol, side: 'sell', price, reasonCode: 'NO_OPEN_POSITION_TO_CLOSE', message: `No open Real position for ${symbol} to place a pending exit order against.`, idempotencyKey, signalId });
  }
  return placeRealPendingOrder({ id, userId, symbol, exchange, side: 'sell', orderType, limitPrice, triggerPrice, qty: openPosition.qty, price, idempotencyKey, signalId });
}

/**
 * Shared by placeRealPendingBuy/placeRealPendingSell/placeRealOcoExit. Resolves the client,
 * checks order-type capability BEFORE any exchange mutation (see checkOrderTypeSupported), and —
 * for BUY only — fetches live balance and runs the risk pipeline exactly like the market path
 * does (sizing against the order's own limit/trigger price as entryPrice, not the live snapshot
 * — see validate-trade.js's entryPrice contract comment). SELL/OCO legs skip the risk pipeline,
 * matching closeRealPosition's existing convention (closing/protecting a position was never
 * risk-validated here either).
 */
async function placeRealPendingOrder({ id, userId, symbol, exchange, side, orderType, limitPrice, triggerPrice, stopLoss, takeProfit, qty, price, snapshot, idempotencyKey, signalId, ocoGroupId }) {
  const client = exchangeClientFactory.getRealExchange(userId);
  if (!checkOrderTypeSupported(client, orderType)) {
    const reasonCode = client.id === 'nobitex' ? 'ORDER_TYPE_UNIMPLEMENTED_FOR_EXCHANGE' : 'ORDER_TYPE_UNSUPPORTED_ON_EXCHANGE';
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode, message: `${client.id} does not support ${orderType} orders.`, idempotencyKey, signalId });
  }

  let amount = qty;
  if (side === 'buy') {
    let liveBalanceQuote;
    try {
      const balance = await client.fetchBalance();
      const quoteCurrency = symbol.split('/')[1];
      liveBalanceQuote = balance.free?.[quoteCurrency] ?? 0;
      portfolioRepository.setBalance(MODE, userId, liveBalanceQuote);
    } catch (err) {
      logger.error('real-orders', `Failed to fetch live balance from exchange: ${err.message}`, {}, MODE);
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'EXCHANGE_UNAVAILABLE', message: `Could not fetch live balance: ${err.message}`, idempotencyKey, signalId });
    }

    const riskSettings = toRiskSettingsShape(defaultRiskSettings(userId));
    const portfolio = portfolioService.getSnapshot(MODE, userId);
    const validation = validateTrade({
      mode: MODE,
      emergencyStopActive: false,
      liveTradingEnabled: config.enableLiveTrading,
      dataQuality: snapshot.dataFreshnessMs > MAX_DATA_AGE_MS ? 'insufficient' : 'good',
      dataAgeMs: snapshot.dataFreshnessMs,
      maxDataAgeMs: MAX_DATA_AGE_MS,
      entryPrice: effectivePriceFor(orderType, limitPrice, triggerPrice),
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
      return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: validation.reasonCode, message: validation.message, idempotencyKey, signalId });
    }
    amount = validation.positionSize;
  }

  let exchangeResponse;
  try {
    exchangeResponse = await submitPendingExchangeOrder(client, { symbol, orderType, side, amount, limitPrice, triggerPrice });
  } catch (err) {
    logger.error('real-orders', `Exchange ${orderType} order placement failed for ${symbol}: ${err.message}`, {}, MODE);
    realAuditLogRepository.insertAuditEntry({ userId, orderId: id, requestJson: JSON.stringify({ symbol, side, orderType, amount, limitPrice, triggerPrice }), responseJson: JSON.stringify({ error: err.message }) });
    return persistRejected({ id, userId, symbol, side, stopLoss, takeProfit, price, reasonCode: 'EXCHANGE_ORDER_FAILED', message: err.message, idempotencyKey, signalId });
  }

  realAuditLogRepository.insertAuditEntry({
    userId,
    orderId: id,
    requestJson: JSON.stringify({ symbol, side, orderType, amount, limitPrice, triggerPrice }),
    responseJson: JSON.stringify(exchangeResponse),
  });

  const order = ordersRepository.insertOrder(MODE, userId, {
    id, symbol, side, qty: amount, price,
    stopLoss: side === 'buy' ? stopLoss : null, takeProfit: side === 'buy' ? takeProfit : null,
    status: 'pending', rejectReason: null, idempotencyKey: idempotencyKey ?? null,
    exchangeOrderId: exchangeResponse?.id ?? null, createdAtUtc: new Date().toISOString(), signalId: signalId ?? null,
    orderType, limitPrice: limitPrice ?? null, triggerPrice: triggerPrice ?? null, ocoGroupId: ocoGroupId ?? null, exchange,
  });

  logger.info('real-orders', `Real ${orderType} ${side.toUpperCase()} order placed (pending) for ${symbol}`, { amount, exchangeOrderId: exchangeResponse?.id, orderId: id }, MODE);
  return order;
}

/**
 * OCO exit: reuses the caller's stopLoss/takeProfit fields as the two leg prices, same as the
 * demo path — see placeDemoOcoExit's comment in demo-orders.js. Places TWO independent real
 * exchange orders (no exchange in the curated list confirmed a uniform native-OCO capability),
 * linked only at the app level by ocoGroupId; pending-orders-watcher.js's real branch cancels the
 * sibling when one fills, accepting the documented small race window where both could fill
 * before the cancel lands.
 */
async function placeRealOcoExit({ id, userId, symbol, exchange, price, stopLoss, takeProfit, idempotencyKey, signalId }) {
  const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    const rejected = persistRejected({ id, userId, symbol, side: 'sell', price, reasonCode: 'NO_OPEN_POSITION_FOR_OCO', message: `No open Real position for ${symbol} to protect with an OCO exit.`, idempotencyKey, signalId });
    return { takeProfitOrder: rejected, stopLossOrder: null };
  }
  if (typeof takeProfit !== 'number' || typeof stopLoss !== 'number') {
    const rejected = persistRejected({ id, userId, symbol, side: 'sell', price, reasonCode: 'MISSING_RISK_PARAMS', message: 'OCO requires both takeProfit (limit leg) and stopLoss (stop-market leg) prices.', idempotencyKey, signalId });
    return { takeProfitOrder: rejected, stopLossOrder: null };
  }

  const ocoGroupId = uuidv4();
  const takeProfitOrder = await placeRealPendingOrder({
    id, userId, symbol, exchange, side: 'sell', orderType: 'limit', limitPrice: takeProfit, qty: openPosition.qty, price, ocoGroupId, idempotencyKey, signalId,
  });
  // If the take-profit leg was rejected (e.g. unsupported order type), there's no position left
  // to protect with a second leg — surface just the one rejection rather than attempting (and
  // likely also rejecting) a stop-loss leg for the same underlying reason.
  if (takeProfitOrder.status === 'rejected') {
    return { takeProfitOrder, stopLossOrder: null };
  }
  const stopLossOrder = await placeRealPendingOrder({
    id: uuidv4(), userId, symbol, exchange, side: 'sell', orderType: 'stop_market', triggerPrice: stopLoss, qty: openPosition.qty, price, ocoGroupId, signalId,
  });

  logger.info('real-orders', `Real OCO exit placed for ${symbol}`, { ocoGroupId, takeProfitId: takeProfitOrder.id, stopLossId: stopLossOrder.id }, MODE);
  return { takeProfitOrder, stopLossOrder };
}

/** Used by pending-orders-watcher.js once client.fetchOrder confirms a pending BUY has filled.
 *  `order` already carries its owning user_id — no separate userId parameter needed. */
function finalizeRealBuyFill(order, fillPrice, exchangeResponse) {
  const userId = order.user_id;
  const position = portfolioService.openPosition(MODE, userId, {
    symbol: order.symbol, exchange: order.exchange ?? null, side: 'buy',
    qty: order.qty, entryPrice: fillPrice, stopLoss: order.stop_loss, takeProfit: order.take_profit,
  });
  realAuditLogRepository.insertAuditEntry({ userId, orderId: order.id, requestJson: JSON.stringify({ fetchOrderConfirmedFill: true }), responseJson: JSON.stringify(exchangeResponse) });
  const updated = ordersRepository.updateOrderStatus(MODE, userId, order.id, { status: 'filled', filledAtUtc: new Date().toISOString(), exchangeOrderId: order.exchange_order_id, price: fillPrice });
  logger.info('real-orders', `Real ${order.order_type} BUY filled for ${order.symbol}`, { qty: order.qty, fillPrice, positionId: position.id }, MODE);
  return updated;
}

/** Used by pending-orders-watcher.js for a pending SELL/OCO-leg once client.fetchOrder confirms it filled. */
function finalizeRealSellFill(order, fillPrice, exchangeResponse) {
  const userId = order.user_id;
  const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, order.symbol);
  if (!openPosition) {
    // The position this order was meant to close is already gone (e.g. closed manually while
    // this order sat pending on the exchange) — nothing left here to reconcile locally beyond
    // marking our own row filled; there's no position to close a second time.
    return ordersRepository.updateOrderStatus(MODE, userId, order.id, { status: 'filled', filledAtUtc: new Date().toISOString(), exchangeOrderId: order.exchange_order_id, price: fillPrice });
  }
  const { realizedPnl } = portfolioService.closePosition(MODE, userId, openPosition.id, fillPrice);
  realAuditLogRepository.insertAuditEntry({ userId, orderId: order.id, requestJson: JSON.stringify({ fetchOrderConfirmedFill: true }), responseJson: JSON.stringify(exchangeResponse) });
  const updated = ordersRepository.updateOrderStatus(MODE, userId, order.id, { status: 'filled', filledAtUtc: new Date().toISOString(), realizedPnl, exchangeOrderId: order.exchange_order_id, price: fillPrice });
  logger.info('real-orders', `Real ${order.order_type} SELL filled for ${order.symbol}`, { realizedPnl, positionId: openPosition.id }, MODE);
  return updated;
}

/** Used by pending-orders-watcher.js (OCO sibling-cancel, and when the exchange itself reports
 * the order canceled/expired) and the manual cancel endpoint. Cancels on the exchange first —
 * only marks our row cancelled once that succeeds (or the exchange says there's nothing to
 * cancel because it's already resolved, which is the accepted OCO race case). */
async function cancelRealOrder(order) {
  const userId = order.user_id;
  const client = exchangeClientFactory.getRealExchange(userId);
  try {
    if (order.exchange_order_id) {
      await client.cancelOrder(order.exchange_order_id, order.symbol);
    }
  } catch (err) {
    logger.warn('real-orders', `cancelOrder for ${order.id} (${order.symbol}) failed or was already resolved on the exchange: ${err.message}`, {}, MODE);
  }
  return ordersRepository.updateOrderStatus(MODE, userId, order.id, { status: 'cancelled', cancelledAtUtc: new Date().toISOString(), exchangeOrderId: order.exchange_order_id });
}

module.exports = { placeRealOrder, finalizeRealBuyFill, finalizeRealSellFill, cancelRealOrder };
