'use strict';

// Live Demo/Real SPOT auto-trader for the Liquidity Sweep Reversal strategy — the CRYPTO SPOT MODE
// counterpart to reversal-auto-trader.js (futures). Structural twin of that file (same
// start/stop/runCycle/getStatus shape, same per-user real-credential gating, same .unref()'d
// setInterval, same per-asset try/catch) but:
//
//   - LONG ONLY. A 'bearish' decision from the live engine (which is market-agnostic — see
//     live-engine.js's header comment) is simply discarded here, never executed. There is no
//     naked short on spot, ever — this is the one and only place that constraint is enforced; the
//     strategy engine itself never knows it's running in spot mode (ARCHITECTURE.md §0).
//   - No leverage, no liquidation, no funding rate, no margin mode — plain BUY (base asset with
//     quote currency) and, on exit, SELL an existing holding. Uses demo-orders.js/real-orders.js
//     exactly as every other spot strategy already does.
//   - Spot has ONE shared watchlist (`assets`, not futures' split demo_futures_assets/
//     real_futures_assets), so demo/real eligibility are two separate flags on the same row —
//     auto_trade_enabled (existing, Demo) and real_auto_trade_enabled (new, explicit Real opt-in
//     — see schema.js's migrateAddRealAutoTradeColumn comment for why this shape rather than a
//     table split).
//
// Position EXITS are not handled here — position-risk-watcher.js already generically closes any
// open spot position (any strategy, any scheduler) once its stored stop-loss/take-profit is hit.

const assetsRepository = require('../../database/repositories/assets-repository');
const positionsRepository = require('../../database/repositories/positions-repository');
const liveEngine = require('../reversal-strategy/live-engine');
const { resolveTrailingPercent } = require('../risk/atr-trailing');
const { STRATEGY_ID: LSR_STRATEGY_ID } = require('../backtesting/reversal-backtest-engine');
const { placeDemoOrder } = require('../orders/demo-orders');
const { placeRealOrder } = require('../orders/real-orders');
const { resolveRealCredentials } = require('../exchanges/real-credentials-resolver');
const { DEFAULT_CONFIG: LSR_DEFAULT_CONFIG } = require('../reversal-strategy/config');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// LSR has no single timeframe (it watches HTF/signal/entry simultaneously — see live-engine.js),
// so "the timeframe that led to the signal" for the Open Positions display is this composite
// string rather than one value — see reversal-auto-trader.js's identical constant.
const LSR_TIMEFRAME_LABEL = `${LSR_DEFAULT_CONFIG.htfTimeframe}/${LSR_DEFAULT_CONFIG.signalTimeframe}/${LSR_DEFAULT_CONFIG.entryTimeframe}`;

let intervalHandle = null;
let isRunning = false;

/** Same server-wide gates as reversal-auto-trader.js's identical helper, spot's own flag —
 *  see config.js's enableSpotAutoTrading comment. */
function realSpotAutoTradeGloballyAllowed() {
  if (!config.enableSpotAutoTrading) return { allowed: false, reason: 'ENABLE_SPOT_AUTO_TRADING is not true' };
  if (!config.enableLiveTrading) return { allowed: false, reason: 'ENABLE_LIVE_TRADING is not true' };
  return { allowed: true, reason: null };
}

/** Simpler than futures' equivalent — spot has no curated exchange allowlist (any exchange this
 *  app resolves via ccxt is spot-capable, see exchange-client-factory.js), so this only needs to
 *  confirm credentials are actually present. */
function resolveRealCredentialsForUser(userId, cache) {
  if (cache.has(userId)) return cache.get(userId);
  const credentials = resolveRealCredentials(userId);
  const usable = credentials.name && credentials.apiKey && credentials.apiSecret ? credentials : null;
  cache.set(userId, usable);
  return usable;
}

