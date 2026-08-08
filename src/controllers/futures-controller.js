'use strict';

const futuresAssetsRepository = require('../database/repositories/futures-assets-repository');
const futuresOrdersRepository = require('../database/repositories/futures-orders-repository');
const futuresRiskSettingsRepository = require('../database/repositories/futures-risk-settings-repository');
const futuresPortfolioService = require('../services/portfolio/futures-portfolio-service');
const { placeDemoFuturesOrder } = require('../services/orders/futures-demo-orders');
const { placeRealFuturesOrder } = require('../services/orders/futures-real-orders');
const { getFuturesSymbolsForExchange } = require('../services/market-data/symbol-list-service');
const { getStrategy } = require('../services/signals/strategies');
const { SUPPORTED_TIMEFRAMES } = require('../services/market-data/market-data-service');
const config = require('../../config/config');
const logger = require('../services/logging/logger');
const { sendSuccess, sendError, sendRejection } = require('../utils/http-response');

const REQUIRED_CONFIRMATION_TEXT = 'CONFIRM';

async function listSymbols(req, res) {
  const exchange = (req.query.exchange || 'kucoin').toLowerCase();
  if (exchange !== 'kucoin') {
    return sendError(res, 'VALIDATION_ERROR', 'Futures trading is only supported on KuCoin in this app.');
  }
  const symbols = await getFuturesSymbolsForExchange(exchange);
  sendSuccess(res, symbols);
}

async function getPortfolio(req, res) {
  const mode = req.tradingMode;
  const userId = req.user.id;
  const snapshot = futuresPortfolioService.getSnapshot(mode, userId);
  const pnl = futuresPortfolioService.getPnlSummary(mode, userId);
  const openPositions = await futuresPortfolioService.getOpenPositionsWithUnrealizedPnl(mode, userId);
  const unrealizedPnl = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

  sendSuccess(res, {
    ...snapshot,
    openPositions,
    pnl: { ...pnl, unrealizedPnl, netPnl: pnl.totalRealizedPnl + unrealizedPnl },
  });
}

async function listOrders(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const { status } = req.query;
  sendSuccess(res, futuresOrdersRepository.listOrders(req.tradingMode, req.user.id, { limit, offset, status }));
}

function validateOrderBody(body) {
  const { symbol, action } = body || {};
  if (!symbol || !['open_long', 'open_short', 'close'].includes(action)) {
    return 'symbol and action ("open_long", "open_short", or "close") are required.';
  }
  return null;
}

async function postDemoOrder(req, res) {
  const validationError = validateOrderBody(req.body);
  if (validationError) return sendError(res, 'VALIDATION_ERROR', validationError);

  const { symbol, exchange, action, leverage, stopLoss, takeProfit, qty, idempotencyKey, signalId } = req.body;
  const order = await placeDemoFuturesOrder({ userId: req.user.id, symbol, exchange, action, leverage, stopLoss, takeProfit, qty, idempotencyKey, signalId });
  if (order.status === 'rejected') return sendRejection(res, order);
  sendSuccess(res, order, `Demo futures ${action} filled.`, 201);
}

async function postRealOrder(req, res) {
  const validationError = validateOrderBody(req.body);
  if (validationError) return sendError(res, 'VALIDATION_ERROR', validationError);

  const { symbol, exchange, action, leverage, stopLoss, takeProfit, qty, idempotencyKey, signalId, confirmationText } = req.body;
  const unlockConfirmed = confirmationText === REQUIRED_CONFIRMATION_TEXT;

  const order = await placeRealFuturesOrder({ userId: req.user.id, symbol, exchange, action, leverage, stopLoss, takeProfit, qty, idempotencyKey, signalId, unlockConfirmed });
  if (order.status === 'rejected') return sendRejection(res, order);
  sendSuccess(res, order, `Real futures ${action} filled.`, 201);
}

// Fully independent Demo/Real watchlists — every function below takes its mode from
// req.tradingMode (set by requireValidMode from ?mode=demo|real) and reads/writes the
// corresponding demo_futures_assets/real_futures_assets table. A symbol on the Demo list and the
// "same" symbol on the Real list are entirely separate rows; adding/removing/toggling one never
// touches the other. Real-list auto-trade still only actually places trades if the server-wide
// ENABLE_FUTURES_AUTO_TRADING env flag is also set — see futures-auto-trader.js.
async function listAssets(req, res) {
  sendSuccess(res, futuresAssetsRepository.listAssets(req.tradingMode, req.user.id));
}

