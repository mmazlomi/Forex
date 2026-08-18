'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../../../config/config');
const marketDataService = require('../market-data/market-data-service');
const futuresPortfolioService = require('../portfolio/futures-portfolio-service');
const futuresPortfolioRepository = require('../../database/repositories/futures-portfolio-repository');
const futuresRiskSettingsRepository = require('../../database/repositories/futures-risk-settings-repository');
const emergencyStopRepository = require('../../database/repositories/emergency-stop-repository');
const futuresOrdersRepository = require('../../database/repositories/futures-orders-repository');
const futuresPositionsRepository = require('../../database/repositories/futures-positions-repository');
const realAuditLogRepository = require('../../database/repositories/real-audit-log-repository');
const exchangeClientFactory = require('../exchanges/exchange-client-factory');
const { resolveRealCredentials } = require('../exchanges/real-credentials-resolver');
const logger = require('../logging/logger');
const { validateTrade } = require('../risk/validate-trade');
const { isStopLossSafeFromLiquidation } = require('./liquidation-estimate');

const MODE = 'real';
const DUPLICATE_WINDOW_MS = 5000;
const MAX_DATA_AGE_MS = 5 * 60 * 1000;

// KuCoin's unified ccxt futures symbol format is BASE/QUOTE:SETTLE (e.g. BTC/USDT:USDT) — a
// completely different shape from spot's BASE/QUOTE, confirmed live via loadMarkets() against
// KuCoin's real futures API. real-orders.js's `symbol.split('/')[1]` pattern would silently
// misparse this ('BTC/USDT:USDT'.split('/')[1] === 'USDT:USDT', not 'USDT') — this is exactly the
// bug this helper exists to avoid. The settle currency (after the colon) is what the futures
// account's margin/collateral balance is actually denominated in.
function marginCurrencyFor(symbol) {
  const parts = symbol.split(':');
  if (parts.length === 2) return parts[1];
  return symbol.split('/')[1];
}

function defaultRiskSettings(userId) {
  return futuresRiskSettingsRepository.ensureDefaults(userId, MODE, {
    maxRiskPerTradePercent: config.maxRiskPerTradePercent,
    maxDailyLossPercent: config.maxDailyLossPercent,
    maxOpenPositions: config.maxOpenPositions,
    maxOrderValue: config.maxOrderValue,
    minRiskRewardRatio: config.minRiskRewardRatio,
    maxPortfolioExposurePercent: 50,
    maxLeverage: 10,
  });
}

function toRiskSettingsShape(row) {
  return {
    maxRiskPerTradePercent: row.max_risk_per_trade_percent,
    maxDailyLossPercent: row.max_daily_loss_percent,
    maxOpenPositions: row.max_open_positions,
    maxOrderValue: row.max_order_value,
    minRiskRewardRatio: row.min_risk_reward_ratio,
    maxPortfolioExposurePercent: row.max_portfolio_exposure_percent,
  };
}

function persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode, message, idempotencyKey, signalId, source }) {
  const order = futuresOrdersRepository.insertOrder(MODE, userId, {
    id,
    symbol,
    exchange: exchange || 'kucoin',
    action,
    leverage: leverage ?? 1,
    qty: 0,
    price: price ?? 0,
    stopLoss: stopLoss ?? null,
    takeProfit: takeProfit ?? null,
    status: 'rejected',
    rejectReason: `${reasonCode}: ${message}`,
    idempotencyKey: idempotencyKey ?? null,
    createdAtUtc: new Date().toISOString(),
    signalId: signalId ?? null,
    source: source ?? 'manual',
  });
  logger.warn('futures-real-orders', `Real futures order rejected for ${symbol}: ${reasonCode}`, { message }, MODE);
  return order;
}

/**
 * Places a Real (live-money, leveraged) futures order on KuCoin for this user. This is the ONLY
 * function that may call KuCoin's live futures order-placement endpoint. Mirrors real-orders.js's
 * gate order exactly (live-trading gate -> credentials -> unlock -> idempotency -> emergency-stop
 * -> snapshot -> duplicate-check -> risk pipeline -> exchange call -> audit log), with the same
 * "no fallback to demo" guarantee. `unlockConfirmed` is REQUIRED for manual (source: 'manual')
 * orders — the auto-trader (source: 'auto') passes true itself, since there's no human present
 * per-trade; it is instead gated by ENABLE_FUTURES_AUTO_TRADING, checked in
 * futures-auto-trader.js before this is ever called with source: 'auto'. `credentials` here is
 * independently re-resolved from `userId` (not trusted from any upstream cache) — this function's
 * own credential check is the final, defense-in-depth gate for this specific real-money call,
 * regardless of what the auto-trader's cycle-level cache already decided.
 */
