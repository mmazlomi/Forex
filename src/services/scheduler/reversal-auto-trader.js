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
const { resolveAdaptiveTp } = require('../risk/adaptive-take-profit-resolver');
const marketDataService = require('../market-data/market-data-service');
const { STRATEGY_ID: LSR_STRATEGY_ID } = require('../backtesting/reversal-backtest-engine');
const { placeDemoFuturesOrder } = require('../orders/futures-demo-orders');
const { placeRealFuturesOrder } = require('../orders/futures-real-orders');
const { resolveRealCredentials } = require('../exchanges/real-credentials-resolver');
const exchangeClientFactory = require('../exchanges/exchange-client-factory');
const { mergeConfig: mergeLsrConfig } = require('../reversal-strategy/config');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// LSR has no single timeframe (it watches HTF/signal/entry simultaneously — see live-engine.js),
// so "the timeframe that led to the signal" for the Open Positions display is a composite
// "htf/signal/entry" string rather than one value — see buildLsrTimeframeLabel below, which
// reflects whatever this asset is ACTUALLY configured with (global default, a manual per-asset
// override, or lsr-timeframe-selector.js's latest auto-selected pick — see
// resolveLsrConfigOverrides), not always the fixed global default anymore.
let intervalHandle = null;
let isRunning = false;

/** Resolves this asset's htf/signal/entry timeframe overrides for live-engine.js's
 *  processLiveCycle. 'auto' mode uses lsr-timeframe-selector.js's latest pick
 *  (lsr_selected_timeframes_json); 'manual' (default) uses this asset's own
 *  lsr_htf_timeframe/lsr_signal_timeframe/lsr_entry_timeframe override for whichever fields are
 *  set, falling back to reversal-strategy/config.js's own global DEFAULT_CONFIG for the rest. A
 *  malformed lsr_selected_timeframes_json (shouldn't happen — only ever written by
 *  lsr-timeframe-selector.js itself) fails safe to {} (global default) rather than crashing the cycle. */
function resolveLsrConfigOverrides(asset) {
  if (asset.lsr_timeframe_mode === 'auto' && asset.lsr_selected_timeframes_json) {
    try {
      return JSON.parse(asset.lsr_selected_timeframes_json);
    } catch {
      return {};
    }
  }
  const overrides = {};
  if (asset.lsr_htf_timeframe) overrides.htfTimeframe = asset.lsr_htf_timeframe;
  if (asset.lsr_signal_timeframe) overrides.signalTimeframe = asset.lsr_signal_timeframe;
  if (asset.lsr_entry_timeframe) overrides.entryTimeframe = asset.lsr_entry_timeframe;
  return overrides;
}

function buildLsrTimeframeLabel(configOverrides) {
  const merged = mergeLsrConfig(configOverrides);
  return `${merged.htfTimeframe}/${merged.signalTimeframe}/${merged.entryTimeframe}`;
}

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
    const configOverrides = resolveLsrConfigOverrides(asset);
    const decision = await liveEngine.processLiveCycle({ market: 'futures', mode, userId, symbol, exchange, hasOpenPosition: !!openPosition, configOverrides });
    if (!decision) return;

    // Leverage clamped DOWN to the hard cap for real, never up — same rule as futures-auto-trader.js.
    const leverage = mode === 'real' ? Math.min(asset.leverage, config.futuresAutoTradeMaxLeverage) : asset.leverage;
    const action = decision.direction === 'bullish' ? 'open_long' : 'open_short';
    const placeOrder = mode === 'real' ? placeRealFuturesOrder : placeDemoFuturesOrder;
    // strategyId identifies this position as LSR-opened for the Open Positions "Strategy" column
    // even though there's no signals-table row to derive it from (LSR never writes one — see
    // futures-portfolio-service.js#openPosition's comment on this explicit-override param).
    const trailingPercent = await resolveTrailingPercent(asset, { symbol, exchange, market: 'futures', timeframe: asset.default_timeframe });

    // See reversal-spot-auto-trader.js's identical comment: live-engine.js's decision carries no
    // entry price, so an opted-in asset gets one extra, targeted snapshot fetch here as the
    // adaptive engine's entry-price anchor; non-opted-in assets never pay this cost.
    let adaptiveTp;
    if (asset.adaptive_tp_enabled) {
      const entrySnapshot = await marketDataService.getFuturesSnapshot({ symbol, exchange });
      if (entrySnapshot.status === 'ok' && typeof entrySnapshot.price === 'number') {
        adaptiveTp = await resolveAdaptiveTp({
          asset, symbol, exchange, market: 'futures', timeframe: asset.default_timeframe,
          side: decision.direction === 'bullish' ? 'long' : 'short',
          entryPrice: entrySnapshot.price, stopLoss: decision.stopLoss,
        });
      }
    }

    const orderArgs = {
      userId, symbol, exchange, action, leverage, stopLoss: decision.stopLoss,
      takeProfit: adaptiveTp?.fallbackTakeProfit ?? decision.takeProfit,
      source, strategyId: LSR_STRATEGY_ID, timeframe: buildLsrTimeframeLabel(configOverrides), trailingPercent, adaptiveTp,
    };
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