async function addAsset(req, res) {
  const { symbol, exchange = 'kucoin', leverage, strategyId, defaultTimeframe } = req.body || {};
  if (!symbol) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol is required.');
  }
  if (exchange.toLowerCase() !== 'kucoin') {
    return sendError(res, 'VALIDATION_ERROR', 'Futures trading is only supported on KuCoin in this app.');
  }
  if (futuresAssetsRepository.getAsset(req.tradingMode, req.user.id, symbol, exchange)) {
    return sendError(res, 'VALIDATION_ERROR', `Futures asset "${symbol}" is already on your ${req.tradingMode} watchlist.`, 409);
  }
  const resolvedStrategyId = getStrategy(strategyId).id;
  const asset = futuresAssetsRepository.addAsset(req.tradingMode, req.user.id, { symbol, exchange, leverage, strategyId: resolvedStrategyId, defaultTimeframe });
  sendSuccess(res, asset, `Futures asset added to your ${req.tradingMode} watchlist.`, 201);
}

async function removeAsset(req, res) {
  const { symbol } = req.params;
  const exchange = req.query.exchange || 'kucoin';
  const removed = futuresAssetsRepository.removeAsset(req.tradingMode, req.user.id, symbol, exchange);
  if (!removed) {
    return sendError(res, 'ASSET_NOT_FOUND', `No futures asset "${symbol}" was found on your ${req.tradingMode} watchlist.`, 404);
  }
  sendSuccess(res, null, 'Futures asset removed.');
}

async function setAutoTrade(req, res) {
  const { symbol } = req.params;
  const exchange = req.query.exchange || 'kucoin';
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return sendError(res, 'VALIDATION_ERROR', 'enabled (boolean) is required in the request body.');
  }
  const asset = futuresAssetsRepository.setAutoTrade(req.tradingMode, req.user.id, symbol, exchange, enabled);
  if (!asset) return sendError(res, 'ASSET_NOT_FOUND', `No futures asset "${symbol}" was found on your ${req.tradingMode} watchlist.`, 404);
  const note = req.tradingMode === 'real' && enabled && !config.enableFuturesAutoTrading
    ? ' (Note: the server has not enabled ENABLE_FUTURES_AUTO_TRADING, so this will not actually place real trades yet.)'
    : '';
  sendSuccess(res, asset, `${req.tradingMode === 'real' ? 'Real' : 'Demo'} futures AI auto-trading ${enabled ? 'enabled' : 'disabled'} for ${symbol}.${note}`);
}

async function setLeverage(req, res) {
  const { symbol } = req.params;
  const exchange = req.query.exchange || 'kucoin';
  const { leverage } = req.body || {};
  if (typeof leverage !== 'number' || leverage < 1) {
    return sendError(res, 'VALIDATION_ERROR', 'leverage (number >= 1) is required in the request body.');
  }
  const asset = futuresAssetsRepository.setLeverage(req.tradingMode, req.user.id, symbol, exchange, leverage);
  if (!asset) return sendError(res, 'ASSET_NOT_FOUND', `No futures asset "${symbol}" was found on your ${req.tradingMode} watchlist.`, 404);
  sendSuccess(res, asset, `Leverage set to ${leverage}x for ${symbol}.`);
}

async function setStrategy(req, res) {
  const { symbol } = req.params;
  const exchange = req.query.exchange || 'kucoin';
  const { strategyId } = req.body || {};
  if (!strategyId) return sendError(res, 'VALIDATION_ERROR', 'strategyId is required in the request body.');
  const resolvedStrategyId = getStrategy(strategyId).id;
  const asset = futuresAssetsRepository.setStrategy(req.tradingMode, req.user.id, symbol, exchange, resolvedStrategyId);
  if (!asset) return sendError(res, 'ASSET_NOT_FOUND', `No futures asset "${symbol}" was found on your ${req.tradingMode} watchlist.`, 404);
  sendSuccess(res, asset, `Strategy set to "${resolvedStrategyId}" for ${symbol}.`);
}

