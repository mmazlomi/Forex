'use strict';

const assetsRepository = require('../database/repositories/assets-repository');
const exchangeClientFactory = require('../services/exchanges/exchange-client-factory');
const { withRetry } = require('../utils/retry');
const config = require('../../config/config');
const { getStrategy } = require('../services/signals/strategies');
const { SUPPORTED_TIMEFRAMES } = require('../services/market-data/market-data-service');
const { sendSuccess, sendError } = require('../utils/http-response');

async function listAssets(req, res) {
  sendSuccess(res, assetsRepository.listAssets(req.user.id));
}

async function addAsset(req, res) {
  const { symbol, exchange, market, assetType, defaultTimeframe, strategyId } = req.body || {};
  if (!symbol || !exchange || !assetType) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol, exchange, and assetType are required.');
  }
  if (!['crypto', 'stock'].includes(assetType)) {
    return sendError(res, 'VALIDATION_ERROR', 'assetType must be "crypto" or "stock".');
  }

  // ccxt only covers crypto exchanges — ccxt.loadMarkets() validation only applies to
  // crypto assets. Stock symbols/exchanges (e.g. "AAPL" on "NASDAQ") aren't validatable
  // this way; stock fundamentals still work via Finnhub, but market-data/candles/signals
  // for stocks aren't supported yet (see docs/technical-documentation.md limitations).
  if (assetType === 'crypto') {
    const client = exchangeClientFactory.getPublicExchange(exchange);
    await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });
    if (!client.markets[symbol]) {
      return sendError(res, 'VALIDATION_ERROR', `Symbol "${symbol}" was not found on exchange "${exchange}".`);
    }
  }

  if (assetsRepository.getAsset(req.user.id, symbol, exchange)) {
    return sendError(res, 'VALIDATION_ERROR', `Asset "${symbol}" on "${exchange}" is already on your watchlist.`, 409);
  }

  // getStrategy() falls back to the default for an unknown id, so this always resolves to a
  // real strategy id rather than storing something invalid.
  const resolvedStrategyId = getStrategy(strategyId).id;
  const asset = assetsRepository.addAsset(req.user.id, { symbol, exchange, market, assetType, defaultTimeframe, strategyId: resolvedStrategyId });
  sendSuccess(res, asset, 'Asset added.', 201);
}

async function removeAsset(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  const removed = assetsRepository.removeAsset(req.user.id, symbol, exchange);
  if (!removed) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  sendSuccess(res, null, 'Asset removed.');
}

async function setAutoTrade(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { enabled } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (typeof enabled !== 'boolean') {
    return sendError(res, 'VALIDATION_ERROR', 'enabled (boolean) is required in the request body.');
  }
  const asset = assetsRepository.setAutoTrade(req.user.id, symbol, exchange, enabled);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  sendSuccess(res, asset, `AI auto-trading ${enabled ? 'enabled' : 'disabled'} for ${symbol}.`);
}

async function setStrategy(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { strategyId } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (!strategyId) {
    return sendError(res, 'VALIDATION_ERROR', 'strategyId is required in the request body.');
  }
  const resolvedStrategyId = getStrategy(strategyId).id;
  const asset = assetsRepository.setStrategy(req.user.id, symbol, exchange, resolvedStrategyId);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  sendSuccess(res, asset, `Strategy set to "${resolvedStrategyId}" for ${symbol}.`);
}

// Changing this affects AI Auto-Trade too, not just manual "Load"/Generate Signal defaults — see
// assets-repository.js#setTimeframe's comment.
async function setTimeframe(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { defaultTimeframe } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (!SUPPORTED_TIMEFRAMES.includes(defaultTimeframe)) {
    return sendError(res, 'VALIDATION_ERROR', `defaultTimeframe must be one of: ${SUPPORTED_TIMEFRAMES.join(', ')}.`);
  }
  const asset = assetsRepository.setTimeframe(req.user.id, symbol, exchange, defaultTimeframe);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  sendSuccess(res, asset, `Timeframe set to "${defaultTimeframe}" for ${symbol}.`);
}

// Moves a watchlist entry to a different exchange without removing/re-adding it — same crypto
// market validation as addAsset (a symbol valid on one exchange isn't guaranteed valid on
// another) plus a check that the destination (symbol, newExchange) pair isn't already on the
// watchlist, since UNIQUE(user_id, symbol, exchange) would otherwise reject the UPDATE.
async function setExchange(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { newExchange } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (!newExchange) {
    return sendError(res, 'VALIDATION_ERROR', 'newExchange is required in the request body.');
  }
  if (newExchange === exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'newExchange must differ from the current exchange.');
  }

  const asset = assetsRepository.getAsset(req.user.id, symbol, exchange);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  if (assetsRepository.getAsset(req.user.id, symbol, newExchange)) {
    return sendError(res, 'VALIDATION_ERROR', `Asset "${symbol}" on "${newExchange}" is already on your watchlist.`, 409);
  }

  if (asset.asset_type === 'crypto') {
    const client = exchangeClientFactory.getPublicExchange(newExchange);
    await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });
    if (!client.markets[symbol]) {
      return sendError(res, 'VALIDATION_ERROR', `Symbol "${symbol}" was not found on exchange "${newExchange}".`);
    }
  }

  const updated = assetsRepository.setExchange(req.user.id, symbol, exchange, newExchange);
  sendSuccess(res, updated, `Exchange changed to "${newExchange}" for ${symbol}.`);
}

const STRATEGY_MODES = ['manual', 'auto'];

// 'auto' opts this asset into strategy-selector.js's periodic winrate-based backtesting — see
// assets-repository.js#setStrategyMode's comment. Switching modes never clears a prior
// selected_strategy_ids_json; it's simply ignored while in 'manual' mode.
async function setStrategyMode(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { mode } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (!STRATEGY_MODES.includes(mode)) {
    return sendError(res, 'VALIDATION_ERROR', `mode must be one of: ${STRATEGY_MODES.join(', ')}.`);
  }
  const asset = assetsRepository.setStrategyMode(req.user.id, symbol, exchange, mode);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  sendSuccess(res, asset, `Strategy mode set to "${mode}" for ${symbol}.`);
}

module.exports = { listAssets, addAsset, removeAsset, setAutoTrade, setStrategy, setTimeframe, setExchange, setStrategyMode };
