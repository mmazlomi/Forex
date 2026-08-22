'use strict';

require('dotenv').config();

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

function parseNumber(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid numeric value for ${name}: "${value}"`);
  }
  return num;
}

function parseInteger(name, value, fallback) {
  const num = parseNumber(name, value, fallback);
  if (!Number.isInteger(num)) {
    throw new Error(`Invalid integer value for ${name}: "${value}"`);
  }
  return num;
}

const env = process.env;

const config = Object.freeze({
  nodeEnv: env.NODE_ENV || 'development',
  port: parseInteger('PORT', env.PORT, 3450),
  tradingMode: (env.TRADING_MODE || 'demo').toLowerCase(),
  enableLiveTrading: parseBool(env.ENABLE_LIVE_TRADING, false),

  demoExchange: {
    name: env.DEMO_EXCHANGE_NAME || '',
    apiKey: env.DEMO_API_KEY || '',
    apiSecret: env.DEMO_API_SECRET || '',
  },
  realExchange: {
    name: env.REAL_EXCHANGE_NAME || '',
    apiKey: env.REAL_API_KEY || '',
    apiSecret: env.REAL_API_SECRET || '',
  },

  fundamentalApiKey: env.FUNDAMENTAL_API_KEY || '',
  // CoinGecko's free/keyless tier has a very low rate limit (as low as ~5-15 req/min); this is
  // the minimum spacing enforced between outbound CoinGecko requests so scoring a full watchlist
  // in one scan cycle doesn't burst through it and 429 every symbol behind the first few. A paid
  // FUNDAMENTAL_API_KEY tier can raise CoinGecko's actual limit — lower this to match if so.
  coingeckoMinIntervalMs: parseInteger('COINGECKO_MIN_INTERVAL_MS', env.COINGECKO_MIN_INTERVAL_MS, 1500),

  initialDemoBalance: parseNumber('INITIAL_DEMO_BALANCE', env.INITIAL_DEMO_BALANCE, 10000),
  maxRiskPerTradePercent: parseNumber('MAX_RISK_PER_TRADE_PERCENT', env.MAX_RISK_PER_TRADE_PERCENT, 1),
  maxDailyLossPercent: parseNumber('MAX_DAILY_LOSS_PERCENT', env.MAX_DAILY_LOSS_PERCENT, 3),
  maxOpenPositions: parseInteger('MAX_OPEN_POSITIONS', env.MAX_OPEN_POSITIONS, 5),
  maxOrderValue: parseNumber('MAX_ORDER_VALUE', env.MAX_ORDER_VALUE, 1000),
  minRiskRewardRatio: parseNumber('MIN_RISK_REWARD_RATIO', env.MIN_RISK_REWARD_RATIO, 1.5),

  databasePath: env.DATABASE_PATH || './data/trading-bot.sqlite',
  logLevel: env.LOG_LEVEL || 'info',
  requestTimeoutMs: parseInteger('REQUEST_TIMEOUT_MS', env.REQUEST_TIMEOUT_MS, 10000),
  maxApiRetries: parseInteger('MAX_API_RETRIES', env.MAX_API_RETRIES, 3),

  // Addition beyond the original .env.example spec, for the AI auto-trading feature —
  // see docs/architecture.md. Auto-trading only ever runs in Demo mode.
  autoTradeIntervalMs: parseInteger('AUTO_TRADE_INTERVAL_MS', env.AUTO_TRADE_INTERVAL_MS, 5 * 60 * 1000),

  // Phase 1 order types (Limit/Stop-Market/Stop-Limit/OCO) — pending-orders-watcher.js's poll
  // interval. Tighter than autoTradeIntervalMs (a triggered price condition is time-sensitive in
  // a way a re-evaluated trading signal isn't), default 30s.
  pendingOrdersPollIntervalMs: parseInteger('PENDING_ORDERS_POLL_INTERVAL_MS', env.PENDING_ORDERS_POLL_INTERVAL_MS, 30 * 1000),

  // Phase 2 (Futures) auto-trader. Unlike autoTradeIntervalMs's spot bot (hard-coded Demo-only),
  // the futures auto-trader CAN place real leveraged trades — but only when enableFuturesAutoTrading
  // is explicitly true (restart-only, same deliberately-high-friction .env-edit-plus-restart
  // pattern as enableLiveTrading — never a UI toggle) AND every other layered gate in
  // futures-auto-trader.js also passes. futuresAutoTradeMaxLeverage is a hard cap the auto-trader
  // clamps down to regardless of what leverage is configured per-asset, deliberately lower than
  // what a human can manually select — see docs/architecture.md Phase 2 section.
  futuresAutoTradeIntervalMs: parseInteger('FUTURES_AUTO_TRADE_INTERVAL_MS', env.FUTURES_AUTO_TRADE_INTERVAL_MS, 5 * 60 * 1000),
  enableFuturesAutoTrading: parseBool(env.ENABLE_FUTURES_AUTO_TRADING, false),
  futuresAutoTradeMaxLeverage: parseNumber('FUTURES_AUTO_TRADE_MAX_LEVERAGE', env.FUTURES_AUTO_TRADE_MAX_LEVERAGE, 3),

  // Liquidity Sweep Reversal's spot scheduler (reversal-spot-auto-trader.js) — same
  // deliberately-high-friction restart-only .env-edit gate as enableFuturesAutoTrading, same
  // reasoning (real money, unattended, no human per-trade). Unlike the original spot auto-trader
  // (autoTradeIntervalMs above, hard-coded Demo-only, "not configurable"), this genuinely can
  // place real spot orders — but only for assets with their own explicit
  // real_auto_trade_enabled flag set (see schema.js's migrateAddRealAutoTradeColumn) AND usable
  // Real credentials for that specific user. Reuses futuresAutoTradeIntervalMs for polling
  // cadence rather than adding a third near-identical interval env var — this is the same
  // Liquidity Sweep Reversal ecosystem either way, just a different execution adapter.
  enableSpotAutoTrading: parseBool(env.ENABLE_SPOT_AUTO_TRADING, false),

  // Multi-strategy auto-selection (strategy-selector.js): periodically backtests every built-in
  // strategy per 'auto'-mode watchlist asset and keeps the top-N by win rate selected for
  // auto-trader.js's majority-vote combined signal. Comparatively expensive (each asset runs a
  // real backtest), so this defaults to a much longer interval than the trade-cycle schedulers
  // above — no need to re-rank strategies every few minutes.
  strategySelectionIntervalMs: parseInteger('STRATEGY_SELECTION_INTERVAL_MS', env.STRATEGY_SELECTION_INTERVAL_MS, 12 * 60 * 60 * 1000),
  strategySelectionLookbackDays: parseInteger('STRATEGY_SELECTION_LOOKBACK_DAYS', env.STRATEGY_SELECTION_LOOKBACK_DAYS, 30),
  strategySelectionCount: parseInteger('STRATEGY_SELECTION_COUNT', env.STRATEGY_SELECTION_COUNT, 3),
  // A backtested 100% win rate off 1-2 trades is noise, not signal — this is the minimum number
  // of closed trades a strategy's backtest must have produced over the lookback window before
  // it's even eligible to be selected.
  strategySelectionMinTrades: parseInteger('STRATEGY_SELECTION_MIN_TRADES', env.STRATEGY_SELECTION_MIN_TRADES, 5),

  // lsr-timeframe-selector.js's structural twin of the strategySelection* group above — picks the
  // best htfTimeframe/signalTimeframe/entryTimeframe combo per 'auto'-mode LSR asset instead of
  // the best strategy. Longer lookback and a lower min-trade gate than strategy selection: LSR's
  // sweep -> divergence -> CHOCH -> retest sequence is a genuinely rare signal (see
  // docs/reversal-strategy/STRATEGY_SPEC.md), so a 30-day window / 5-trade gate tuned for the
  // much higher-frequency weighted-indicator strategies would almost never have enough trades to
  // ever select anything.
  lsrTimeframeSelectionIntervalMs: parseInteger('LSR_TIMEFRAME_SELECTION_INTERVAL_MS', env.LSR_TIMEFRAME_SELECTION_INTERVAL_MS, 12 * 60 * 60 * 1000),
  lsrTimeframeSelectionLookbackDays: parseInteger('LSR_TIMEFRAME_SELECTION_LOOKBACK_DAYS', env.LSR_TIMEFRAME_SELECTION_LOOKBACK_DAYS, 90),
  lsrTimeframeSelectionMinTrades: parseInteger('LSR_TIMEFRAME_SELECTION_MIN_TRADES', env.LSR_TIMEFRAME_SELECTION_MIN_TRADES, 3),
});

function validateConfig(cfg) {
  const errors = [];

  if (!['demo', 'real'].includes(cfg.tradingMode)) {
    errors.push(`TRADING_MODE must be "demo" or "real", got "${cfg.tradingMode}"`);
  }
  if (!(cfg.port >= 1 && cfg.port <= 65535)) {
    errors.push(`PORT must be between 1 and 65535, got ${cfg.port}`);
  }
  // Real exchange credentials are no longer required to be present in .env at boot — they can
  // also be set from the Real Trading tab (stored encrypted in the database, resolved at
  // request time by real-credentials-resolver.js), and the database isn't connected yet at this
  // point in boot. Completeness is instead checked fresh on every real-order attempt
  // (real-orders.js — MISSING_REAL_CREDENTIALS), which already covers both sources.
  if (cfg.maxRiskPerTradePercent <= 0 || cfg.maxRiskPerTradePercent > 100) {
    errors.push(`MAX_RISK_PER_TRADE_PERCENT must be in (0, 100], got ${cfg.maxRiskPerTradePercent}`);
  }
  if (cfg.maxDailyLossPercent <= 0 || cfg.maxDailyLossPercent > 100) {
    errors.push(`MAX_DAILY_LOSS_PERCENT must be in (0, 100], got ${cfg.maxDailyLossPercent}`);
  }
  if (cfg.maxOpenPositions < 1) {
    errors.push(`MAX_OPEN_POSITIONS must be >= 1, got ${cfg.maxOpenPositions}`);
  }
  if (cfg.maxOrderValue <= 0) {
    errors.push(`MAX_ORDER_VALUE must be > 0, got ${cfg.maxOrderValue}`);
  }
  if (cfg.minRiskRewardRatio <= 0) {
    errors.push(`MIN_RISK_REWARD_RATIO must be > 0, got ${cfg.minRiskRewardRatio}`);
  }
  if (cfg.initialDemoBalance <= 0) {
    errors.push(`INITIAL_DEMO_BALANCE must be > 0, got ${cfg.initialDemoBalance}`);
  }
  if (cfg.autoTradeIntervalMs < 30_000) {
    errors.push(`AUTO_TRADE_INTERVAL_MS must be >= 30000 (30s), got ${cfg.autoTradeIntervalMs} — too aggressive risks exchange rate limits.`);
  }
  if (cfg.pendingOrdersPollIntervalMs < 5_000) {
    errors.push(`PENDING_ORDERS_POLL_INTERVAL_MS must be >= 5000 (5s), got ${cfg.pendingOrdersPollIntervalMs} — too aggressive risks exchange rate limits.`);
  }
  if (cfg.futuresAutoTradeIntervalMs < 30_000) {
    errors.push(`FUTURES_AUTO_TRADE_INTERVAL_MS must be >= 30000 (30s), got ${cfg.futuresAutoTradeIntervalMs} — too aggressive risks exchange rate limits.`);
  }
  if (cfg.futuresAutoTradeMaxLeverage < 1) {
    errors.push(`FUTURES_AUTO_TRADE_MAX_LEVERAGE must be >= 1, got ${cfg.futuresAutoTradeMaxLeverage}.`);
  }
  if (cfg.strategySelectionIntervalMs < 60 * 60 * 1000) {
    errors.push(`STRATEGY_SELECTION_INTERVAL_MS must be >= 3600000 (1h), got ${cfg.strategySelectionIntervalMs} — this runs a real backtest per asset and shouldn't be scheduled too tightly.`);
  }
  if (cfg.strategySelectionLookbackDays < 1) {
    errors.push(`STRATEGY_SELECTION_LOOKBACK_DAYS must be >= 1, got ${cfg.strategySelectionLookbackDays}.`);
  }
  if (![2, 3].includes(cfg.strategySelectionCount)) {
    errors.push(`STRATEGY_SELECTION_COUNT must be 2 or 3 (majority vote needs at least 2 strategies), got ${cfg.strategySelectionCount}.`);
  }
  if (cfg.strategySelectionMinTrades < 1) {
    errors.push(`STRATEGY_SELECTION_MIN_TRADES must be >= 1, got ${cfg.strategySelectionMinTrades}.`);
  }
  if (cfg.lsrTimeframeSelectionIntervalMs < 60 * 60 * 1000) {
    errors.push(`LSR_TIMEFRAME_SELECTION_INTERVAL_MS must be >= 3600000 (1h), got ${cfg.lsrTimeframeSelectionIntervalMs} — this runs a real backtest per candidate per asset and shouldn't be scheduled too tightly.`);
  }
  if (cfg.lsrTimeframeSelectionLookbackDays < 1) {
    errors.push(`LSR_TIMEFRAME_SELECTION_LOOKBACK_DAYS must be >= 1, got ${cfg.lsrTimeframeSelectionLookbackDays}.`);
  }
  if (cfg.lsrTimeframeSelectionMinTrades < 1) {
    errors.push(`LSR_TIMEFRAME_SELECTION_MIN_TRADES must be >= 1, got ${cfg.lsrTimeframeSelectionMinTrades}.`);
  }
  if (cfg.coingeckoMinIntervalMs < 0) {
    errors.push(`COINGECKO_MIN_INTERVAL_MS must be >= 0, got ${cfg.coingeckoMinIntervalMs}.`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

validateConfig(config);

module.exports = config;
