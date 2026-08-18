'use strict';

const positionsRepository = require('../../database/repositories/positions-repository');
const futuresPositionsRepository = require('../../database/repositories/futures-positions-repository');
const ordersRepository = require('../../database/repositories/orders-repository');
const marketDataService = require('../market-data/market-data-service');
const { placeDemoOrder } = require('../orders/demo-orders');
const { placeRealOrder } = require('../orders/real-orders');
const { placeDemoFuturesOrder } = require('../orders/futures-demo-orders');
const { placeRealFuturesOrder } = require('../orders/futures-real-orders');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// Structural twin of pending-orders-watcher.js/auto-trader.js: same start/stop/runCycle/getStatus
// shape, same .unref()'d setInterval. Where those watch the `orders` table for pending
// Limit/Stop-Market/Stop-Limit/OCO orders, this one watches OPEN POSITIONS directly — every
// position (spot or futures, demo or real, opened manually or by an auto-trader) records a
// stop_loss/take_profit at open time, but nothing previously re-checked live price against those
// stored numbers. A position only closed when a later strategy signal said SELL, or when a
// separately-placed OCO/pending exit order filled — so a plain Buy/open_long, including every
// auto-trader-opened position, could blow straight through its own recorded stop-loss or
// take-profit with no reaction at all. This closes that gap by re-checking every open position's
// stored levels against a fresh price each cycle and closing it (market sell / futures close) the
// moment either is crossed.

let intervalHandle = null;
let isRunning = false;

/** Spot is long-only (side is always 'buy') — stop-loss triggers on price falling to/through it,
 *  take-profit on price rising to/through it. Returns which one fired, or null. */
function checkSpotTrigger(position, currentPrice) {
  if (typeof position.stop_loss === 'number' && currentPrice <= position.stop_loss) return 'stop_loss';
  if (typeof position.take_profit === 'number' && currentPrice >= position.take_profit) return 'take_profit';
  return null;
}

/** Futures has both long and short — a short's stop/take-profit sit on the opposite side of price
 *  from a long's, so the direction check is side-aware (get this backwards and a short's
 *  stop-loss becomes untriggerable, mirroring the exact risk pending-orders-watcher.js's
 *  checkFillCondition already calls out for buy/sell direction). */
function checkFuturesTrigger(position, currentPrice) {
  const isLong = position.side === 'long';
  if (typeof position.stop_loss === 'number') {
    const stopHit = isLong ? currentPrice <= position.stop_loss : currentPrice >= position.stop_loss;
    if (stopHit) return 'stop_loss';
  }
  if (typeof position.take_profit === 'number') {
    const takeHit = isLong ? currentPrice >= position.take_profit : currentPrice <= position.take_profit;
    if (takeHit) return 'take_profit';
  }
  return null;
}

/**
 * Pure: given a spot position with trailing_percent set (spot is long-only, so the high-water-mark
 * only ever rises) and a fresh price, returns the new { stopLoss, highWaterMark } to persist this
 * cycle, or null if price hasn't made a new high since the last check (nothing to ratchet yet).
 * stop_loss only ever moves up (toward price), matching a real trailing stop — never loosens.
 */
function computeSpotTrailingUpdate(position, currentPrice) {
  if (typeof position.trailing_percent !== 'number' || position.trailing_percent <= 0) return null;
  const priorHighWaterMark = position.trailing_high_water_mark ?? position.entry_price;
  const highWaterMark = Math.max(priorHighWaterMark, currentPrice);
  if (highWaterMark === priorHighWaterMark) return null;
  const stopLoss = highWaterMark * (1 - position.trailing_percent / 100);
  if (typeof position.stop_loss === 'number' && stopLoss <= position.stop_loss) return null;
  return { stopLoss, highWaterMark };
}

/** Same idea as computeSpotTrailingUpdate, side-aware: a long's high-water-mark rises with price
 *  (stop follows up from below), a short's falls with price (stop follows down from above). */
function computeFuturesTrailingUpdate(position, currentPrice) {
  if (typeof position.trailing_percent !== 'number' || position.trailing_percent <= 0) return null;
  const isLong = position.side === 'long';
  const priorHighWaterMark = position.trailing_high_water_mark ?? position.entry_price;
  const highWaterMark = isLong ? Math.max(priorHighWaterMark, currentPrice) : Math.min(priorHighWaterMark, currentPrice);
  if (highWaterMark === priorHighWaterMark) return null;
  const stopLoss = isLong
    ? highWaterMark * (1 - position.trailing_percent / 100)
    : highWaterMark * (1 + position.trailing_percent / 100);
  if (typeof position.stop_loss === 'number') {
    const improved = isLong ? stopLoss > position.stop_loss : stopLoss < position.stop_loss;
    if (!improved) return null;
  }
  return { stopLoss, highWaterMark };
}

function logTriggerResult(mode, market, position, reason, snapshotPrice, order) {
  const label = reason === 'stop_loss' ? 'Stop-loss' : 'Take-profit';
  logger.info(
    'position-risk-watcher',
    `${label} hit for ${position.symbol} (${market} ${mode}) at ${snapshotPrice} — close ${order.status}`,
    { positionId: position.id, userId: position.user_id, orderId: order.id, rejectReason: order.reject_reason },
    mode
  );
}

/**
 * Spot positions with no `exchange` (pre-migration rows) are skipped — no way to fetch a live
 * price for them, same convention as portfolio-service.js's getOpenPositionsWithUnrealizedPnl.
 * Positions that already have an outstanding pending exit order (a manually-placed OCO/Limit/
 * Stop-Market/Stop-Limit sell) are also skipped — that order is the authoritative, already-working
 * exit mechanism for this position (and for Real, an actual resting order on the exchange itself);
 * this watcher only needs to cover the gap where NO such order exists, not race a second close
 * attempt against one that's already in flight.
 */
