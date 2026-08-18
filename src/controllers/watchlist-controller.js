'use strict';

const watchlistRepository = require('../database/repositories/watchlist-repository');
const assetsRepository = require('../database/repositories/assets-repository');
const futuresAssetsRepository = require('../database/repositories/futures-assets-repository');
const exchangeClientFactory = require('../services/exchanges/exchange-client-factory');
const { withRetry } = require('../utils/retry');
const config = require('../../config/config');
const { DEFAULT_STRATEGY_ID } = require('../services/signals/strategies');
const { sendSuccess, sendError } = require('../utils/http-response');

async function listWatchlist(req, res) {
  sendSuccess(res, watchlistRepository.listItems(req.user.id));
}

async function addToWatchlist(req, res) {
  const { symbol, exchange, assetType } = req.body || {};
  if (!symbol || !exchange || !assetType) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol, exchange, and assetType are required.');
  }
  if (!['crypto', 'stock'].includes(assetType)) {
    return sendError(res, 'VALIDATION_ERROR', 'assetType must be "crypto" or "stock".');
  }

  // Same validation as assets-controller.js#addAsset — stock symbols aren't ccxt-checkable.
  if (assetType === 'crypto') {
    const client = exchangeClientFactory.getPublicExchange(exchange);
    await withRetry(() => client.loadMarkets(), { maxRetries: config.maxApiRetries });
    if (!client.markets[symbol]) {
      return sendError(res, 'VALIDATION_ERROR', `Symbol "${symbol}" was not found on exchange "${exchange}".`);
    }
  }

  if (watchlistRepository.getItem(req.user.id, symbol, exchange)) {
    return sendError(res, 'VALIDATION_ERROR', `"${symbol}" on "${exchange}" is already on your WatchList.`, 409);
  }

  const item = watchlistRepository.addItem(req.user.id, { symbol, exchange, assetType });
  sendSuccess(res, item, 'Added to WatchList.', 201);
}

async function removeFromWatchlist(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  const removed = watchlistRepository.removeItem(req.user.id, symbol, exchange);
  if (!removed) {
    return sendError(res, 'ASSET_NOT_FOUND', `No WatchList entry "${symbol}" on "${exchange}" was found.`, 404);
  }
  sendSuccess(res, null, 'Removed from WatchList.');
}

// BASE/QUOTE (spot) -> BASE/QUOTE:QUOTE (ccxt's unified USDT-margined perpetual swap format —
// see futures-controller.js's symbol field and index.html's futures symbol picker placeholder).
function toFuturesSymbol(spotSymbol) {
  const quote = spotSymbol.split('/')[1];
  return quote ? `${spotSymbol}:${quote}` : null;
}

const DEFAULT_TIMEFRAME = '1h';
const DEFAULT_LEVERAGE = 3;

/**
 * One-click promotion from the lightweight WatchList into the actual trading-configured lists —
 * Spot Signals Setting (`assets`) plus both Demo and Real Futures Signals Setting, each with
 * sensible defaults (1h timeframe, the default strategy, 3x leverage) the user can change
 * afterward from the Signals Setting tab. Each destination is attempted independently and
 * "already there"/unsupported-exchange outcomes are reported, not treated as failures — a partial
 * promotion (e.g. spot succeeds, futures skipped for a futures-unsupported exchange) is normal.
 */
async function promoteToSignalsSetting(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  const item = watchlistRepository.getItem(req.user.id, symbol, exchange);
  if (!item) {
    return sendError(res, 'ASSET_NOT_FOUND', `No WatchList entry "${symbol}" on "${exchange}" was found.`, 404);
  }

  const results = {};

  if (assetsRepository.getAsset(req.user.id, symbol, exchange)) {
    results.spot = 'already in Spot Signals Setting';
  } else {
    assetsRepository.addAsset(req.user.id, {
      symbol, exchange, assetType: item.asset_type, defaultTimeframe: DEFAULT_TIMEFRAME, strategyId: DEFAULT_STRATEGY_ID,
    });
    results.spot = 'added';
  }

  if (item.asset_type !== 'crypto') {
    results.demoFutures = 'skipped (not a crypto asset)';
    results.realFutures = 'skipped (not a crypto asset)';
  } else {
    const futuresSymbol = toFuturesSymbol(symbol);
    const futuresExchange = exchangeClientFactory.isFuturesExchangeSupported(exchange) ? exchange : 'kucoin';

    for (const [key, mode] of [['demoFutures', 'demo'], ['realFutures', 'real']]) {
      if (futuresAssetsRepository.getAsset(mode, req.user.id, futuresSymbol, futuresExchange)) {
        results[key] = `already in ${mode === 'demo' ? 'Demo' : 'Real'} Futures Signals Setting`;
      } else {
        futuresAssetsRepository.addAsset(mode, req.user.id, {
          symbol: futuresSymbol, exchange: futuresExchange, leverage: DEFAULT_LEVERAGE,
          strategyId: DEFAULT_STRATEGY_ID, defaultTimeframe: DEFAULT_TIMEFRAME,
        });
        results[key] = `added as ${futuresSymbol} on ${futuresExchange}`;
      }
    }
  }

  sendSuccess(res, results, `${symbol} promoted to Signals Setting.`);
}

module.exports = { listWatchlist, addToWatchlist, removeFromWatchlist, promoteToSignalsSetting };
