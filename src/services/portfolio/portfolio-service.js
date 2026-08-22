'use strict';

const portfolioRepository = require('../../database/repositories/portfolio-repository');
const positionsRepository = require('../../database/repositories/positions-repository');
const marketDataService = require('../market-data/market-data-service');
const logger = require('../logging/logger');
const config = require('../../../config/config');
const { resolvePositionStrategy } = require('../signals/resolve-position-strategy');
const { describeStrategyIds } = require('../signals/strategies');

function startOfTodayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Notional exposure = sum of entry_price × qty for all of this user's currently-open positions. */
function getExposureValue(mode, userId) {
  return positionsRepository
    .listOpenPositions(mode, userId)
    .reduce((sum, p) => sum + p.entry_price * p.qty, 0);
}

/** Realized loss since UTC midnight for this user, expressed as a positive number (0 if net profitable today). */
function getDailyLossSoFar(mode, userId) {
  const totalPnl = positionsRepository.sumRealizedPnlSince(mode, userId, startOfTodayUtc());
  return totalPnl < 0 ? Math.abs(totalPnl) : 0;
}

function getSnapshot(mode, userId) {
  const portfolio = portfolioRepository.ensureInitialized(
    mode,
    userId,
    mode === 'demo' ? config.initialDemoBalance : 0
  );
  const openPositions = positionsRepository.listOpenPositions(mode, userId);
  const exposureValue = getExposureValue(mode, userId);
  const dailyLossSoFar = getDailyLossSoFar(mode, userId);

  // wallet_balances_json only exists on real_portfolio (demo is a single simulated currency, not
  // a live exchange wallet) and is only ever populated by an explicit balance sync — parsed here
  // so switching to the Real tab shows the last-synced breakdown immediately, without forcing a
  // fresh live exchange call on every view.
  let walletBalances = [];
  if (portfolio.wallet_balances_json) {
    try {
      walletBalances = JSON.parse(portfolio.wallet_balances_json);
    } catch {
      walletBalances = [];
    }
  }

  return {
    mode,
    balance: portfolio.balance,
    walletBalances,
    openPositions,
    exposureValue,
    exposurePercent: portfolio.balance > 0 ? (exposureValue / portfolio.balance) * 100 : 0,
    availableBalance: portfolio.balance - exposureValue,
    dailyLossSoFar,
    updatedAtUtc: portfolio.updated_at_utc,
  };
}

/** Opens a new position for this user and debits nothing from balance directly — balance already
 *  reflects cash; exposure is derived from open positions, not a separate ledger entry. signalId
 *  identifies which signal (if any) triggered this open; the strategy/timeframe fields are
 *  normally resolved server-side from the signal itself (see resolvePositionStrategy) rather than
 *  trusted from the caller. `strategyId`/`timeframe` are explicit overrides for callers with no
 *  signals-table row to look up — see futures-portfolio-service.js's identical params for the
 *  full explanation (Liquidity Sweep Reversal's schedulers). Spot has no manual/auto `source`
 *  concept (unlike futures) — always recorded 'manual'. `trailingPercent` (percent of price, e.g.
 *  2 for 2%) opts this position into position-risk-watcher.js's trailing-stop ratchet; the
 *  high-water-mark it trails against starts at entryPrice — spot is long-only, so it only ever
 *  moves up, moving stop_loss up with it (never down) as price rises. `adaptiveTp` is optional and
 *  omitted for every non-opted-in caller (see schema.js#migrateAddAdaptiveTakeProfitColumns) — when
 *  present it carries computeAdaptiveTargets' output (tp1/2/3 price+qty%, entry ATR/R-multiple/
 *  context, recommended trailing multiplier, reversal-exit conditions) straight through to the new
 *  position-risk-watcher.js#checkAdaptiveTpTriggers machinery. */
