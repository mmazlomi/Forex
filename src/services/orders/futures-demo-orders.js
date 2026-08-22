'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../../../config/config');
const marketDataService = require('../market-data/market-data-service');
const futuresPortfolioService = require('../portfolio/futures-portfolio-service');
const futuresRiskSettingsRepository = require('../../database/repositories/futures-risk-settings-repository');
const emergencyStopRepository = require('../../database/repositories/emergency-stop-repository');
const futuresOrdersRepository = require('../../database/repositories/futures-orders-repository');
const futuresPositionsRepository = require('../../database/repositories/futures-positions-repository');
const logger = require('../logging/logger');
const { validateTrade } = require('../risk/validate-trade');
const { estimateLiquidationPrice, isStopLossSafeFromLiquidation } = require('./liquidation-estimate');

const MODE = 'demo';
const DUPLICATE_WINDOW_MS = 5000;
const MAX_DATA_AGE_MS = 5 * 60 * 1000;
// See demo-orders.js's identical constant/comment — same dust-fraction fallback-to-full-close rule.
const DUST_QTY_FRACTION = 0.01;

function defaultRiskSettings(userId) {
  return futuresRiskSettingsRepository.ensureDefaults(userId, MODE, {
    maxRiskPerTradePercent: config.maxRiskPerTradePercent,
    maxDailyLossPercent: config.maxDailyLossPercent,
    maxOpenPositions: config.maxOpenPositions,
    maxOrderValue: config.maxOrderValue,
    minRiskRewardRatio: config.minRiskRewardRatio,
    maxPortfolioExposurePercent: 50,
    maxLeverage: 10,
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

function persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode, message, idempotencyKey, signalId, source }) {
  return futuresOrdersRepository.insertOrder(MODE, userId, {
    id,
    symbol,
    exchange: exchange || 'kucoin',
    action,
    leverage: leverage ?? 1,
    qty: 0,
    price: price ?? 0,
    stopLoss: stopLoss ?? null,
    takeProfit: takeProfit ?? null,
    status: 'rejected',
    rejectReason: `${reasonCode}: ${message}`,
    idempotencyKey: idempotencyKey ?? null,
    createdAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
    source: source ?? 'manual',
  });
}

/**
 * Places a simulated Demo futures order for this user. Mirrors demo-orders.js's structure but with
 * genuinely different semantics: `action` (open_long/open_short/close) replaces spot's `side`,
 * since a plain buy/sell is ambiguous once both long and short exist. Never calls any exchange
 * endpoint — purely local simulation against a live public-market reference price, same as spot Demo.
 *
 * Market orders only, full-quantity close only — see docs/architecture.md Phase 2. Partial closes
 * (adaptive-TP tiers) go through the sibling placeDemoFuturesPartialClose below instead, since a
 * plain action/qty pair here can't express "close this specific tier."
 */
async function placeDemoFuturesOrder({ userId, symbol, exchange = 'kucoin', action, leverage, stopLoss, takeProfit, qty, idempotencyKey, signalId, source = 'manual', strategyId, timeframe, trailingPercent, reason, adaptiveTp }) {
  const id = uuidv4();
  action = String(action || '').toLowerCase();

  if (!['open_long', 'open_short', 'close'].includes(action)) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'INVALID_ACTION', message: `Unknown action "${action}".`, idempotencyKey, signalId, source });
  }

  if (idempotencyKey) {
    const existing = futuresOrdersRepository.findByIdempotencyKey(MODE, userId, idempotencyKey);
    if (existing) return existing;
  }

  const snapshot = await marketDataService.getFuturesSnapshot({ symbol, exchange });
  if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'INVALID_PRICE', message: snapshot.error || 'Market price unavailable', idempotencyKey, signalId, source });
  }
  const price = snapshot.price;

  if (emergencyStopRepository.isActive(MODE, userId)) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'EMERGENCY_STOP_ACTIVE', message: 'Demo futures trading is halted by an active emergency stop.', idempotencyKey, signalId, source });
  }

  const isDuplicate = !!futuresOrdersRepository.findRecentSimilarOrder(MODE, userId, { symbol, action, price, windowMs: DUPLICATE_WINDOW_MS });
  if (isDuplicate) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'DUPLICATE_ORDER', message: 'An equivalent order was just submitted.', idempotencyKey, signalId, source });
  }

  if (action === 'close') {
    return closeDemoFuturesPosition({ id, userId, symbol, exchange, price, idempotencyKey, signalId, source, reason });
  }

  // open_long / open_short
  if (typeof stopLoss !== 'number' || typeof takeProfit !== 'number') {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'MISSING_RISK_PARAMS', message: 'stopLoss and takeProfit are required to open a futures position.', idempotencyKey, signalId, source });
  }
  if (typeof leverage !== 'number' || leverage < 1) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'INVALID_LEVERAGE', message: 'leverage must be a number >= 1.', idempotencyKey, signalId, source });
  }

  const riskSettingsRow = defaultRiskSettings(userId);
  if (leverage > riskSettingsRow.max_leverage) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'LEVERAGE_TOO_HIGH', message: `Leverage ${leverage}x exceeds the configured maximum of ${riskSettingsRow.max_leverage}x.`, idempotencyKey, signalId, source });
  }

  const existingPosition = futuresPositionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (existingPosition) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'POSITION_ALREADY_OPEN', message: `An open ${existingPosition.side} position already exists for ${symbol} (one-way mode: one net position per symbol).`, idempotencyKey, signalId, source });
  }

  const side = action === 'open_long' ? 'long' : 'short';
  const liquidationPrice = estimateLiquidationPrice({ entryPrice: price, leverage, side });
  if (!isStopLossSafeFromLiquidation({ side, stopLoss, liquidationPrice })) {
    return persistRejected({
      id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price,
      reasonCode: 'STOP_LOSS_BEYOND_LIQUIDATION',
      message: `Stop-loss ${stopLoss} would never trigger — liquidation (est. ${liquidationPrice.toFixed(2)}) happens first at ${leverage}x leverage. Use a tighter stop or lower leverage.`,
      idempotencyKey, signalId, source,
    });
  }

  const riskSettings = toRiskSettingsShape(riskSettingsRow);
  const portfolio = futuresPortfolioService.getSnapshot(MODE, userId);

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
    marginUsed: portfolio.marginUsed,
    isDuplicate: false, // already checked above
    qtyOverride: qty,
    leverage,
  });

  if (!validation.accepted) {
    logger.warn('futures-demo-orders', `Demo futures ${action} rejected for ${symbol}: ${validation.reasonCode}`, { message: validation.message }, MODE);
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: validation.reasonCode, message: validation.message, idempotencyKey, signalId, source });
  }

  const position = futuresPortfolioService.openPosition(MODE, userId, {
    symbol, exchange, side, leverage, qty: validation.positionSize, entryPrice: price, stopLoss, takeProfit, liquidationPrice, signalId, source, strategyId, timeframe, trailingPercent, adaptiveTp,
  });

  const order = futuresOrdersRepository.insertOrder(MODE, userId, {
    id, symbol, exchange, action, leverage, qty: validation.positionSize, price, stopLoss, takeProfit,
    status: 'filled', rejectReason: null, idempotencyKey: idempotencyKey ?? null,
    createdAtUtc: new Date().toISOString(), filledAtUtc: new Date().toISOString(), signalId: signalId ?? null, source,
  });

  logger.info('futures-demo-orders', `Demo futures ${action} filled for ${symbol}`, { qty: validation.positionSize, leverage, price, liquidationPrice, positionId: position.id }, MODE);
  return order;
}

