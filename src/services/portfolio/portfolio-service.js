'use strict';

const portfolioRepository = require('../../database/repositories/portfolio-repository');
const positionsRepository = require('../../database/repositories/positions-repository');
const marketDataService = require('../market-data/market-data-service');
const logger = require('../logging/logger');
const config = require('../../../config/config');

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
 *  reflects cash; exposure is derived from open positions, not a separate ledger entry. */
function openPosition(mode, userId, { symbol, exchange, side, qty, entryPrice, stopLoss, takeProfit }) {
  return positionsRepository.insertPosition(mode, userId, {
    symbol,
    exchange: exchange ?? null,
    side,
    qty,
    entryPrice,
    stopLoss: stopLoss ?? null,
    takeProfit: takeProfit ?? null,
    openedAtUtc: new Date().toISOString(),
  });
}

/** Closes this user's open position at exitPrice, realizing P&L and crediting/debiting their cash balance. */
function closePosition(mode, userId, positionId, exitPrice) {
  const position = positionsRepository.getPosition(mode, userId, positionId);
  if (!position || position.status !== 'open') {
    throw new Error(`No open position ${positionId} in mode "${mode}" for this user`);
  }
  const direction = position.side === 'buy' ? 1 : -1;
  const realizedPnl = direction * (exitPrice - position.entry_price) * position.qty;

  // Defensive, not just relying on callers having read the portfolio first (which the
  // order-placement risk pipeline always does, but this function shouldn't assume that) —
  // ensureInitialized returns the existing row untouched if one is already there.
  const portfolio = portfolioRepository.ensureInitialized(mode, userId, mode === 'demo' ? config.initialDemoBalance : 0);
  portfolioRepository.setBalance(mode, userId, portfolio.balance + realizedPnl);

  return { ...positionsRepository.closePosition(mode, userId, positionId, { exitPrice, realizedPnl }), realizedPnl };
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
      if (!position.exchange) {
        return { ...position, currentPrice: null, unrealizedPnl: null };
      }
      try {
        const snapshot = await marketDataService.getSnapshot({ symbol: position.symbol, exchange: position.exchange });
        if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
          return { ...position, currentPrice: null, unrealizedPnl: null };
        }
        const direction = position.side === 'buy' ? 1 : -1;
        const unrealizedPnl = direction * (snapshot.price - position.entry_price) * position.qty;
        return { ...position, currentPrice: snapshot.price, unrealizedPnl };
      } catch (err) {
        logger.warn('portfolio', `Failed to fetch live price for unrealized P&L on ${position.symbol}: ${err.message}`, {}, mode);
        return { ...position, currentPrice: null, unrealizedPnl: null };
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
  getPnlSummary,
  getOpenPositionsWithUnrealizedPnl,
};