function openPosition(mode, userId, { symbol, exchange, side, qty, entryPrice, stopLoss, takeProfit, signalId, strategyId: explicitStrategyId, timeframe: explicitTimeframe, trailingPercent, adaptiveTp }) {
  const resolved = resolvePositionStrategy(signalId);
  const strategyId = explicitStrategyId ?? resolved.strategyId;
  const timeframe = explicitTimeframe ?? resolved.timeframe;
  const { combinedStrategyIdsJson, combinedVotesJson } = resolved;
  const hasTrailing = typeof trailingPercent === 'number' && trailingPercent > 0;
  return positionsRepository.insertPosition(mode, userId, {
    symbol,
    exchange: exchange ?? null,
    side,
    qty,
    entryPrice,
    stopLoss: stopLoss ?? null,
    takeProfit: takeProfit ?? null,
    openedAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
    strategyId,
    combinedStrategyIdsJson,
    combinedVotesJson,
    timeframe,
    trailingPercent: hasTrailing ? trailingPercent : null,
    trailingHighWaterMark: hasTrailing ? entryPrice : null,
    ...(adaptiveTp ? {
      adaptiveTpEnabled: 1,
      entryAtr: adaptiveTp.entryAtr ?? null,
      rMultiple: adaptiveTp.rMultiple ?? null,
      entryContextJson: adaptiveTp.entryContextJson ?? null,
      tp1Price: adaptiveTp.tp1Price ?? null,
      tp2Price: adaptiveTp.tp2Price ?? null,
      tp3Price: adaptiveTp.tp3Price ?? null,
      tp1QtyPercent: adaptiveTp.tp1QtyPercent ?? null,
      tp2QtyPercent: adaptiveTp.tp2QtyPercent ?? null,
      tp3QtyPercent: adaptiveTp.tp3QtyPercent ?? null,
      recommendedTrailingMultiplier: adaptiveTp.recommendedTrailingMultiplier ?? null,
      exitReversalConditionsJson: adaptiveTp.exitReversalConditionsJson ?? null,
    } : {}),
  });
}

/** Closes this user's open position at exitPrice, realizing P&L and crediting/debiting their cash
 *  balance. exitReason ('stop_loss' | 'take_profit' | 'signal' | 'manual') records why, for the
 *  trade-history display — see positions-repository.js#closePosition. This is always the FINAL
 *  leg: `position.qty` is remaining qty (full qty for a never-partially-filled position, whatever
 *  is left after 0+ recordPartialExit calls for an adaptive one), so the direction/exitPrice math
 *  below already yields exactly this leg's P&L. The row's `realized_pnl` ends up as
 *  realized_pnl_partial_sum (every prior leg) + this leg — the balance credit, however, is only
 *  this leg's P&L, since each prior partial leg already credited its own P&L when it fired (see
 *  the order services' partial-close paths). A non-adaptive position has
 *  realized_pnl_partial_sum = 0, so this is byte-identical to the pre-partial-exit behavior. */
function closePosition(mode, userId, positionId, exitPrice, exitReason = 'manual') {
  const position = positionsRepository.getPosition(mode, userId, positionId);
  if (!position || position.status !== 'open') {
    throw new Error(`No open position ${positionId} in mode "${mode}" for this user`);
  }
  const direction = position.side === 'buy' ? 1 : -1;
  const finalLegPnl = direction * (exitPrice - position.entry_price) * position.qty;
  const realizedPnl = (position.realized_pnl_partial_sum || 0) + finalLegPnl;

  // Defensive, not just relying on callers having read the portfolio first (which the
  // order-placement risk pipeline always does, but this function shouldn't assume that) —
  // ensureInitialized returns the existing row untouched if one is already there.
  const portfolio = portfolioRepository.ensureInitialized(mode, userId, mode === 'demo' ? config.initialDemoBalance : 0);
  portfolioRepository.setBalance(mode, userId, portfolio.balance + finalLegPnl);

  return { ...positionsRepository.closePosition(mode, userId, positionId, { exitPrice, realizedPnl, exitReason }), realizedPnl };
}

