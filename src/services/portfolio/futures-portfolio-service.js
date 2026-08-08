'use strict';

const futuresPortfolioRepository = require('../../database/repositories/futures-portfolio-repository');
const futuresPositionsRepository = require('../../database/repositories/futures-positions-repository');
const marketDataService = require('../market-data/market-data-service');
const logger = require('../logging/logger');
const config = require('../../../config/config');

function startOfTodayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Direction multiplier for PnL/exposure math: long profits when price rises, short when it falls. */
function directionOf(position) {
  return position.side === 'long' ? 1 : -1;
}

/** Notional exposure = sum of entry_price × qty for this user — leverage-independent, used for the
 *  exposure-percent risk check (step 8 of validateTrade). See validate-trade.js's comment on why
 *  notional (not margin) is the right number for that specific check. */
function getExposureValue(mode, userId) {
  return futuresPositionsRepository.listOpenPositions(mode, userId).reduce((sum, p) => sum + p.entry_price * p.qty, 0);
}

/** Margin actually committed by this user's open positions = sum of (entry_price × qty / leverage)
 *  — this is what validateTrade's `marginUsed` param needs for the sufficient-balance check
 *  (step 9), since a leveraged position only ties up its margin, not its full notional. */
function getMarginUsed(mode, userId) {
  return futuresPositionsRepository.listOpenPositions(mode, userId).reduce((sum, p) => sum + (p.entry_price * p.qty) / p.leverage, 0);
}

function getDailyLossSoFar(mode, userId) {
  const totalPnl = futuresPositionsRepository.sumRealizedPnlSince(mode, userId, startOfTodayUtc());
  return totalPnl < 0 ? Math.abs(totalPnl) : 0;
}

function getSnapshot(mode, userId) {
  const portfolio = futuresPortfolioRepository.ensureInitialized(mode, userId, mode === 'demo' ? config.initialDemoBalance : 0);
  const openPositions = futuresPositionsRepository.listOpenPositions(mode, userId);
  const exposureValue = getExposureValue(mode, userId);
  const marginUsed = getMarginUsed(mode, userId);
  const dailyLossSoFar = getDailyLossSoFar(mode, userId);

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
    marginUsed,
    exposurePercent: portfolio.balance > 0 ? (exposureValue / portfolio.balance) * 100 : 0,
    availableBalance: portfolio.balance - marginUsed,
    dailyLossSoFar,
    updatedAtUtc: portfolio.updated_at_utc,
  };
}

/** Opens a new long/short position for this user. Unlike spot (always 'buy'), side here is 'long'/'short'. */
function openPosition(mode, userId, { symbol, exchange, side, leverage, qty, entryPrice, stopLoss, takeProfit, liquidationPrice }) {
  return futuresPositionsRepository.insertPosition(mode, userId, {
    symbol,
    exchange,
    side,
    leverage,
    qty,
    entryPrice,
    liquidationPrice: liquidationPrice ?? null,
    stopLoss: stopLoss ?? null,
    takeProfit: takeProfit ?? null,
    openedAtUtc: new Date().toISOString(),
  });
}

/** Closes this user's open position at exitPrice, realizing P&L (direction-aware: long profits on
 *  a rise, short profits on a fall) and crediting/debiting their futures cash (margin currency) balance. */
function closePosition(mode, userId, positionId, exitPrice) {
  const position = futuresPositionsRepository.getPosition(mode, userId, positionId);
  if (!position || position.status !== 'open') {
    throw new Error(`No open futures position ${positionId} in mode "${mode}" for this user`);
  }
  const realizedPnl = directionOf(position) * (exitPrice - position.entry_price) * position.qty;

  const portfolio = futuresPortfolioRepository.ensureInitialized(mode, userId, mode === 'demo' ? config.initialDemoBalance : 0);
  futuresPortfolioRepository.setBalance(mode, userId, portfolio.balance + realizedPnl);

  return { ...futuresPositionsRepository.closePosition(mode, userId, positionId, { exitPrice, realizedPnl }), realizedPnl };
}

function getPnlSummary(mode, userId) {
  const totalRealizedPnl = futuresPositionsRepository.sumAllRealizedPnl(mode, userId);
  const { winCount, lossCount } = futuresPositionsRepository.countClosedByOutcome(mode, userId);
  const totalClosed = winCount + lossCount;
  return {
    totalRealizedPnl,
    winCount,
    lossCount,
    winRatePercent: totalClosed > 0 ? (winCount / totalClosed) * 100 : 0,
  };
}

/** This user's open positions enriched with live price, unrealized P&L, and % distance to
 *  liquidation — for display. */
async function getOpenPositionsWithUnrealizedPnl(mode, userId) {
  return enrichPositionsWithUnrealizedPnl(futuresPositionsRepository.listOpenPositions(mode, userId), mode);
}

/** Every user's open positions, similarly enriched — deliberately unscoped, used only by
 *  futures-auto-trader.js's per-cycle liquidation-distance safety check, which is one shared
 *  background process that must see every account's open positions. Each returned row still
 *  carries its own user_id. */
async function getAllOpenPositionsWithUnrealizedPnl(mode) {
  return enrichPositionsWithUnrealizedPnl(futuresPositionsRepository.listAllOpenPositions(mode), mode);
}

async function enrichPositionsWithUnrealizedPnl(openPositions, mode) {
  return Promise.all(
    openPositions.map(async (position) => {
      try {
        const snapshot = await marketDataService.getFuturesSnapshot({ symbol: position.symbol, exchange: position.exchange });
        if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
          return { ...position, currentPrice: null, unrealizedPnl: null, liquidationDistancePercent: null };
        }
        const unrealizedPnl = directionOf(position) * (snapshot.price - position.entry_price) * position.qty;
        let liquidationDistancePercent = null;
        if (typeof position.liquidation_price === 'number') {
          liquidationDistancePercent = (Math.abs(snapshot.price - position.liquidation_price) / snapshot.price) * 100;
        }
        return { ...position, currentPrice: snapshot.price, unrealizedPnl, liquidationDistancePercent };
      } catch (err) {
        logger.warn('futures-portfolio', `Failed to fetch live price for unrealized P&L on ${position.symbol}: ${err.message}`, {}, mode);
        return { ...position, currentPrice: null, unrealizedPnl: null, liquidationDistancePercent: null };
      }
    })
  );
}

module.exports = {
  getSnapshot,
  getExposureValue,
  getMarginUsed,
  getDailyLossSoFar,
  openPosition,
  closePosition,
  getPnlSummary,
  getOpenPositionsWithUnrealizedPnl,
  getAllOpenPositionsWithUnrealizedPnl,
};