async function processAsset(mode, asset, realCredCache) {
  const userId = asset.user_id;
  const symbol = asset.symbol;
  const exchange = asset.exchange;

  try {
    if (mode === 'real' && !resolveRealCredentialsForUser(userId, realCredCache)) {
      logger.debug('reversal-spot-auto-trader', `Skipped real LSR spot asset ${symbol} for user ${userId}: no usable real credentials configured`, {}, mode);
      return;
    }

    const openPosition = positionsRepository.findOpenPositionBySymbol(mode, userId, symbol);
    const decision = await liveEngine.processLiveCycle({ market: 'spot', mode, userId, symbol, exchange, hasOpenPosition: !!openPosition });
    if (!decision) return;

    // LONG ONLY — see this file's header comment. A bearish decision is a valid, real signal from
    // the (market-agnostic) strategy engine; it is simply not executable on spot and is dropped
    // here rather than upstream, so the same engine/backtest keeps producing both directions for
    // comparison against the futures (long+short) results.
    if (decision.direction !== 'bullish') {
      logger.debug('reversal-spot-auto-trader', `Discarded a bearish LSR decision for ${symbol}: spot is long-only`, { userId }, mode);
      return;
    }

    const placeOrder = mode === 'real' ? placeRealOrder : placeDemoOrder;
    // strategyId identifies this position as LSR-opened for the Open Positions "Strategy" column
    // even though there's no signals-table row to derive it from — see
    // futures-portfolio-service.js#openPosition's comment on this explicit-override param.
    const trailingPercent = await resolveTrailingPercent(asset, { symbol, exchange, market: 'spot', timeframe: asset.default_timeframe });
    const orderArgs = { userId, symbol, exchange, side: 'buy', stopLoss: decision.stopLoss, takeProfit: decision.takeProfit, strategyId: LSR_STRATEGY_ID, timeframe: LSR_TIMEFRAME_LABEL, trailingPercent };
    if (mode === 'real') orderArgs.unlockConfirmed = true; // no human present per-trade — gated by realSpotAutoTradeGloballyAllowed() + the asset's own real_auto_trade_enabled + per-user credentials instead

    const order = await placeOrder(orderArgs);
    logger.info('reversal-spot-auto-trader', `LSR spot BUY ${order.status} for ${symbol}`, { mode, userId, orderId: order.id, rejectReason: order.reject_reason }, mode);
  } catch (err) {
    logger.error('reversal-spot-auto-trader', `LSR spot cycle failed for ${symbol}@${exchange} (${mode}, user ${userId}): ${err.message}`, {}, mode);
  }
}

/** Exported directly so it can be triggered on-demand (e.g. from a test or a manual "run now"). */
async function runCycle() {
  const isLsrAsset = (a) => a.strategy_id === LSR_STRATEGY_ID;
  const demoAssets = assetsRepository.listAutoTradeEnabled().filter(isLsrAsset);
  const { allowed: realAllowed, reason: realBlockedReason } = realSpotAutoTradeGloballyAllowed();
  const realAssets = realAllowed ? assetsRepository.listRealAutoTradeEnabled().filter(isLsrAsset) : [];
  const realCredCache = new Map();

  if (!realAllowed && realBlockedReason) {
    logger.debug('reversal-spot-auto-trader', `Real LSR spot cycle skipped: ${realBlockedReason}`, {}, 'real');
  }
  if (demoAssets.length > 0 || realAssets.length > 0) {
    logger.debug('reversal-spot-auto-trader', `Running LSR spot auto-trade cycle: ${demoAssets.length} demo asset(s), ${realAssets.length} real asset(s)`, {}, 'demo');
  }

  for (const asset of demoAssets) await processAsset('demo', asset, realCredCache);
  for (const asset of realAssets) await processAsset('real', asset, realCredCache);

  return { evaluated: demoAssets.length + realAssets.length, demoEvaluated: demoAssets.length, realEvaluated: realAssets.length };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (isRunning) {
      logger.warn('reversal-spot-auto-trader', 'Skipped LSR spot auto-trade cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('reversal-spot-auto-trader', `LSR spot auto-trade cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.futuresAutoTradeIntervalMs); // shares the same LSR-ecosystem polling cadence as reversal-auto-trader.js — see config.js's enableSpotAutoTrading comment
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('reversal-spot-auto-trader', `Liquidity Sweep Reversal spot auto-trader started (interval ${config.futuresAutoTradeIntervalMs}ms, long-only, real trading ${config.enableSpotAutoTrading ? 'ALLOWED (subject to credential gates + each asset\'s own real opt-in)' : 'disabled'})`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function getStatus() {
  const isLsrAsset = (a) => a.strategy_id === LSR_STRATEGY_ID;
  return {
    running: intervalHandle !== null,
    intervalMs: config.futuresAutoTradeIntervalMs,
    enableSpotAutoTrading: config.enableSpotAutoTrading,
    demoEnabledAssetCount: assetsRepository.listAutoTradeEnabled().filter(isLsrAsset).length,
    realEnabledAssetCount: assetsRepository.listRealAutoTradeEnabled().filter(isLsrAsset).length,
  };
}

module.exports = { start, stop, runCycle, getStatus, realSpotAutoTradeGloballyAllowed };