/**
 * Fires one TP tier (1/2/3) of an adaptive-TP position for `qty` (always a slice of initial_qty,
 * never the remaining qty — see schema.js#migrateAddAdaptiveTakeProfitColumns) at exitPrice,
 * crediting/debiting cash for just this leg's P&L and persisting it via
 * positionsRepository.recordPartialExit (which does the remaining-qty/running-sum bookkeeping —
 * kept mechanical there, same "arithmetic lives in the service, not the repository" split as
 * closePosition above). Used by the order services' partial-close paths (Stage D); never called
 * for the position's final leg — that's still closePosition.
 */
function partialClosePosition(mode, userId, positionId, { level, qty, exitPrice, feePercent = null }) {
  const position = positionsRepository.getPosition(mode, userId, positionId);
  if (!position || position.status !== 'open') {
    throw new Error(`No open position ${positionId} in mode "${mode}" for this user`);
  }
  const direction = position.side === 'buy' ? 1 : -1;
  const pnl = direction * (exitPrice - position.entry_price) * qty;

  const portfolio = portfolioRepository.ensureInitialized(mode, userId, mode === 'demo' ? config.initialDemoBalance : 0);
  portfolioRepository.setBalance(mode, userId, portfolio.balance + pnl);

  const updated = positionsRepository.recordPartialExit(mode, userId, positionId, {
    level, qty, price: exitPrice, pnl, feePercent, closedAtUtc: new Date().toISOString(),
  });
  return { ...updated, pnl };
}

/**
 * Realized P&L summary (all-time) for this user — pure DB aggregation, no network calls.
 * Deliberately kept separate from getSnapshot(), which the order-placement risk pipeline calls on
 * every single order; adding per-position live-price lookups there would slow down and add a new
 * network failure mode to every order attempt, for data only the UI needs.
 */
function getPnlSummary(mode, userId) {
  const totalRealizedPnl = positionsRepository.sumAllRealizedPnl(mode, userId);
  const { winCount, lossCount } = positionsRepository.countClosedByOutcome(mode, userId);
  const totalClosed = winCount + lossCount;
  return {
    totalRealizedPnl,
    winCount,
    lossCount,
    winRatePercent: totalClosed > 0 ? (winCount / totalClosed) * 100 : 0,
  };
}

/**
 * This user's open positions enriched with a live current price and unrealized P&L, for display
 * only. Makes one network call per open position (typically few) — never called from the order
 * placement path. A position with no stored `exchange` (pre-migration rows) or a failed price
 * lookup still returns with `currentPrice`/`unrealizedPnl` as null rather than failing the
 * whole request.
 */
async function getOpenPositionsWithUnrealizedPnl(mode, userId) {
  const openPositions = positionsRepository.listOpenPositions(mode, userId);
  return Promise.all(
    openPositions.map(async (position) => {
      // Human-readable name(s) for the strategy/strategies that opened this position — see
      // futures-portfolio-service.js's identical enrichment for the full explanation.
      const strategies = describeStrategyIds(position.strategy_id, position.combined_strategy_ids_json);
      if (!position.exchange) {
        return { ...position, strategies, currentPrice: null, unrealizedPnl: null };
      }
      try {
        const snapshot = await marketDataService.getSnapshot({ symbol: position.symbol, exchange: position.exchange });
        if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
          return { ...position, strategies, currentPrice: null, unrealizedPnl: null };
        }
        const direction = position.side === 'buy' ? 1 : -1;
        const unrealizedPnl = direction * (snapshot.price - position.entry_price) * position.qty;
        return { ...position, strategies, currentPrice: snapshot.price, unrealizedPnl };
      } catch (err) {
        logger.warn('portfolio', `Failed to fetch live price for unrealized P&L on ${position.symbol}: ${err.message}`, {}, mode);
        return { ...position, strategies, currentPrice: null, unrealizedPnl: null };
      }
    })
  );
}

module.exports = {
  getSnapshot,
  getExposureValue,
  getDailyLossSoFar,
  openPosition,
  closePosition,
  partialClosePosition,
  getPnlSummary,
  getOpenPositionsWithUnrealizedPnl,
};
