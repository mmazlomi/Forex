'use strict';

const ordersRepository = require('../../database/repositories/orders-repository');
const marketDataService = require('../market-data/market-data-service');
const demoOrders = require('../orders/demo-orders');
const realOrders = require('../orders/real-orders');
const exchangeClientFactory = require('../exchanges/exchange-client-factory');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// Structural twin of auto-trader.js: same start/stop/runCycle/getStatus shape, same .unref()'d
// setInterval, started only from server.js's real boot path (never in test servers). Where
// auto-trader.js polls trading *signals*, this polls *pending orders* (Limit/Stop-Market/
// Stop-Limit/OCO) placed via the order types added alongside this module — see
// docs/architecture.md's order-types section for the full design (including the accepted OCO
// race-condition trade-off this module's sibling-cancel step is built around).

let intervalHandle = null;
let isRunning = false;

/**
 * Whether a pending order's limit/trigger condition is met at `currentPrice`, and the price it
 * should fill at if so. Direction is side-aware: a BUY limit fills at-or-below its price (buying
 * cheap), a SELL limit (a take-profit exit) fills at-or-above (selling high); a BUY stop-market
 * (a breakout entry) triggers on price rising through it, a SELL stop-market (a stop-loss exit)
 * triggers on price falling through it — get this backwards and a stop-loss becomes untriggerable.
 *
 * stop_limit's "triggered but not yet filled" sub-state needs no extra column: the trigger check
 * is monotonic (price crossing a fixed trigger_price doesn't un-cross), so re-checking "has the
 * trigger condition been met" every cycle and then immediately applying the limit check in the
 * same pass is correct and idempotent — equivalent to remembering trigger state explicitly.
 */
function checkFillCondition(order, currentPrice) {
  const isBuy = order.side === 'buy';

  if (order.order_type === 'limit') {
    const met = isBuy ? currentPrice <= order.limit_price : currentPrice >= order.limit_price;
    return met ? { shouldFill: true, fillPrice: order.limit_price } : { shouldFill: false };
  }

  if (order.order_type === 'stop_market') {
    const triggered = isBuy ? currentPrice >= order.trigger_price : currentPrice <= order.trigger_price;
    // Once triggered, a stop-market becomes a market order — fills at the current price, not the
    // trigger price (the trigger is where it *activates*, not where it necessarily fills).
    return triggered ? { shouldFill: true, fillPrice: currentPrice } : { shouldFill: false };
  }

  if (order.order_type === 'stop_limit') {
    const triggered = isBuy ? currentPrice >= order.trigger_price : currentPrice <= order.trigger_price;
    if (!triggered) return { shouldFill: false };
    const limitMet = isBuy ? currentPrice <= order.limit_price : currentPrice >= order.limit_price;
    return limitMet ? { shouldFill: true, fillPrice: order.limit_price } : { shouldFill: false };
  }

  return { shouldFill: false };
}

async function cancelOcoSiblingIfAny(mode, order) {
  if (!order.oco_group_id) return;
  const sibling = ordersRepository.findOcoSibling(mode, order.user_id, order.oco_group_id, order.id);
  if (!sibling) return; // no sibling, or it already resolved (filled/cancelled) — idempotent no-op
  if (mode === 'demo') {
    demoOrders.cancelDemoOrder(sibling);
  } else {
    // Actually cancels on the exchange (cancelRealOrder), not just marked locally — the sibling
    // is a real, live order sitting on the exchange's own order book. If the exchange reports it
    // was already filled (the accepted OCO race case — both legs triggered before the cancel
    // landed), cancelRealOrder logs a warning and still reconciles our row rather than throwing.
    await realOrders.cancelRealOrder(sibling);
  }
  logger.info('pending-orders-watcher', `Cancelled OCO sibling ${sibling.id} for ${order.symbol} (${order.id} filled first)`, {}, mode);
}

