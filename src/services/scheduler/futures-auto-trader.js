'use strict';

const futuresAssetsRepository = require('../../database/repositories/futures-assets-repository');
const futuresPositionsRepository = require('../../database/repositories/futures-positions-repository');
const futuresPortfolioService = require('../portfolio/futures-portfolio-service');
const signalsService = require('../signals');
const { placeDemoFuturesOrder } = require('../orders/futures-demo-orders');
const { placeRealFuturesOrder } = require('../orders/futures-real-orders');
const { resolveRealCredentials } = require('../exchanges/real-credentials-resolver');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// Distance to (real or estimated) liquidation price, as a percent of current price, under which
// a warning is logged every cycle for an open auto-opened position. Not an auto-close — a
// surfaced safety signal only, since auto-closing on a threshold is a further, separate decision
// the user hasn't made (see docs/architecture.md Phase 2 section).
const LIQUIDATION_WARNING_THRESHOLD_PERCENT = 10;

let intervalHandle = null;
let isRunning = false;

/**
 * Whether REAL (leveraged, unattended) trading is allowed *at all* right now — the pure,
 * server-wide gates only. Deliberately has NO credential lookup: credentials are per-user now
 * (see resolveRealCredentialsForUser below), so "is any given user's account configured" can't be
 * answered globally — that decision happens per-asset in processAsset, via runCycle()'s per-cycle
 * credentials cache. This function only decides whether the server is willing to consider real
 * trading at all before it even looks at the Real watchlist.
 */
function realAutoTradeGloballyAllowed() {
  if (!config.enableFuturesAutoTrading) return { allowed: false, reason: 'ENABLE_FUTURES_AUTO_TRADING is not true' };
  if (!config.enableLiveTrading) return { allowed: false, reason: 'ENABLE_LIVE_TRADING is not true' };
  return { allowed: true, reason: null };
}

/**
 * Resolves (and memoizes, per cycle) whether this user has usable real KuCoin futures
 * credentials configured. Returns the credentials object if so, or null if not — null is a
 * normal, expected outcome (most users on a shared instance won't have configured Real trading),
 * not an error. This cache is a cycle-level short-circuit only: placeRealFuturesOrder
 * independently re-resolves and re-validates credentials itself before ever calling the exchange,
 * so a stale or wrong cache entry can never itself cause a real order to be placed.
 */
function resolveRealCredentialsForUser(userId, cache) {
  if (cache.has(userId)) return cache.get(userId);
  const credentials = resolveRealCredentials(userId);
  const usable = !!(credentials.name && credentials.apiKey && credentials.apiSecret && credentials.name.toLowerCase() === 'kucoin')
    ? credentials
    : null;
  cache.set(userId, usable);
  return usable;
}

// Same rule as auto-trader.js's identical helper — see its comment. Duplicated rather than
// shared, matching this pair of schedulers' established "deliberately not shared" convention.
function resolveCombinedStrategyIds(asset) {
  if (asset.strategy_mode !== 'auto') return null;
  try {
    const ids = JSON.parse(asset.selected_strategy_ids_json || 'null');
    return Array.isArray(ids) && ids.length >= 2 ? ids : null;
  } catch {
    return null;
  }
}

async function processAsset(mode, asset, source, realCredCache) {
  const userId = asset.user_id;
  const symbol = asset.symbol;
  const exchange = asset.exchange;

  try {
    // One user's missing/misconfigured credentials only ever skips THIS asset for THIS user —
    // it never blocks or affects any other user's assets in the same cycle. This is what makes
    // per-user real trading genuinely independent.
    if (mode === 'real' && !resolveRealCredentialsForUser(userId, realCredCache)) {
      logger.debug('futures-auto-trader', `Skipped real futures asset ${symbol} for user ${userId}: no usable real KuCoin credentials configured`, {}, mode);
      return;
    }

    const combinedStrategyIds = resolveCombinedStrategyIds(asset);
    const signal = combinedStrategyIds
      ? await signalsService.generateCombinedSignal({
          symbol, exchange, timeframe: asset.default_timeframe || '1h', mode: 'demo', userId, strategyIds: combinedStrategyIds, market: 'futures',
        })
      : await signalsService.generateSignal({
          symbol, exchange, timeframe: asset.default_timeframe || '1h', mode: 'demo', userId, strategyId: asset.strategy_id, market: 'futures',
        });

    const openPosition = futuresPositionsRepository.findOpenPositionBySymbol(mode, userId, symbol);
    const placeOrder = mode === 'real' ? placeRealFuturesOrder : placeDemoFuturesOrder;
    // Leverage is clamped DOWN to the hard cap, never up — the asset's own configured leverage is
    // a ceiling the trader may choose, not a floor the cap must respect. Only relevant for real
    // (Demo has no leverage cap concept beyond what the asset itself specifies).
    const leverage = mode === 'real' ? Math.min(asset.leverage, config.futuresAutoTradeMaxLeverage) : asset.leverage;

    if (signal.status === 'BUY' && !openPosition) {
      if (signal.stopLoss == null || signal.takeProfit == null) {
        logger.warn('futures-auto-trader', `Skipped open_long for ${symbol}: signal had no stop/take-profit`, { userId }, mode);
        return;
      }
      const orderArgs = { userId, symbol, exchange, action: 'open_long', leverage, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, signalId: signal.id, source };
      if (mode === 'real') orderArgs.unlockConfirmed = true; // no human present per-trade; gated by realAutoTradeGloballyAllowed() + list membership + per-user credentials instead
      const order = await placeOrder(orderArgs);
      logger.info('futures-auto-trader', `AI futures auto-trade open_long ${order.status} for ${symbol}`, { mode, userId, orderId: order.id, leverage, rejectReason: order.reject_reason }, mode);
    } else if (signal.status === 'SELL' && openPosition) {
      const orderArgs = { userId, symbol, exchange, action: 'close', signalId: signal.id, source };
      if (mode === 'real') orderArgs.unlockConfirmed = true;
      const order = await placeOrder(orderArgs);
      logger.info('futures-auto-trader', `AI futures auto-trade close ${order.status} for ${symbol}`, { mode, userId, orderId: order.id, rejectReason: order.reject_reason }, mode);
    }
    // HOLD, NO_DATA, a BUY while already positioned, or a SELL with nothing open: no action.
  } catch (err) {
    logger.error('futures-auto-trader', `Futures auto-trade cycle failed for ${symbol}@${exchange} (${mode}, user ${userId}): ${err.message}`, {}, mode);
  }
}