async function checkSpotPositions(mode) {
  const positions = positionsRepository.listAllOpenPositions(mode);
  if (positions.length === 0) return;

  const protectedKeys = new Set(
    ordersRepository.listPendingOrders(mode)
      .filter((o) => o.side === 'sell')
      .map((o) => `${o.user_id}:${o.symbol}`)
  );

  for (const position of positions) {
    if (typeof position.stop_loss !== 'number' && typeof position.take_profit !== 'number') continue;
    if (!position.exchange) continue;
    if (protectedKeys.has(`${position.user_id}:${position.symbol}`)) continue;

    try {
      const snapshot = await marketDataService.getSnapshot({ symbol: position.symbol, exchange: position.exchange });
      if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') continue;

      const trailingUpdate = computeSpotTrailingUpdate(position, snapshot.price);
      if (trailingUpdate) {
        positionsRepository.updateTrailingStop(mode, position.user_id, position.id, trailingUpdate);
        logger.info(
          'position-risk-watcher',
          `Trailing stop for ${position.symbol} (spot ${mode}) raised to ${trailingUpdate.stopLoss} at price ${snapshot.price}`,
          { positionId: position.id, userId: position.user_id },
          mode
        );
        position.stop_loss = trailingUpdate.stopLoss; // so the trigger check below sees the ratcheted value this same cycle
        position.trailing_high_water_mark = trailingUpdate.highWaterMark;
      }

      const reason = checkSpotTrigger(position, snapshot.price);
      if (!reason) continue;

      const placeOrder = mode === 'real' ? placeRealOrder : placeDemoOrder;
      const args = { userId: position.user_id, symbol: position.symbol, exchange: position.exchange, side: 'sell' };
      if (mode === 'real') args.unlockConfirmed = true; // no human present per-trade, same convention as futures-auto-trader's source:'auto' closes

      const order = await placeOrder(args);
      logTriggerResult(mode, 'spot', position, reason, snapshot.price, order);
    } catch (err) {
      logger.error('position-risk-watcher', `Failed to check spot position ${position.id} (${position.symbol}): ${err.message}`, {}, mode);
    }
  }
}

/** Futures has no pending/OCO order concept at all (market open_long/open_short/close only — see
 *  futures-demo-orders.js), so every open futures position relies solely on this watcher; no
 *  competing exit mechanism to avoid racing against. */
async function checkFuturesPositions(mode) {
  const positions = futuresPositionsRepository.listAllOpenPositions(mode);
  if (positions.length === 0) return;

  for (const position of positions) {
    if (typeof position.stop_loss !== 'number' && typeof position.take_profit !== 'number') continue;

    try {
      const snapshot = await marketDataService.getFuturesSnapshot({ symbol: position.symbol, exchange: position.exchange });
      if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') continue;

      const trailingUpdate = computeFuturesTrailingUpdate(position, snapshot.price);
      if (trailingUpdate) {
        futuresPositionsRepository.updateTrailingStop(mode, position.user_id, position.id, trailingUpdate);
        logger.info(
          'position-risk-watcher',
          `Trailing stop for ${position.symbol} (futures ${mode}) moved to ${trailingUpdate.stopLoss} at price ${snapshot.price}`,
          { positionId: position.id, userId: position.user_id },
          mode
        );
        position.stop_loss = trailingUpdate.stopLoss; // so the trigger check below sees the ratcheted value this same cycle
        position.trailing_high_water_mark = trailingUpdate.highWaterMark;
      }

      const reason = checkFuturesTrigger(position, snapshot.price);
      if (!reason) continue;

      const placeOrder = mode === 'real' ? placeRealFuturesOrder : placeDemoFuturesOrder;
      const args = { userId: position.user_id, symbol: position.symbol, exchange: position.exchange, action: 'close', source: 'auto' };
      if (mode === 'real') args.unlockConfirmed = true;

      const order = await placeOrder(args);
      logTriggerResult(mode, 'futures', position, reason, snapshot.price, order);
    } catch (err) {
      logger.error('position-risk-watcher', `Failed to check futures position ${position.id} (${position.symbol}): ${err.message}`, {}, mode);
    }
  }
}

async function runCycle() {
  await checkSpotPositions('demo');
  await checkSpotPositions('real');
  await checkFuturesPositions('demo');
  await checkFuturesPositions('real');

  return {
    spotDemoEvaluated: positionsRepository.listAllOpenPositions('demo').length,
    spotRealEvaluated: positionsRepository.listAllOpenPositions('real').length,
    futuresDemoEvaluated: futuresPositionsRepository.listAllOpenPositions('demo').length,
    futuresRealEvaluated: futuresPositionsRepository.listAllOpenPositions('real').length,
  };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    // See auto-trader.js's identical guard: prevents overlapping cycles from piling up when a
    // cycle takes longer than the poll interval (e.g. a slow exchange).
    if (isRunning) {
      logger.warn('position-risk-watcher', 'Skipped position-risk cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('position-risk-watcher', `Position-risk cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.pendingOrdersPollIntervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('position-risk-watcher', `Position-risk watcher started (interval ${config.pendingOrdersPollIntervalMs}ms)`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function getStatus() {
  return {
    running: intervalHandle !== null,
    intervalMs: config.pendingOrdersPollIntervalMs,
  };
}

module.exports = {
  start, stop, runCycle, getStatus, checkSpotTrigger, checkFuturesTrigger,
  computeSpotTrailingUpdate, computeFuturesTrailingUpdate,
};