async function processDemoPendingOrder(order) {
  const snapshot = await marketDataService.getSnapshot({ symbol: order.symbol, exchange: order.exchange });
  if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
    // Transient market-data failure — leave the order pending, try again next cycle. Not an
    // error worth logging loudly every 30s; debug-level is enough.
    logger.debug('pending-orders-watcher', `Could not fetch a price for pending order ${order.id} (${order.symbol}): ${snapshot.error || snapshot.status}`, {}, 'demo');
    return;
  }

  const { shouldFill, fillPrice } = checkFillCondition(order, snapshot.price);
  if (!shouldFill) return;

  if (order.side === 'buy') {
    demoOrders.finalizeDemoBuyFill(order, fillPrice);
  } else {
    demoOrders.finalizeDemoSellFill(order, fillPrice);
  }
  await cancelOcoSiblingIfAny('demo', order);
}

/**
 * Real orders are never re-evaluated against price ourselves — the exchange is authoritative for
 * triggering/filling a real Limit/Stop order (see checkOrderTypeSupported's comment in
 * real-orders.js and the design decision behind it). This only asks the exchange what happened.
 * ccxt's unified status vocabulary: 'closed' = fully filled; 'open' = still resting, whether
 * completely unfilled or partially filled — either way stays 'pending' here, matching this app's
 * existing "no partial-fill handling, resolving means fully filled" convention (already the rule
 * for the Nobitex adapter's market orders); 'canceled'/'expired'/'rejected' = no fill happened,
 * reconcile our row without ever opening/closing a position for it.
 */
async function processRealPendingOrder(order) {
  const client = exchangeClientFactory.getRealExchange(order.user_id);
  const exchangeOrder = await client.fetchOrder(order.exchange_order_id, order.symbol);

  if (exchangeOrder.status === 'open') return; // unfilled or partial — no action, check again next cycle

  if (exchangeOrder.status === 'closed') {
    const fillPrice = exchangeOrder.average ?? exchangeOrder.price ?? order.price;
    if (order.side === 'buy') {
      realOrders.finalizeRealBuyFill(order, fillPrice, exchangeOrder);
    } else {
      realOrders.finalizeRealSellFill(order, fillPrice, exchangeOrder);
    }
    await cancelOcoSiblingIfAny('real', order);
    return;
  }

  // 'canceled' / 'expired' / 'rejected' (or anything else ccxt might report) — the exchange never
  // filled it. No position change; just reconcile our row so it stops showing as pending.
  ordersRepository.updateOrderStatus('real', order.user_id, order.id, { status: 'cancelled', cancelledAtUtc: new Date().toISOString(), exchangeOrderId: order.exchange_order_id });
}

async function runCycle() {
  const demoPending = ordersRepository.listPendingOrders('demo');
  for (const order of demoPending) {
    try {
      await processDemoPendingOrder(order);
    } catch (err) {
      logger.error('pending-orders-watcher', `Failed to process pending demo order ${order.id} (${order.symbol}): ${err.message}`, {}, 'demo');
    }
  }

  const realPending = ordersRepository.listPendingOrders('real');
  for (const order of realPending) {
    try {
      await processRealPendingOrder(order);
    } catch (err) {
      logger.error('pending-orders-watcher', `Failed to process pending real order ${order.id} (${order.symbol}): ${err.message}`, {}, 'real');
    }
  }

  return { demoEvaluated: demoPending.length, realEvaluated: realPending.length };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    // See auto-trader.js's identical guard: prevents overlapping cycles from piling up when a
    // cycle takes longer than the poll interval (e.g. a slow exchange).
    if (isRunning) {
      logger.warn('pending-orders-watcher', 'Skipped pending-orders cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('pending-orders-watcher', `Pending-orders cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.pendingOrdersPollIntervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('pending-orders-watcher', `Pending-orders watcher started (interval ${config.pendingOrdersPollIntervalMs}ms)`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function getStatus() {
  return {
    running: intervalHandle !== null,
    intervalMs: config.pendingOrdersPollIntervalMs,
    pendingDemoCount: ordersRepository.listPendingOrders('demo').length,
    pendingRealCount: ordersRepository.listPendingOrders('real').length,
  };
}

module.exports = { start, stop, runCycle, getStatus, checkFillCondition };
