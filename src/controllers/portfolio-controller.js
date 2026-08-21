'use strict';

const portfolioService = require('../services/portfolio/portfolio-service');
const portfolioRepository = require('../database/repositories/portfolio-repository');
const positionsRepository = require('../database/repositories/positions-repository');
const exchangeClientFactory = require('../services/exchanges/exchange-client-factory');
const { resolveRealCredentials } = require('../services/exchanges/real-credentials-resolver');
const { describeStrategyIds } = require('../services/signals/strategies');
const tradingStatisticsService = require('../services/portfolio/trading-statistics-service');
const { sendSuccess, sendError } = require('../utils/http-response');
const logger = require('../services/logging/logger');

async function getPortfolio(req, res) {
  const mode = req.tradingMode;
  const userId = req.user.id;
  const snapshot = portfolioService.getSnapshot(mode, userId);
  const pnl = portfolioService.getPnlSummary(mode, userId);
  const openPositions = await portfolioService.getOpenPositionsWithUnrealizedPnl(mode, userId);
  const unrealizedPnl = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

  sendSuccess(res, {
    ...snapshot,
    openPositions,
    pnl: { ...pnl, unrealizedPnl, netPnl: pnl.totalRealizedPnl + unrealizedPnl },
  });
}

// Complete round-trip trade history — every CLOSED position for this user/mode, most recent
// first, each enriched with human-readable strategy name(s) exactly like Open Positions already
// are (see futures-portfolio-service.js's identical enrichment). This is the "which asset, which
// strategy, which timeframe, entry vs exit, realized win/loss" record the Order History tables
// don't provide on their own (those show individual orders, not paired entry+exit trades).
async function getTradeHistory(req, res) {
  const mode = req.tradingMode;
  const userId = req.user.id;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const closedPositions = positionsRepository.listClosedPositions(mode, userId, { limit });
  const trades = closedPositions.map((position) => ({
    ...position,
    strategies: describeStrategyIds(position.strategy_id, position.combined_strategy_ids_json),
  }));
  sendSuccess(res, trades);
}

// Statistics dashboard section — spans both Demo and Real, and both spot and futures, in one
// response (unlike every other portfolio endpoint here, which is mode-scoped via requireValidMode)
// since the whole point is comparing them side by side. See trading-statistics-service.js for the
// aggregation itself; this is just the HTTP wrapper.
async function getStatistics(req, res) {
  const userId = req.user.id;
  sendSuccess(res, tradingStatisticsService.getStatistics(userId));
}

// Real Trading's balance previously only ever synced from the live exchange as a side effect of
// actually placing an order (real-orders.js) — there was no way to just check it, so a freshly
// entered API key/Token showed an empty $0 portfolio until the first trade attempt. This is a
// read-only exchange call (fetchBalance only, no order placed), so — unlike placing an order —
// it deliberately does NOT require ENABLE_LIVE_TRADING=true; viewing your balance isn't trading.
async function syncRealBalance(req, res) {
  const userId = req.user.id;
  const { symbol, exchange } = req.body || {};
  if (!symbol || !exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol and exchange are required (used to pick which quote-currency wallet to read).');
  }

  const credentials = resolveRealCredentials(userId);
  if (!credentials.name || !credentials.apiKey) {
    return sendError(res, 'MISSING_REAL_CREDENTIALS', 'No Real exchange credentials are configured yet.');
  }

  const quoteCurrency = symbol.split('/')[1];
  if (!quoteCurrency) {
    return sendError(res, 'VALIDATION_ERROR', `"${symbol}" doesn't look like a BASE/QUOTE symbol.`);
  }

  const client = exchangeClientFactory.getRealExchange(userId);
  let balance;
  try {
    balance = await client.fetchBalance();
  } catch (err) {
    logger.error('portfolio', `Failed to sync Real balance from ${credentials.name}: ${err.message}`, {}, 'real');
    return sendError(res, 'EXCHANGE_UNAVAILABLE', `Could not fetch balance from ${credentials.name}: ${err.message}`, 422);
  }

  // portfolio.balance itself stays a single number scoped to whatever quote currency you're
  // about to trade (real-orders.js's position-sizing math needs exactly one number) — but an
  // exchange like Nobitex can hold several currencies at once (IRT, USDT, BTC, ...), so the full
  // breakdown from this same fetchBalance() call is persisted alongside it (setBalance's third
  // arg) so viewing the Real tab shows it immediately on the next page load/tab switch too, not
  // just right after this sync call.
  const liveBalanceQuote = balance.free?.[quoteCurrency] ?? 0;
  const walletBalances = Object.entries(balance.free || {})
    .filter(([, amount]) => amount > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([currency, amount]) => ({ currency, amount }));
  portfolioRepository.setBalance('real', userId, liveBalanceQuote, walletBalances);
  logger.info('portfolio', `Real balance synced from ${credentials.name}: ${liveBalanceQuote} ${quoteCurrency}`, {}, 'real');

  const snapshot = portfolioService.getSnapshot('real', userId);
  sendSuccess(res, snapshot, `Balance synced from ${credentials.name} (${quoteCurrency}).`);
}

module.exports = { getPortfolio, syncRealBalance, getTradeHistory, getStatistics };