async function placeRealFuturesOrder({ userId, symbol, exchange = 'kucoin', action, leverage, stopLoss, takeProfit, qty, idempotencyKey, signalId, unlockConfirmed, source = 'manual', strategyId, timeframe, trailingPercent }) {
  const id = uuidv4();
  action = String(action || '').toLowerCase();

  // 1. Live-trading gate — checked first, before any other work.
  if (!config.enableLiveTrading) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'LIVE_TRADING_DISABLED', message: 'ENABLE_LIVE_TRADING is not set to true in .env.', idempotencyKey, signalId, source });
  }
  const credentials = resolveRealCredentials(userId);
  if (!credentials.name || !credentials.apiKey || !credentials.apiSecret) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'MISSING_REAL_CREDENTIALS', message: 'Real exchange credentials are not fully configured (set them from the Real Trading tab, or via REAL_EXCHANGE_NAME/REAL_API_KEY/REAL_API_SECRET in .env).', idempotencyKey, signalId, source });
  }
  if (!exchangeClientFactory.isFuturesExchangeSupported(credentials.name)) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'FUTURES_EXCHANGE_UNSUPPORTED', message: `Futures trading is not supported on "${credentials.name}"; the configured Real exchange must be one of: ${exchangeClientFactory.getSupportedFuturesExchanges().map((e) => e.id).join(', ')}.`, idempotencyKey, signalId, source });
  }
  if (!unlockConfirmed) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'REAL_TRADING_NOT_UNLOCKED', message: 'The UI real-trading unlock/confirmation step was not completed for this request.', idempotencyKey, signalId, source });
  }

  if (!['open_long', 'open_short', 'close'].includes(action)) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'INVALID_ACTION', message: `Unknown action "${action}".`, idempotencyKey, signalId, source });
  }

  if (idempotencyKey) {
    const existing = futuresOrdersRepository.findByIdempotencyKey(MODE, userId, idempotencyKey);
    if (existing) return existing;
  }

  if (emergencyStopRepository.isActive(MODE, userId)) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'EMERGENCY_STOP_ACTIVE', message: 'Real futures trading is halted by an active emergency stop.', idempotencyKey, signalId, source });
  }

  const snapshot = await marketDataService.getFuturesSnapshot({ symbol, exchange });
  if (snapshot.status !== 'ok' || typeof snapshot.price !== 'number') {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, reasonCode: 'INVALID_PRICE', message: snapshot.error || 'Market price unavailable', idempotencyKey, signalId, source });
  }
  const price = snapshot.price;

  const isDuplicate = !!futuresOrdersRepository.findRecentSimilarOrder(MODE, userId, { symbol, action, price, windowMs: DUPLICATE_WINDOW_MS });
  if (isDuplicate) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'DUPLICATE_ORDER', message: 'An equivalent order was just submitted.', idempotencyKey, signalId, source });
  }

  if (action === 'close') {
    return closeRealFuturesPosition({ id, userId, symbol, exchange, price, idempotencyKey, signalId, source });
  }

  // open_long / open_short
  if (typeof stopLoss !== 'number' || typeof takeProfit !== 'number') {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'MISSING_RISK_PARAMS', message: 'stopLoss and takeProfit are required to open a futures position.', idempotencyKey, signalId, source });
  }
  if (typeof leverage !== 'number' || leverage < 1) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'INVALID_LEVERAGE', message: 'leverage must be a number >= 1.', idempotencyKey, signalId, source });
  }
  const riskSettingsRow = defaultRiskSettings(userId);
  if (leverage > riskSettingsRow.max_leverage) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'LEVERAGE_TOO_HIGH', message: `Leverage ${leverage}x exceeds the configured maximum of ${riskSettingsRow.max_leverage}x.`, idempotencyKey, signalId, source });
  }

  const existingPosition = futuresPositionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (existingPosition) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'POSITION_ALREADY_OPEN', message: `An open ${existingPosition.side} position already exists for ${symbol} (one-way mode: one net position per symbol).`, idempotencyKey, signalId, source });
  }

  const client = exchangeClientFactory.getRealFuturesExchange(userId);

  let liveBalanceMargin;
  try {
    const balance = await client.fetchBalance();
    const marginCurrency = marginCurrencyFor(symbol);
    liveBalanceMargin = balance.free?.[marginCurrency] ?? 0;
    futuresPortfolioRepository.setBalance(MODE, userId, liveBalanceMargin);
  } catch (err) {
    logger.error('futures-real-orders', `Failed to fetch live futures balance from exchange: ${err.message}`, {}, MODE);
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'EXCHANGE_UNAVAILABLE', message: `Could not fetch live futures balance: ${err.message}`, idempotencyKey, signalId, source });
  }

  const riskSettings = toRiskSettingsShape(riskSettingsRow);
  const portfolio = futuresPortfolioService.getSnapshot(MODE, userId);

  const validation = validateTrade({
    mode: MODE,
    emergencyStopActive: false,
    liveTradingEnabled: config.enableLiveTrading,
    dataQuality: snapshot.dataFreshnessMs > MAX_DATA_AGE_MS ? 'insufficient' : 'good',
    dataAgeMs: snapshot.dataFreshnessMs,
    maxDataAgeMs: MAX_DATA_AGE_MS,
    entryPrice: price,
    stopLossPrice: stopLoss,
    takeProfitPrice: takeProfit,
    riskSettings,
    balance: portfolio.balance,
    openPositionsCount: portfolio.openPositions.length,
    dailyLossSoFar: portfolio.dailyLossSoFar,
    currentExposureValue: portfolio.exposureValue,
    marginUsed: portfolio.marginUsed,
    isDuplicate: false,
    qtyOverride: qty,
    leverage,
  });

  if (!validation.accepted) {
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: validation.reasonCode, message: validation.message, idempotencyKey, signalId, source });
  }

  // Leverage/margin-mode setting is exchange-shaped, not universal — see the leverageMode doc
  // comment on exchange-client-factory.js's FUTURES_EXCHANGES. 'inline': KuCoin sets leverage and
  // margin mode as part of the order itself — confirmed by reading ccxt's
  // createContractOrderRequest() source directly: `params.marginMode` ('isolated' or 'cross',
  // isolated is even KuCoin's own default for contract orders) and `params.leverage` are merged
  // straight into the order request. KuCoin's separate setLeverage() method is CROSS-margin-only
  // (it calls the literal "ChangeCrossUserLeverage" endpoint and throws if given any other
  // marginMode) — calling it here would be actively wrong for the isolated-margin default this app
  // uses, not just redundant. 'preset': CoinEx's createOrder does not accept leverage/marginMode in
  // its params at all (confirmed via ccxt's coinex.js createOrderRequest()) — its setLeverage()
  // does accept marginMode (confirmed via ccxt's coinex.js setLeverage()) and must be called first;
  // if it fails, the order is never placed (same EXCHANGE_ORDER_FAILED rejection either way, so a
  // failed leverage-set never leaves an unleveraged/wrong-margin-mode position opened).
  const orderSide = action === 'open_long' ? 'buy' : 'sell';
  const leverageMode = exchangeClientFactory.getFuturesLeverageMode(exchange);
  let exchangeResponse;
  try {
    if (leverageMode === 'preset') {
      await client.setLeverage(leverage, symbol, { marginMode: 'isolated' });
      exchangeResponse = await client.createOrder(symbol, 'market', orderSide, validation.positionSize, undefined, {});
    } else {
      exchangeResponse = await client.createOrder(symbol, 'market', orderSide, validation.positionSize, undefined, { marginMode: 'isolated', leverage });
    }
  } catch (err) {
    logger.error('futures-real-orders', `Exchange futures order placement failed for ${symbol}: ${err.message}`, {}, MODE);
    realAuditLogRepository.insertAuditEntry({ userId, orderId: id, requestJson: JSON.stringify({ symbol, action, leverage, qty: validation.positionSize }), responseJson: JSON.stringify({ error: err.message }) });
    return persistRejected({ id, userId, symbol, exchange, action, leverage, stopLoss, takeProfit, price, reasonCode: 'EXCHANGE_ORDER_FAILED', message: err.message, idempotencyKey, signalId, source });
  }

  realAuditLogRepository.insertAuditEntry({
    userId,
    orderId: id,
    requestJson: JSON.stringify({ symbol, action, leverage, qty: validation.positionSize }),
    responseJson: JSON.stringify(exchangeResponse),
  });

  // The order already filled at this point — this is a post-open safety signal (logged/surfaced),
  // not a pre-block, since we can only get KuCoin's real liquidation price after the position
  // exists. See liquidation-estimate.js and docs/architecture.md Phase 2.
  const side = action === 'open_long' ? 'long' : 'short';
  let liquidationPrice = null;
  try {
    const positions = await client.fetchPositions([symbol]);
    const livePosition = positions.find((p) => p.symbol === symbol);
    liquidationPrice = livePosition?.liquidationPrice ?? null;
    if (liquidationPrice != null && !isStopLossSafeFromLiquidation({ side, stopLoss, liquidationPrice })) {
      logger.warn(
        'futures-real-orders',
        `Stop-loss ${stopLoss} for ${symbol} is beyond KuCoin's actual liquidation price ${liquidationPrice} — it will NOT trigger before liquidation. Position was already opened; consider closing or adjusting manually.`,
        { stopLoss, liquidationPrice },
        MODE
      );
    }
  } catch (err) {
    logger.warn('futures-real-orders', `Failed to fetch live liquidation price for ${symbol} after opening: ${err.message}`, {}, MODE);
  }

  const position = futuresPortfolioService.openPosition(MODE, userId, {
    symbol, exchange, side, leverage, qty: validation.positionSize, entryPrice: price, stopLoss, takeProfit, liquidationPrice, signalId, source, strategyId, timeframe, trailingPercent,
  });

  const order = futuresOrdersRepository.insertOrder(MODE, userId, {
    id, symbol, exchange, action, leverage, qty: validation.positionSize, price, stopLoss, takeProfit,
    status: 'filled', rejectReason: null, idempotencyKey: idempotencyKey ?? null,
    exchangeOrderId: exchangeResponse?.id ?? null, createdAtUtc: new Date().toISOString(),
    filledAtUtc: new Date().toISOString(), signalId: signalId ?? null, source,
  });

  logger.info('futures-real-orders', `Real futures ${action} filled for ${symbol}`, { qty: validation.positionSize, leverage, price, liquidationPrice, positionId: position.id }, MODE);
  return order;
}

