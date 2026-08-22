'use strict';

const assetsRepository = require('../database/repositories/assets-repository');
const exchangeClientFactory = require('../services/exchanges/exchange-client-factory');
const { withRetry } = require('../utils/retry');
const config = require('../../config/config');
const { resolveStrategyId } = require('../services/signals/strategies');
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

  // resolveStrategyId() falls back to the default for an unknown id, so this always resolves to
  // a real strategy id rather than storing something invalid — see strategies.js's comment on why
  // this (not getStrategy().id) is the right resolver for storage: it also recognizes Liquidity
  // Sweep Reversal, which getStrategy() would otherwise silently coerce to "balanced".
  const resolvedStrategyId = resolveStrategyId(strategyId);
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

// A separate, explicit real-money opt-in from setAutoTrade above (which the generic Demo-only
// auto-trader.js reads) — currently only actually acted on by reversal-spot-auto-trader.js for
// Liquidity Sweep Reversal-tagged assets. See assets-repository.js#setRealAutoTrade's comment.
async function setRealAutoTrade(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { enabled } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (typeof enabled !== 'boolean') {
    return sendError(res, 'VALIDATION_ERROR', 'enabled (boolean) is required in the request body.');
  }
  const asset = assetsRepository.setRealAutoTrade(req.user.id, symbol, exchange, enabled);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  const note = enabled && !config.enableSpotAutoTrading
    ? ' (Note: the server has not enabled ENABLE_SPOT_AUTO_TRADING, so this will not actually place real trades yet.)'
    : '';
  sendSuccess(res, asset, `Real AI auto-trading ${enabled ? 'enabled' : 'disabled'} for ${symbol}.${note}`);
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
  const resolvedStrategyId = resolveStrategyId(strategyId);
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

// The default trailing-stop distance (percent of price) a position inherits when opened from this
// asset — manually via "Trade from Signal", or by AI Auto-Trade — unless the order itself
// overrides it. null clears it (trailing off). Positions already open are never retroactively
// changed by this — it only affects positions opened after the setting is saved.
// trailingMode 'atr' opts into an auto-computed distance (ATR(14) x 2 as a percent of price,
// recalculated fresh each time a position opens — see risk/atr-trailing.js) instead of the flat
// trailingPercent number; trailingPercent must be null when trailingMode is 'atr'.
async function setTrailingPercent(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { trailingPercent, trailingMode = 'fixed' } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (!['fixed', 'atr'].includes(trailingMode)) {
    return sendError(res, 'VALIDATION_ERROR', 'trailingMode must be "fixed" or "atr".');
  }
  if (trailingMode === 'atr') {
    if (trailingPercent !== null && trailingPercent !== undefined) {
      return sendError(res, 'VALIDATION_ERROR', 'trailingPercent must be null when trailingMode is "atr" — the distance is computed automatically.');
    }
  } else if (trailingPercent !== null && !(typeof trailingPercent === 'number' && trailingPercent > 0 && trailingPercent < 100)) {
    return sendError(res, 'VALIDATION_ERROR', 'trailingPercent must be a number between 0 and 100 (exclusive), or null to disable.');
  }
  const asset = assetsRepository.setTrailingPercent(req.user.id, symbol, exchange, trailingMode === 'atr' ? null : trailingPercent, trailingMode);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  const message = trailingMode === 'atr'
    ? `Trailing stop set to auto (ATR-based) for ${symbol}.`
    : (trailingPercent ? `Trailing stop set to ${trailingPercent}% for ${symbol}.` : `Trailing stop disabled for ${symbol}.`);
  sendSuccess(res, asset, message);
}

// Opt-in flag for the Adaptive Take-Profit engine (see risk/adaptive-take-profit-resolver.js) —
// off by default, affects only positions opened after this is saved, same "opt-in, forward-only"
// contract as setTrailingPercent above.
async function setAdaptiveTp(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { enabled } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (typeof enabled !== 'boolean') {
    return sendError(res, 'VALIDATION_ERROR', 'enabled must be a boolean.');
  }
  const asset = assetsRepository.setAdaptiveTpEnabled(req.user.id, symbol, exchange, enabled);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  sendSuccess(res, asset, `Adaptive Take-Profit ${enabled ? 'enabled' : 'disabled'} for ${symbol}.`);
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

const LSR_TIMEFRAME_MODES = ['manual', 'auto'];

// 'auto' opts this LSR asset into lsr-timeframe-selector.js's periodic backtesting of candidate
// htf/signal/entry timeframe triples — see assets-repository.js#setLsrTimeframeMode's comment.
// Switching modes never clears a prior lsr_selected_timeframes_json; it's simply ignored while in
// 'manual' mode. Meaningless (and harmless) for a non-LSR asset — this app never reads these
// columns for anything but an LSR-tagged asset.
async function setLsrTimeframeMode(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { mode } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  if (!LSR_TIMEFRAME_MODES.includes(mode)) {
    return sendError(res, 'VALIDATION_ERROR', `mode must be one of: ${LSR_TIMEFRAME_MODES.join(', ')}.`);
  }
  const asset = assetsRepository.setLsrTimeframeMode(req.user.id, symbol, exchange, mode);
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  sendSuccess(res, asset, `LSR timeframe mode set to "${mode}" for ${symbol}.`);
}

// Manual per-asset htf/signal/entry timeframe override — used only while lsr_timeframe_mode is
// 'manual' (the default). Any field omitted or null clears that override back to the global
// default (reversal-strategy/config.js's DEFAULT_CONFIG).
async function setLsrManualTimeframes(req, res) {
  const { symbol } = req.params;
  const { exchange } = req.query;
  const { htfTimeframe, signalTimeframe, entryTimeframe } = req.body || {};
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  for (const [key, value] of Object.entries({ htfTimeframe, signalTimeframe, entryTimeframe })) {
    if (value != null && !SUPPORTED_TIMEFRAMES.includes(value)) {
      return sendError(res, 'VALIDATION_ERROR', `${key} must be one of ${SUPPORTED_TIMEFRAMES.join(', ')}, or null.`);
    }
  }
  const asset = assetsRepository.setLsrManualTimeframes(req.user.id, symbol, exchange, { htfTimeframe, signalTimeframe, entryTimeframe });
  if (!asset) {
    return sendError(res, 'ASSET_NOT_FOUND', `No asset "${symbol}" on "${exchange}" was found on your watchlist.`, 404);
  }
  sendSuccess(res, asset, `LSR timeframe override updated for ${symbol}.`);
}

module.exports = {
  listAssets, addAsset, removeAsset, setAutoTrade, setRealAutoTrade, setStrategy, setTimeframe, setExchange, setStrategyMode, setTrailingPercent,
  setLsrTimeframeMode, setLsrManualTimeframes, setAdaptiveTp,
};
