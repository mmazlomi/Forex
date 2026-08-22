'use strict';

const positionsRepository = require('../../database/repositories/positions-repository');
const futuresPositionsRepository = require('../../database/repositories/futures-positions-repository');
const ordersRepository = require('../../database/repositories/orders-repository');
const marketDataService = require('../market-data/market-data-service');
const { placeDemoOrder, placeDemoPartialClose } = require('../orders/demo-orders');
const { placeRealOrder, placeRealPartialClose } = require('../orders/real-orders');
const { placeDemoFuturesOrder, placeDemoFuturesPartialClose } = require('../orders/futures-demo-orders');
const { placeRealFuturesOrder, placeRealFuturesPartialClose } = require('../orders/futures-real-orders');
// Accessed via namespace object below (atrTrailing.resolveAtrTrailingPercent(...)), not
// destructured — same t.mock.method(moduleObject, 'fn', ...) convention as every other module in
// this codebase that gets mocked in tests.
const atrTrailing = require('../risk/atr-trailing');
const technicalAnalysis = require('../technical-analysis');
const technicalScorer = require('../signals/technical-scorer');
const { computeRealizedR } = require('../risk/realized-r');
const logger = require('../logging/logger');
const config = require('../../../config/config');

// A live technicalScore (see technical-scorer.js, range [-1,+1]) at or beyond this magnitude,
// opposing the position's direction, counts as a fired 'reversal_signal' condition — see
// checkReversalExit below. 0.5 mirrors the same "strong" bar technical-scorer.js's own individual
// indicator scorers use for a decisive (non-neutral) reading, not an arbitrary new number.
const REVERSAL_SIGNAL_SCORE_THRESHOLD = 0.5;

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
  // An adaptive-TP position's take_profit column holds TP3 (the final tier) purely as a display/
  // fallback ceiling — checkAdaptiveTpTriggers is what actually closes it, tier by tier, via
  // handleAdaptiveSpotPosition below. Skipping this check for adaptive positions avoids a
  // same-price double-fire race between the two mechanisms.
  if (!position.adaptive_tp_enabled && typeof position.take_profit === 'number' && currentPrice >= position.take_profit) return 'take_profit';
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
  // See checkSpotTrigger's identical comment — adaptive positions are closed tier-by-tier by
  // checkAdaptiveTpTriggers/handleAdaptiveFuturesPosition instead.
  if (!position.adaptive_tp_enabled && typeof position.take_profit === 'number') {
    const takeHit = isLong ? currentPrice >= position.take_profit : currentPrice <= position.take_profit;
    if (takeHit) return 'take_profit';
  }
  return null;
}

/** Spot's side is always 'buy'; futures' is 'long'/'short' — same normalization convention as
 *  adaptive-take-profit-engine.js#normalizeSide, duplicated (not imported) since it's a one-line
 *  pure mapping and this file otherwise has no dependency on that engine module. */
function normalizeAdaptiveSide(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'long' || s === 'buy') return 'long';
  if (s === 'short' || s === 'sell') return 'short';
  return null;
}

/**
 * Pure: returns every TP tier (1/2/3) whose stored price is crossed by currentPrice AND hasn't
 * already fired (tpN_filled_at_utc IS NULL), in tier order. Deliberately returns every qualifying
 * tier in one call rather than just the first — a 30s poll gap can let price gap straight through
 * two or three tiers between cycles, and all of them must still fire (in order), not just the one
 * closest to current price.
 */
function checkAdaptiveTpTriggers(position, currentPrice) {
  const side = normalizeAdaptiveSide(position.side);
  if (!side) return [];
  const fired = [];
  for (const level of [1, 2, 3]) {
    const targetPrice = position[`tp${level}_price`];
    if (typeof targetPrice !== 'number') continue;
    if (position[`tp${level}_filled_at_utc`]) continue;
    const hit = side === 'long' ? currentPrice >= targetPrice : currentPrice <= targetPrice;
    if (hit) fired.push({ level, price: targetPrice, qtyPercent: position[`tp${level}_qty_percent`] });
  }
  return fired;
}

/**
 * Pure: checks a position's stored exit_reversal_conditions_json (computeAdaptiveTargets' output
 * at entry — see adaptive-take-profit-engine.js#buildReversalConditions) against live data.
 * 'structure_break' fires on price alone (no fresh fetch needed — the level was fixed at entry).
 * 'reversal_signal' needs `freshIndicators` (a fresh technical-analysis#computeAllIndicators
 * result, the one part of this check that costs a live candle fetch — see
 * checkSpotPositions/checkFuturesPositions' callers) to compute a live technicalScore; null/absent
 * freshIndicators simply skips that condition rather than throwing, consistent with every other
 * "missing data disables this check, never blocks the position" convention in this file. Returns
 * the fired condition, or null if nothing fired (including when reversal-exit wasn't enabled for
 * this position at all — an empty/missing exit_reversal_conditions_json).
 */