async function closeRealFuturesPosition({ id, userId, symbol, exchange, price, idempotencyKey, signalId, source }) {
  const openPosition = futuresPositionsRepository.findOpenPositionBySymbol(MODE, userId, symbol);
  if (!openPosition) {
    return persistRejected({ id, userId, symbol, exchange, action: 'close', price, reasonCode: 'NO_OPEN_POSITION_TO_CLOSE', message: `No open Real futures position for ${symbol}.`, idempotencyKey, signalId, source });
  }

  const client = exchangeClientFactory.getRealFuturesExchange(userId);
  const closingSide = openPosition.side === 'long' ? 'sell' : 'buy';
  let exchangeResponse;
  try {
    exchangeResponse = await client.createOrder(symbol, 'market', closingSide, openPosition.qty, undefined, { reduceOnly: true });
  } catch (err) {
    logger.error('futures-real-orders', `Exchange futures close order failed for ${symbol}: ${err.message}`, {}, MODE);
    realAuditLogRepository.insertAuditEntry({ userId, orderId: id, requestJson: JSON.stringify({ symbol, action: 'close', qty: openPosition.qty }), responseJson: JSON.stringify({ error: err.message }) });
    return persistRejected({ id, userId, symbol, exchange, action: 'close', price, reasonCode: 'EXCHANGE_ORDER_FAILED', message: err.message, idempotencyKey, signalId, source });
  }

  realAuditLogRepository.insertAuditEntry({
    userId,
    orderId: id,
    requestJson: JSON.stringify({ symbol, action: 'close', qty: openPosition.qty }),
    responseJson: JSON.stringify(exchangeResponse),
  });

  const { realizedPnl } = futuresPortfolioService.closePosition(MODE, userId, openPosition.id, price);

  const order = futuresOrdersRepository.insertOrder(MODE, userId, {
    id, symbol, exchange, action: 'close', leverage: openPosition.leverage, qty: openPosition.qty, price,
    stopLoss: null, takeProfit: null, status: 'filled', rejectReason: null, idempotencyKey: idempotencyKey ?? null,
    exchangeOrderId: exchangeResponse?.id ?? null, createdAtUtc: new Date().toISOString(),
    filledAtUtc: new Date().toISOString(), signalId: signalId ?? null, realizedPnl, source: source ?? 'manual',
  });

  logger.info('futures-real-orders', `Real futures close for ${symbol}`, { realizedPnl, positionId: openPosition.id }, MODE);
  return order;
}

module.exports = { placeRealFuturesOrder, marginCurrencyFor };
