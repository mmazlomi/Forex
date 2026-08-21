'use strict';

// Live Demo/Real futures auto-trader for the Liquidity Sweep Reversal strategy — the Phase 2
// scheduler counterpart to futures-auto-trader.js. Structural twin of that file (same
// start/stop/runCycle/getStatus shape, same per-user real-credential gating, same .unref()'d
// setInterval, same per-asset try/catch so one asset's failure never blocks the rest of the
// cycle) but drives src/services/reversal-strategy/live-engine.js instead of
// signals/index.js#generateSignal — LSR is a stateful, multi-timeframe sequence, not a
// per-candle weighted score, so it was never routed through the normal signal-generation path
// (see futures-auto-trader.js's own early-return guard that skips LSR-tagged assets, and
// strategies.js's comment on why LSR is excluded from listStrategies()).
//
// Position EXITS (stop-loss/take-profit) are NOT handled here — every open futures position,
// regardless of which strategy or scheduler opened it, is already monitored by
// position-risk-watcher.js. This scheduler only ever decides entries.

const futuresAssetsRepository = require('../../database/repositories/futures-assets-repository');
const futuresPositionsRepository = require('../../database/repositories/futures-positions-repository');
const liveEngine = require('../reversal-strategy/live-engine');
const { resolveTrailingPercent } = require('../risk/atr-trailing');
const { STRATEGY_ID: LSR_STRATEGY_ID } = require('../backtesting/reversal-backtest-engine');
const { placeDemoFuturesOrder } = require('../orders/futures-demo-orders');
const { placeRealFuturesOrder } = require('../orders/futures-real-orders');
const { resolveRealCredentials } = require('../exchanges/real-credentials-resolver');
const exchangeClientFactory = require('../exchanges/exchange-client-factory');
const { DEFAULT_CONFIG: LSR_DEFAULT_CONFIG } = require('../reversal-strategy/config');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// LSR has no single timeframe (it watches HTF/signal/entry simultaneously — see live-engine.js),
// so "the timeframe that led to the signal" for the Open Positions display is this composite
// string rather than one value. Matches whatever live-engine.js is actually configured with
// (currently always LSR_DEFAULT_CONFIG — see live-engine.js#processLiveCycle's configOverrides).
const LSR_TIMEFRAME_LABEL = `${LSR_DEFAULT_CONFIG.htfTimeframe}/${LSR_DEFAULT_CONFIG.signalTimeframe}/${LSR_DEFAULT_CONFIG.entryTimeframe}`;

let intervalHandle = null;
let isRunning = false;

/** Same server-wide gates as futures-auto-trader.js's identical helper — see its comment. */
function realAutoTradeGloballyAllowed() {
  if (!config.enableFuturesAutoTrading) return { allowed: false, reason: 'ENABLE_FUTURES_AUTO_TRADING is not true' };
  if (!config.enableLiveTrading) return { allowed: false, reason: 'ENABLE_LIVE_TRADING is not true' };
  return { allowed: true, reason: null };
}

/** Same per-cycle credential cache as futures-auto-trader.js's identical helper — see its comment. */
function resolveRealCredentialsForUser(userId, cache) {
  if (cache.has(userId)) return cache.get(userId);
  const credentials = resolveRealCredentials(userId);
  const usable = !!(credentials.name && credentials.apiKey && credentials.apiSecret && exchangeClientFactory.isFuturesExchangeSupported(credentials.name))
    ? credentials
    : null;
  cache.set(userId, usable);
  return usable;
}