/** Re-checks every open, auto-opened position's distance to liquidation, both modes, every user,
 *  every cycle — a surfaced warning, never an auto-close. See LIQUIDATION_WARNING_THRESHOLD_PERCENT. */
async function checkLiquidationDistances() {
  for (const mode of ['demo', 'real']) {
    let positions;
    try {
      positions = await futuresPortfolioService.getAllOpenPositionsWithUnrealizedPnl(mode);
    } catch (err) {
      logger.error('futures-auto-trader', `Failed to check liquidation distances (${mode}): ${err.message}`, {}, mode);
      continue;
    }
    for (const position of positions) {
      if (typeof position.liquidationDistancePercent !== 'number') continue;
      if (position.liquidationDistancePercent < LIQUIDATION_WARNING_THRESHOLD_PERCENT) {
        logger.warn(
          'futures-auto-trader',
          `${position.symbol} (${mode}) is within ${position.liquidationDistancePercent.toFixed(1)}% of its liquidation price (${position.liquidation_price}) at current price ${position.currentPrice}.`,
          { positionId: position.id, leverage: position.leverage, userId: position.user_id },
          mode
        );
      }
    }
  }
}

/** Exported directly so it can be triggered on-demand (e.g. from a test or a manual "run now").
 *  Iterates the Demo and Real watchlists as two fully independent lists — a symbol can be on one,
 *  the other, both, or neither, with its own leverage/strategy per list. The Real list is only
 *  even fetched when the server-wide gates pass; per-user credential gating happens per-asset in
 *  processAsset via the realCredCache built here (resolved at most once per user per cycle). */
async function runCycle() {
  const demoAssets = futuresAssetsRepository.listAutoTradeEnabled('demo');
  const { allowed: realAllowed, reason: realBlockedReason } = realAutoTradeGloballyAllowed();
  const realAssets = realAllowed ? futuresAssetsRepository.listAutoTradeEnabled('real') : [];
  const realCredCache = new Map();

  if (!realAllowed && realBlockedReason) {
    logger.debug('futures-auto-trader', `Real auto-trade cycle skipped: ${realBlockedReason}`, {}, 'real');
  }

  if (demoAssets.length > 0 || realAssets.length > 0) {
    logger.debug('futures-auto-trader', `Running futures auto-trade cycle: ${demoAssets.length} demo asset(s), ${realAssets.length} real asset(s)`, {}, 'demo');
  }
  for (const asset of demoAssets) {
    await processAsset('demo', asset, 'auto', realCredCache);
  }
  for (const asset of realAssets) {
    await processAsset('real', asset, 'auto', realCredCache);
  }

  await checkLiquidationDistances();
  return { evaluated: demoAssets.length + realAssets.length, demoEvaluated: demoAssets.length, realEvaluated: realAssets.length };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    // See auto-trader.js's identical guard: prevents overlapping cycles from piling up when a
    // cycle takes longer than the poll interval (e.g. a slow exchange — KuCoin's futures
    // endpoint in particular is documented elsewhere in this file as sometimes unreachable).
    if (isRunning) {
      logger.warn('futures-auto-trader', 'Skipped futures auto-trade cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('futures-auto-trader', `Futures auto-trade cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.futuresAutoTradeIntervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('futures-auto-trader', `Futures AI auto-trader started (interval ${config.futuresAutoTradeIntervalMs}ms, real trading ${config.enableFuturesAutoTrading ? 'ALLOWED (subject to credential gates + the Real watchlist)' : 'disabled'})`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function getStatus() {
  return {
    running: intervalHandle !== null,
    intervalMs: config.futuresAutoTradeIntervalMs,
    enableFuturesAutoTrading: config.enableFuturesAutoTrading,
    maxLeverage: config.futuresAutoTradeMaxLeverage,
    demoEnabledAssetCount: futuresAssetsRepository.listAutoTradeEnabled('demo').length,
    realEnabledAssetCount: futuresAssetsRepository.listAutoTradeEnabled('real').length,
  };
}

module.exports = { start, stop, runCycle, getStatus, realAutoTradeGloballyAllowed };