// Changing this affects AI Auto-Trade too — futures-auto-trader.js's generateSignal() call uses
// each asset's own default_timeframe, not just manual order-form defaults.
async function setTimeframe(req, res) {
  const { symbol } = req.params;
  const exchange = req.query.exchange || 'kucoin';
  const { defaultTimeframe } = req.body || {};
  if (!SUPPORTED_TIMEFRAMES.includes(defaultTimeframe)) {
    return sendError(res, 'VALIDATION_ERROR', `defaultTimeframe must be one of: ${SUPPORTED_TIMEFRAMES.join(', ')}.`);
  }
  const asset = futuresAssetsRepository.setTimeframe(req.tradingMode, req.user.id, symbol, exchange, defaultTimeframe);
  if (!asset) return sendError(res, 'ASSET_NOT_FOUND', `No futures asset "${symbol}" was found on your ${req.tradingMode} watchlist.`, 404);
  sendSuccess(res, asset, `Timeframe set to "${defaultTimeframe}" for ${symbol}.`);
}

const STRATEGY_MODES = ['manual', 'auto'];

// Same effect as assets-controller.js's setStrategyMode() — see its comment. Demo and Real opt
// into 'auto' mode independently, exactly like every other per-asset setting on these fully
// separate watchlists.
async function setStrategyMode(req, res) {
  const { symbol } = req.params;
  const exchange = req.query.exchange || 'kucoin';
  const { mode } = req.body || {};
  if (!STRATEGY_MODES.includes(mode)) {
    return sendError(res, 'VALIDATION_ERROR', `mode must be one of: ${STRATEGY_MODES.join(', ')}.`);
  }
  const asset = futuresAssetsRepository.setStrategyMode(req.tradingMode, req.user.id, symbol, exchange, mode);
  if (!asset) return sendError(res, 'ASSET_NOT_FOUND', `No futures asset "${symbol}" was found on your ${req.tradingMode} watchlist.`, 404);
  sendSuccess(res, asset, `Strategy mode set to "${mode}" for ${symbol}.`);
}

function defaultsFor() {
  return {
    maxRiskPerTradePercent: config.maxRiskPerTradePercent,
    maxDailyLossPercent: config.maxDailyLossPercent,
    maxOpenPositions: config.maxOpenPositions,
    maxOrderValue: config.maxOrderValue,
    minRiskRewardRatio: config.minRiskRewardRatio,
    maxPortfolioExposurePercent: 50,
    maxLeverage: 10,
  };
}

async function getRiskSettings(req, res) {
  const settings = futuresRiskSettingsRepository.ensureDefaults(req.user.id, req.tradingMode, defaultsFor());
  sendSuccess(res, settings);
}

const BOUNDS = {
  maxRiskPerTradePercent: [0.01, 10],
  maxDailyLossPercent: [0.1, 25],
  maxOpenPositions: [1, 50],
  maxOrderValue: [1, 10_000_000],
  minRiskRewardRatio: [0.1, 20],
  maxPortfolioExposurePercent: [1, 100],
  maxLeverage: [1, 125], // 125x is KuCoin's own published ceiling on some pairs; the app-level default (10) is far more conservative
};

async function putRiskSettings(req, res) {
  const updates = {};
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (req.body[key] === undefined) continue;
    const value = Number(req.body[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return sendError(res, 'VALIDATION_ERROR', `${key} must be a number between ${min} and ${max}.`);
    }
    updates[key] = value;
  }

  const existing = futuresRiskSettingsRepository.ensureDefaults(req.user.id, req.tradingMode, defaultsFor());
  const merged = {
    maxRiskPerTradePercent: existing.max_risk_per_trade_percent,
    maxDailyLossPercent: existing.max_daily_loss_percent,
    maxOpenPositions: existing.max_open_positions,
    maxOrderValue: existing.max_order_value,
    minRiskRewardRatio: existing.min_risk_reward_ratio,
    maxPortfolioExposurePercent: existing.max_portfolio_exposure_percent,
    maxLeverage: existing.max_leverage,
    ...updates,
  };

  const updated = futuresRiskSettingsRepository.upsertRiskSettings(req.user.id, req.tradingMode, merged);
  logger.info('futures-risk-settings', `Futures risk settings updated for mode "${req.tradingMode}"`, updates, req.tradingMode);
  sendSuccess(res, updated, 'Futures risk settings updated.');
}

module.exports = {
  listSymbols, getPortfolio, listOrders, postDemoOrder, postRealOrder,
  listAssets, addAsset, removeAsset, setAutoTrade, setLeverage, setStrategy, setTimeframe, setStrategyMode,
  getRiskSettings, putRiskSettings,
};