function checkReversalExit(position, currentPrice, freshIndicators) {
  if (!position.exit_reversal_conditions_json) return null;
  let conditions;
  try {
    conditions = JSON.parse(position.exit_reversal_conditions_json);
  } catch {
    return null;
  }
  if (!Array.isArray(conditions) || conditions.length === 0) return null;

  const side = normalizeAdaptiveSide(position.side);
  if (!side) return null;

  for (const condition of conditions) {
    if (condition.type === 'structure_break' && typeof condition.level === 'number') {
      const broke = side === 'long' ? currentPrice < condition.level : currentPrice > condition.level;
      if (broke) return condition;
    }
    if (condition.type === 'reversal_signal' && freshIndicators) {
      const { technicalScore } = technicalScorer.computeTechnicalScore(freshIndicators, currentPrice);
      if (typeof technicalScore === 'number') {
        const opposes = side === 'long'
          ? technicalScore <= -REVERSAL_SIGNAL_SCORE_THRESHOLD
          : technicalScore >= REVERSAL_SIGNAL_SCORE_THRESHOLD;
        if (opposes) return { ...condition, technicalScore };
      }
    }
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

/** Fetches fresh candles + runs every indicator, for checkReversalExit's 'reversal_signal'
 *  condition — the one adaptive-TP check that needs live technical data, not just live price
 *  (same per-cycle-fetch cost pattern as atr-trailing.js's own candle fetch). Returns null (never
 *  throws) on any failure, same fail-open convention as every other live-data lookup in this file
 *  — a network hiccup disables this one condition for this cycle, it never blocks the position. */
async function fetchFreshIndicatorsForReversalCheck({ symbol, exchange, market, timeframe }) {
  try {
    const candles = await marketDataService.getCandles({ symbol, exchange, timeframe: timeframe || '1h', limit: 100, market });
    return technicalAnalysis.computeAllIndicators(candles);
  } catch {
    return null;
  }
}

/** Once TP1 fires, seeds trailing_percent (ATR × the position's own recommended_trailing_multiplier
 *  — see adaptive-take-profit-engine.js#computeAdaptiveTargets) so the existing
 *  computeSpotTrailingUpdate/computeFuturesTrailingUpdate machinery starts ratcheting from here on,
 *  completely unchanged. A no-op if trailing_percent is already set (seeded on an earlier cycle, or
 *  the asset already had one some other way) — never overwrites an in-progress trail. */
async function seedAdaptiveTrailing(mode, market, position, currentPrice) {
  if (position.trailing_percent != null) return null;
  const multiplier = typeof position.recommended_trailing_multiplier === 'number'
    ? position.recommended_trailing_multiplier
    : atrTrailing.ATR_MULTIPLIER;
  const percent = await atrTrailing.resolveAtrTrailingPercent({
    symbol: position.symbol, exchange: position.exchange, market, timeframe: position.timeframe, atrMultiplier: multiplier,
  });
  if (percent == null) return null;
  const repo = market === 'futures' ? futuresPositionsRepository : positionsRepository;
  return repo.seedTrailingPercent(mode, position.user_id, position.id, { trailingPercent: percent, highWaterMark: currentPrice });
}

// Dedicated 'adaptive-tp' source tag (separate from the generic 'position-risk-watcher' logs
// already written above for every trigger/trailing event) so partial fills, trailing seeds, and
// final exits of an adaptive position are independently filterable in the Logs tab — see Stage G
// of the adaptive-take-profit build-out. adaptive-take-profit-resolver.js writes the matching
// "entry" log at position-open time.

function logAdaptivePartialFill(mode, market, position, tier, order) {
  logger.info(
    'adaptive-tp',
    `TP${tier.level} partial fill for ${position.symbol} (${market} ${mode}): closed ${order.qty} at ${order.price}, leg P&L ${order.realized_pnl}`,
    { positionId: position.id, userId: position.user_id, orderId: order.id, level: tier.level, qty: order.qty, price: order.price, legPnl: order.realized_pnl },
    mode
  );
}

function logAdaptiveFinalExit(mode, market, position, order, reasonLabel) {
  const realizedR = computeRealizedR(order.realized_pnl, position.r_multiple, position.initial_qty);
  logger.info(
    'adaptive-tp',
    `Final exit (${reasonLabel}) for ${position.symbol} (${market} ${mode}): total realized P&L ${order.realized_pnl}${realizedR != null ? ` (${realizedR.toFixed(2)}R)` : ''}`,
    { positionId: position.id, userId: position.user_id, orderId: order.id, realizedPnl: order.realized_pnl, realizedR },
    mode
  );
}

function logAdaptiveTrailingSeed(mode, market, position, seeded) {
  logger.info(
    'adaptive-tp',
    `Trailing seeded for ${position.symbol} (${market} ${mode}) after TP1: ${seeded.trailing_percent.toFixed(2)}% distance from high-water-mark ${seeded.trailing_high_water_mark}`,
    { positionId: position.id, userId: position.user_id, trailingPercent: seeded.trailing_percent, highWaterMark: seeded.trailing_high_water_mark },
    mode
  );
}

/**
 * Adaptive-TP orchestration for one spot position, called before the classic trailing/trigger
 * checks below. Fires every TP tier the price has crossed (in order — see checkAdaptiveTpTriggers),
 * then checks for a reversal exit, then seeds trailing once TP1 has fired. Mutates `position` in
 * place with the latest DB row after every step, so the caller's subsequent (unchanged) trailing/
 * stop-loss logic always sees current data. Returns true if the position is now fully closed (the
 * caller should stop processing it this cycle), false if it's still open.
 */
async function handleAdaptiveSpotPosition(mode, position, currentPrice) {
  const placePartialClose = mode === 'real' ? placeRealPartialClose : placeDemoPartialClose;

  for (const tier of checkAdaptiveTpTriggers(position, currentPrice)) {
    const initialQty = position.initial_qty ?? position.qty;
    const closeQty = initialQty * ((tier.qtyPercent ?? 0) / 100);
    if (!(closeQty > 0)) continue;

    const args = { userId: position.user_id, symbol: position.symbol, exchange: position.exchange, level: tier.level, closeQty, reason: 'take_profit' };
    if (mode === 'real') args.unlockConfirmed = true; // no human present per-trade, same convention as position-risk-watcher's existing real closes
    const order = await placePartialClose(args);
    logger.info(
      'position-risk-watcher',
      `Adaptive TP${tier.level} hit for ${position.symbol} (spot ${mode}) at ${currentPrice} — partial close ${order.status}`,
      { positionId: position.id, userId: position.user_id, orderId: order.id, rejectReason: order.reject_reason },
      mode
    );

    const reloaded = positionsRepository.getPosition(mode, position.user_id, position.id);
    const stillOpen = !!(reloaded && reloaded.status === 'open');
    if (reloaded) Object.assign(position, reloaded);

    if (order.status === 'filled') {
      if (stillOpen) logAdaptivePartialFill(mode, 'spot', position, tier, order);
      else logAdaptiveFinalExit(mode, 'spot', position, order, `TP${tier.level}`);
    }
    if (!stillOpen) return true;
  }

  if (position.exit_reversal_conditions_json) {
    const freshIndicators = await fetchFreshIndicatorsForReversalCheck({ symbol: position.symbol, exchange: position.exchange, market: 'spot', timeframe: position.timeframe });
    const firedCondition = checkReversalExit(position, currentPrice, freshIndicators);
    if (firedCondition) {
      const placeOrder = mode === 'real' ? placeRealOrder : placeDemoOrder;
      const args = { userId: position.user_id, symbol: position.symbol, exchange: position.exchange, side: 'sell', reason: 'reversal' };
      if (mode === 'real') args.unlockConfirmed = true;
      const order = await placeOrder(args);
      logger.info(
        'position-risk-watcher',
        `Reversal exit for ${position.symbol} (spot ${mode}) at ${currentPrice}: ${firedCondition.description || firedCondition.type} — close ${order.status}`,
        { positionId: position.id, userId: position.user_id, orderId: order.id },
        mode
      );
      const reloaded = positionsRepository.getPosition(mode, position.user_id, position.id);
      if (reloaded) Object.assign(position, reloaded);
      if (order.status === 'filled') logAdaptiveFinalExit(mode, 'spot', position, order, 'reversal');
      return true;
    }
  }

  if (position.tp1_filled_at_utc && position.trailing_percent == null) {
    const seeded = await seedAdaptiveTrailing(mode, 'spot', position, currentPrice);
    if (seeded) {
      Object.assign(position, seeded);
      logAdaptiveTrailingSeed(mode, 'spot', position, seeded);
    }
  }

  return false;
}

/** Futures twin of handleAdaptiveSpotPosition — see that function's doc comment for the full
 *  contract. Differs only in which repository/order-service functions it calls. */
async function handleAdaptiveFuturesPosition(mode, position, currentPrice) {
  const placePartialClose = mode === 'real' ? placeRealFuturesPartialClose : placeDemoFuturesPartialClose;

  for (const tier of checkAdaptiveTpTriggers(position, currentPrice)) {
    const initialQty = position.initial_qty ?? position.qty;
    const closeQty = initialQty * ((tier.qtyPercent ?? 0) / 100);
    if (!(closeQty > 0)) continue;

    const args = { userId: position.user_id, symbol: position.symbol, exchange: position.exchange, level: tier.level, closeQty, reason: 'take_profit' };
    if (mode === 'real') args.unlockConfirmed = true;
    const order = await placePartialClose(args);
    logger.info(
      'position-risk-watcher',
      `Adaptive TP${tier.level} hit for ${position.symbol} (futures ${mode}) at ${currentPrice} — partial close ${order.status}`,
      { positionId: position.id, userId: position.user_id, orderId: order.id, rejectReason: order.reject_reason },
      mode
    );

    const reloaded = futuresPositionsRepository.getPosition(mode, position.user_id, position.id);
    const stillOpen = !!(reloaded && reloaded.status === 'open');
    if (reloaded) Object.assign(position, reloaded);

    if (order.status === 'filled') {
      if (stillOpen) logAdaptivePartialFill(mode, 'futures', position, tier, order);
      else logAdaptiveFinalExit(mode, 'futures', position, order, `TP${tier.level}`);
    }
    if (!stillOpen) return true;
  }

  if (position.exit_reversal_conditions_json) {
    const freshIndicators = await fetchFreshIndicatorsForReversalCheck({ symbol: position.symbol, exchange: position.exchange, market: 'futures', timeframe: position.timeframe });
    const firedCondition = checkReversalExit(position, currentPrice, freshIndicators);
    if (firedCondition) {
      const placeOrder = mode === 'real' ? placeRealFuturesOrder : placeDemoFuturesOrder;
      const args = { userId: position.user_id, symbol: position.symbol, exchange: position.exchange, action: 'close', source: 'auto', reason: 'reversal' };
      if (mode === 'real') args.unlockConfirmed = true;
      const order = await placeOrder(args);
      logger.info(
        'position-risk-watcher',
        `Reversal exit for ${position.symbol} (futures ${mode}) at ${currentPrice}: ${firedCondition.description || firedCondition.type} — close ${order.status}`,
        { positionId: position.id, userId: position.user_id, orderId: order.id },
        mode
      );
      const reloaded = futuresPositionsRepository.getPosition(mode, position.user_id, position.id);
      if (reloaded) Object.assign(position, reloaded);
      if (order.status === 'filled') logAdaptiveFinalExit(mode, 'futures', position, order, 'reversal');
      return true;
    }
  }

  if (position.tp1_filled_at_utc && position.trailing_percent == null) {
    const seeded = await seedAdaptiveTrailing(mode, 'futures', position, currentPrice);
    if (seeded) {
      Object.assign(position, seeded);
      logAdaptiveTrailingSeed(mode, 'futures', position, seeded);
    }
  }

  return false;
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
    if (typeof position.stop_loss !== 'number' && typeof position.take_profit !== 'number' && !position.adaptive_tp_enabled) continue;
    if (!position.exchange) continue;
    if (protectedKeys.has(`${position.user_id}:${position.symbol}`)) continue;

    try {
      const snapshot = await marketDataService.getSnapshot({ symbol: position.symbol, exchange: position.exchange });
      if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') continue;

      if (position.adaptive_tp_enabled) {
        const closed = await handleAdaptiveSpotPosition(mode, position, snapshot.price);
        if (closed) continue;
      }

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
      const args = { userId: position.user_id, symbol: position.symbol, exchange: position.exchange, side: 'sell', reason };
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
    if (typeof position.stop_loss !== 'number' && typeof position.take_profit !== 'number' && !position.adaptive_tp_enabled) continue;

    try {
      const snapshot = await marketDataService.getFuturesSnapshot({ symbol: position.symbol, exchange: position.exchange });
      if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') continue;

      if (position.adaptive_tp_enabled) {
        const closed = await handleAdaptiveFuturesPosition(mode, position, snapshot.price);
        if (closed) continue;
      }

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
      const args = { userId: position.user_id, symbol: position.symbol, exchange: position.exchange, action: 'close', source: 'auto', reason };
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
  checkAdaptiveTpTriggers, checkReversalExit,
};