function closeDemoFuturesPosition({ id, userId, symbol, exchange, price, idempotencyKey, signalId, source, reason }) {
  const openPosition = futuresPositionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    return persistRejected({ id, userId, symbol, exchange, action: 'close', price, reasonCode: 'NO_OPEN_POSITION_TO_CLOSE', message: `No open Demo futures position for ${symbol}.`, idempotencyKey, signalId, source });
  }

  const { realizedPnl } = futuresPortfolioService.closePosition(MODE, userId, openPosition.id, price, reason ?? 'manual');
  const closingAction = 'close';

  const order = futuresOrdersRepository.insertOrder(MODE, userId, {
    id, symbol, exchange: openPosition.exchange, action: closingAction, leverage: openPosition.leverage,
    qty: openPosition.qty, price, stopLoss: null, takeProfit: null, status: 'filled', rejectReason: null,
    idempotencyKey: idempotencyKey ?? null, createdAtUtc: new Date().toISOString(), filledAtUtc: new Date().toISOString(),
    signalId: signalId ?? null, realizedPnl, source: source ?? 'manual',
  });

  logger.info('futures-demo-orders', `Demo futures close for ${symbol}`, { realizedPnl, positionId: openPosition.id }, MODE);
  return order;
}

/** Futures twin of demo-orders.js#placeDemoPartialClose — see that function's doc comment for the
 *  full contract. `action` on the persisted order row is still 'close' (partial isn't a distinct
 *  DB enum value — same as the futures side never having had a "partial" concept before this). */