async function processAsset(mode, asset, source, realCredCache) {
  const userId = asset.user_id;
  const symbol = asset.symbol;
  const exchange = asset.exchange;

  try {
    if (mode === 'real' && !resolveRealCredentialsForUser(userId, realCredCache)) {
      logger.debug('reversal-auto-trader', `Skipped real LSR asset ${symbol} for user ${userId}: no usable real KuCoin credentials configured`, {}, mode);
      return;
    }

    const openPosition = futuresPositionsRepository.findOpenPositionBySymbol(mode, userId, symbol);
    const decision = await liveEngine.processLiveCycle({ market: 'futures', mode, userId, symbol, exchange, hasOpenPosition: !!openPosition });
    if (!decision) return;

    // Leverage clamped DOWN to the hard cap for real, never up — same rule as futures-auto-trader.js.
    const leverage = mode === 'real' ? Math.min(asset.leverage, config.futuresAutoTradeMaxLeverage) : asset.leverage;
    const action = decision.direction === 'bullish' ? 'open_long' : 'open_short';
    const placeOrder = mode === 'real' ? placeRealFuturesOrder : placeDemoFuturesOrder;
    // strategyId identifies this position as LSR-opened for the Open Positions "Strategy" column
    // even though there's no signals-table row to derive it from (LSR never writes one — see
    // futures-portfolio-service.js#openPosition's comment on this explicit-override param).
    const trailingPercent = await resolveTrailingPercent(asset, { symbol, exchange, market: 'futures', timeframe: asset.default_timeframe });
    const orderArgs = { userId, symbol, exchange, action, leverage, stopLoss: decision.stopLoss, takeProfit: decision.takeProfit, source, strategyId: LSR_STRATEGY_ID, timeframe: LSR_TIMEFRAME_LABEL, trailingPercent };
    if (mode === 'real') orderArgs.unlockConfirmed = true; // no human present per-trade — gated by realAutoTradeGloballyAllowed() + list membership + per-user credentials instead

    const order = await placeOrder(orderArgs);
    logger.info('reversal-auto-trader', `LSR ${action} ${order.status} for ${symbol}`, { mode, userId, orderId: order.id, leverage, rejectReason: order.reject_reason }, mode);
  } catch (err) {
    logger.error('reversal-auto-trader', `LSR cycle failed for ${symbol}@${exchange} (${mode}, user ${userId}): ${err.message}`, {}, mode);
  }
}

/** Exported directly so it can be triggered on-demand (e.g. from a test or a manual "run now"). */
async function runCycle() {
  const isLsrAsset = (a) => a.strategy_id === LSR_STRATEGY_ID;
  const demoAssets = futuresAssetsRepository.listAutoTradeEnabled('demo').filter(isLsrAsset);
  const { allowed: realAllowed, reason: realBlockedReason } = realAutoTradeGloballyAllowed();
  const realAssets = realAllowed ? futuresAssetsRepository.listAutoTradeEnabled('real').filter(isLsrAsset) : [];
  const realCredCache = new Map();

  if (!realAllowed && realBlockedReason) {
    logger.debug('reversal-auto-trader', `Real LSR cycle skipped: ${realBlockedReason}`, {}, 'real');
  }
  if (demoAssets.length > 0 || realAssets.length > 0) {
    logger.debug('reversal-auto-trader', `Running LSR auto-trade cycle: ${demoAssets.length} demo asset(s), ${realAssets.length} real asset(s)`, {}, 'demo');
  }

  for (const asset of demoAssets) await processAsset('demo', asset, 'auto', realCredCache);
  for (const asset of realAssets) await processAsset('real', asset, 'auto', realCredCache);

  return { evaluated: demoAssets.length + realAssets.length, demoEvaluated: demoAssets.length, realEvaluated: realAssets.length };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    // See futures-auto-trader.js's identical guard: prevents overlapping cycles piling up when a
    // cycle takes longer than the poll interval (e.g. a slow exchange).
    if (isRunning) {
      logger.warn('reversal-auto-trader', 'Skipped LSR auto-trade cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('reversal-auto-trader', `LSR auto-trade cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.futuresAutoTradeIntervalMs); // shares futures-auto-trader.js's interval setting rather than adding a new env var
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('reversal-auto-trader', `Liquidity Sweep Reversal auto-trader started (interval ${config.futuresAutoTradeIntervalMs}ms, real trading ${config.enableFuturesAutoTrading ? 'ALLOWED (subject to credential gates + the Real watchlist)' : 'disabled'})`);
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
    enableFuturesAutoTrading: config.enableFuturesAutoTrading,
    maxLeverage: config.futuresAutoTradeMaxLeverage,
    demoEnabledAssetCount: futuresAssetsRepository.listAutoTradeEnabled('demo').filter(isLsrAsset).length,
    realEnabledAssetCount: futuresAssetsRepository.listAutoTradeEnabled('real').filter(isLsrAsset).length,
  };
}

module.exports = { start, stop, runCycle, getStatus, realAutoTradeGloballyAllowed };
