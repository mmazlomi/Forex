'use strict';

const assetsRepository = require('../../database/repositories/assets-repository');
const positionsRepository = require('../../database/repositories/positions-repository');
const signalsService = require('../signals');
const { placeDemoOrder } = require('../orders/demo-orders');
const { STRATEGY_ID: LSR_STRATEGY_ID } = require('../backtesting/reversal-backtest-engine');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// Hard constraint, not configurable: the AI auto-trader only ever operates in Demo mode.
// It reuses generateSignal() and placeDemoOrder() unmodified — same scoring engine, same
// 10-step risk pipeline, same emergency-stop check as a manually-placed Demo order. There
// is no separate "auto" execution path that could bypass any of that.
const MODE = 'demo';

let intervalHandle = null;
let isRunning = false;

// 'auto' strategy_mode only actually takes the combined (majority-vote) path once
// strategy-selector.js has successfully picked >= 2 strategies — an 'auto'-mode asset with no
// selection yet (still 'not yet evaluated') or a malformed/legacy value falls back to the
// ordinary single-strategy path below rather than erroring, since majority voting needs >= 2.
function resolveCombinedStrategyIds(asset) {
  if (asset.strategy_mode !== 'auto') return null;
  try {
    const ids = JSON.parse(asset.selected_strategy_ids_json || 'null');
    return Array.isArray(ids) && ids.length >= 2 ? ids : null;
  } catch {
    return null;
  }
}

async function processAsset(asset) {
  const userId = asset.user_id;
  const symbol = asset.symbol;
  const exchange = asset.exchange;
  const assetType = asset.asset_type;

  try {
    // Liquidity Sweep Reversal is a stateful, multi-timeframe sequence, not a per-candle weighted
    // score — scoring it via generateSignal()/generateCombinedSignal() below would silently treat
    // its strategy_id as an unknown STRATEGIES key and fall back to "balanced". It's traded by
    // its own scheduler instead (reversal-spot-auto-trader.js, long-only) — see
    // futures-auto-trader.js's identical guard and strategies.js's EXTENDED_STRATEGY_IDS comment.
    if (asset.strategy_id === LSR_STRATEGY_ID) return;

    // No providerId — fundamental-analysis/index.js resolves the correct CoinGecko coin id
    // for crypto assets from the ticker itself. Each watchlist asset carries its own strategy
    // (set via PUT /api/assets/:symbol/strategy, defaults to "balanced") unless it's opted into
    // 'auto' strategy_mode (PUT /api/assets/:symbol/strategy-mode), in which case a majority vote
    // across strategy-selector.js's currently-selected strategies is used instead.
    const combinedStrategyIds = resolveCombinedStrategyIds(asset);
    const signal = combinedStrategyIds
      ? await signalsService.generateCombinedSignal({
          symbol, exchange, timeframe: asset.default_timeframe || '1h', assetType, mode: MODE, userId,
          strategyIds: combinedStrategyIds,
        })
      : await signalsService.generateSignal({
          symbol, exchange, timeframe: asset.default_timeframe || '1h', assetType, mode: MODE, userId,
          strategyId: asset.strategy_id,
        });

    const openPosition = positionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);

    if (signal.status === 'BUY' && !openPosition) {
      if (signal.stopLoss == null || signal.takeProfit == null) {
        logger.warn('auto-trader', `Skipped BUY for ${symbol}: signal had no stop/take-profit`, {}, MODE);
        return;
      }
      const order = await placeDemoOrder({
        userId, symbol, exchange, side: 'buy', stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, signalId: signal.id,
        trailingPercent: asset.trailing_percent,
      });
      logger.info('auto-trader', `AI auto-trade BUY ${order.status} for ${symbol}`, { orderId: order.id, rejectReason: order.reject_reason, userId }, MODE);
    } else if (signal.status === 'SELL' && openPosition) {
      const order = await placeDemoOrder({ userId, symbol, exchange, side: 'sell', signalId: signal.id });
      logger.info('auto-trader', `AI auto-trade SELL ${order.status} for ${symbol}`, { orderId: order.id, rejectReason: order.reject_reason, userId }, MODE);
    }
    // HOLD, NO_DATA, a BUY while already positioned, or a SELL with nothing open: no action.
  } catch (err) {
    logger.error('auto-trader', `Auto-trade cycle failed for ${symbol}@${exchange} (user ${userId}): ${err.message}`, {}, MODE);
  }
}

/** Exported directly so it can be triggered on-demand (e.g. from a test or a manual "run now"). */
async function runCycle() {
  const enabledAssets = assetsRepository.listAutoTradeEnabled();
  if (enabledAssets.length === 0) return { evaluated: 0 };
  logger.debug('auto-trader', `Running AI auto-trade cycle for ${enabledAssets.length} asset(s)`, {}, MODE);
  for (const asset of enabledAssets) {
    await processAsset(asset);
  }
  return { evaluated: enabledAssets.length };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    // Guards against overlapping cycles: without this, a cycle that outlives the poll interval
    // (e.g. a slow/unreachable exchange forcing every asset through its full retry+timeout
    // budget) would let the next tick fire on top of it, piling up concurrent ccxt clients and
    // in-flight requests without bound.
    if (isRunning) {
      logger.warn('auto-trader', 'Skipped auto-trade cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('auto-trader', `Auto-trade cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.autoTradeIntervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('auto-trader', `AI auto-trader started (interval ${config.autoTradeIntervalMs}ms, Demo mode only)`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function getStatus() {
  return {
    running: intervalHandle !== null,
    intervalMs: config.autoTradeIntervalMs,
    mode: MODE,
    enabledAssetCount: assetsRepository.listAutoTradeEnabled().length,
  };
}

module.exports = { start, stop, runCycle, getStatus };