async function placeDemoFuturesPartialClose({ userId, symbol, exchange, level, closeQty, reason }) {
  const id = uuidv4();
  const openPosition = futuresPositionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    return persistRejected({ id, userId, symbol, exchange, action: 'close', reasonCode: 'NO_OPEN_POSITION_TO_CLOSE', message: `No open Demo futures position for ${symbol} to partially close.` });
  }
  if (!openPosition.adaptive_tp_enabled) {
    return persistRejected({ id, userId, symbol, exchange, action: 'close', reasonCode: 'ADAPTIVE_TP_NOT_ENABLED', message: `Position ${openPosition.id} for ${symbol} is not adaptive-TP enabled.` });
  }
  if (openPosition[`tp${level}_filled_at_utc`]) {
    return persistRejected({ id, userId, symbol, exchange, action: 'close', reasonCode: 'TP_TIER_ALREADY_FILLED', message: `TP${level} for ${symbol} is already filled — refusing a duplicate partial close.` });
  }

  const snapshot = await marketDataService.getFuturesSnapshot({ symbol, exchange: exchange || openPosition.exchange });
  if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
    return persistRejected({ id, userId, symbol, exchange, action: 'close', reasonCode: 'INVALID_PRICE', message: snapshot.error || 'Market price unavailable' });
  }
  const price = snapshot.price;

  const dustQty = (openPosition.initial_qty ?? openPosition.qty) * DUST_QTY_FRACTION;
  if (closeQty >= openPosition.qty || openPosition.qty - closeQty <= dustQty) {
    return closeDemoFuturesPosition({ id, userId, symbol, exchange, price, reason: reason ?? 'take_profit' });
  }

  const { pnl } = futuresPortfolioService.partialClosePosition(MODE, userId, openPosition.id, { level, qty: closeQty, exitPrice: price });

  const order = futuresOrdersRepository.insertOrder(MODE, userId, {
    id, symbol, exchange: openPosition.exchange, action: 'close', leverage: openPosition.leverage,
    qty: closeQty, price, stopLoss: null, takeProfit: null, status: 'filled', rejectReason: null,
    idempotencyKey: null, createdAtUtc: new Date().toISOString(), filledAtUtc: new Date().toISOString(),
    realizedPnl: pnl,
  });

  logger.info('futures-demo-orders', `Demo futures partial close (TP${level}) filled for ${symbol}`, { qty: closeQty, price, pnl, positionId: openPosition.id }, MODE);
  return order;
}

module.exports = { placeDemoFuturesOrder, placeDemoFuturesPartialClose };
