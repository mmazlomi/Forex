'use strict';

const { v4: uuidv4 } = require('uuid');
const { fetchHistoricalRange } = require('./historical-data');
const { computeAllIndicators } = require('../technical-analysis');
const { computeSignal, DEFAULT_SCORING_CONFIG } = require('../signals/scoring-engine');
const { getStrategy, DEFAULT_STRATEGY_ID } = require('../signals/strategies');
const { computeMaxRiskAmount, computePositionSize } = require('../risk/position-sizing');
const { computeMetrics } = require('./metrics');
const { timeframeToMs } = require('../market-data/candle-validator');
const backtestRepository = require('../../database/repositories/backtest-repository');
const logger = require('../logging/logger');

const WARMUP_CANDLES = 60;
const STRATEGY_VERSION = '1.0.0';

function toCamelCase(row) {
  return { tsUtc: row.ts_utc, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
}

function applyFee(value, feePercent) {
  return value * (feePercent / 100);
}

/**
 * Fetches (and DB-caches) every candle needed for a backtest over [startMs, endMs], including
 * warmup history before startMs so indicators aren't cold at the very first evaluated candle.
 * Separated from simulateStrategy() so the optimizer can fetch once and simulate many
 * parameter combinations against the same in-memory candle set, instead of re-fetching from
 * the exchange for every combination.
 *
 * `market` ('spot' default | 'futures') passes straight through to fetchHistoricalRange's own
 * spot/futures client split — see its comment. Omitting it is unchanged spot-only behavior.
 */
async function fetchCandlesForBacktest({ symbol, exchange, timeframe, startMs, endMs, market = 'spot' }) {
  const stepMs = timeframeToMs(timeframe);
  const warmupStartMs = startMs - WARMUP_CANDLES * stepMs;
  const rawCandles = await fetchHistoricalRange({ symbol, exchange, timeframe, sinceMs: warmupStartMs, untilMs: endMs, market });
  const candles = rawCandles.map(toCamelCase);

  const startIndex = candles.findIndex((c) => c.tsUtc >= startMs);
  if (startIndex === -1 || candles.length - startIndex < 2) {
    throw new Error('Not enough historical candles in the requested range to run a backtest.');
  }
  return { candles, startIndex };
}

/**
 * The core no-look-ahead simulation loop: pure and synchronous — no network/DB access — so it
 * can be called repeatedly (by the hyperopt-lite optimizer) against the same pre-fetched
 * candles without re-fetching. A signal is decided using only candles[0..i] and filled at
 * candle i+1's open, matching how a live/demo order placed after candle i closes would fill.
 * Never places an exchange order under any circumstance — this only ever touches in-memory
 * `cash`/`position` variables.
 */
function simulateStrategy({ candles, startIndex, symbol, initialCapital, feePercent, slippagePercent, riskSettings, config }) {
  let cash = initialCapital;
  let position = null;
  let pendingEntry = null;
  const trades = [];
  const equityCurve = [];
  const warnings = [];

  for (let i = startIndex; i < candles.length; i += 1) {
    const candle = candles[i];

    if (pendingEntry && !position) {
      const fillPrice = candle.open * (1 + slippagePercent / 100);
      const maxRiskAmount = computeMaxRiskAmount(cash, riskSettings.maxRiskPerTradePercent);
      const qty = computePositionSize(maxRiskAmount, fillPrice, pendingEntry.stopLoss);
      const orderValue = qty ? qty * fillPrice : 0;

      if (qty && qty > 0 && orderValue <= cash) {
        cash -= orderValue + applyFee(orderValue, feePercent);
        position = {
          side: 'buy', qty, entryPrice: fillPrice,
          stopLoss: pendingEntry.stopLoss, takeProfit: pendingEntry.takeProfit,
          entryTsUtc: new Date(candle.tsUtc).toISOString(), signalId: pendingEntry.signalId,
        };
      } else {
        warnings.push(`Skipped entry at ${new Date(candle.tsUtc).toISOString()}: insufficient capital for computed position size.`);
      }
      pendingEntry = null;
    }

    if (position) {
      let exitPrice = null;
      let exitReason = null;

      if (candle.low <= position.stopLoss) {
        exitPrice = position.stopLoss * (1 - slippagePercent / 100);
        exitReason = 'stop_loss';
      } else if (candle.high >= position.takeProfit) {
        exitPrice = position.takeProfit * (1 - slippagePercent / 100);
        exitReason = 'take_profit';
      }

      if (exitPrice !== null) {
        const exitValue = exitPrice * position.qty;
        cash += exitValue - applyFee(exitValue, feePercent);
        const pnl = (exitPrice - position.entryPrice) * position.qty;
        trades.push({
          symbol, side: position.side, entryPrice: position.entryPrice, exitPrice, qty: position.qty,
          enteredAtUtc: position.entryTsUtc, exitedAtUtc: new Date(candle.tsUtc).toISOString(), pnl,
          signalId: position.signalId, exitReason,
        });
        position = null;
      }
    }

    if (!position && !pendingEntry) {
      const window = candles.slice(0, i + 1);
      const indicators = computeAllIndicators(window);
      const signal = computeSignal({ candles: window, indicators, fundamentals: null, config, strategyVersion: STRATEGY_VERSION });
      if (signal.status === 'BUY' && signal.stopLoss !== null) {
        pendingEntry = { stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, signalId: null };
      }
    }

    const positionValue = position ? position.qty * candle.close : 0;
    equityCurve.push({ tsUtc: new Date(candle.tsUtc).toISOString(), equity: cash + positionValue });
  }

  if (position) {
    const lastCandle = candles[candles.length - 1];
    const exitPrice = lastCandle.close;
    const exitValue = exitPrice * position.qty;
    cash += exitValue - applyFee(exitValue, feePercent);
    const pnl = (exitPrice - position.entryPrice) * position.qty;
    trades.push({
      symbol, side: position.side, entryPrice: position.entryPrice, exitPrice, qty: position.qty,
      enteredAtUtc: position.entryTsUtc, exitedAtUtc: new Date(lastCandle.tsUtc).toISOString(), pnl,
      signalId: position.signalId, exitReason: 'end_of_backtest',
    });
    warnings.push('Open position at the end of the backtest window was force-closed at the final candle close.');
  }

  return { trades, equityCurve, warnings };
}

function buildScoringConfig(strategy, scoringConfig) {
  const config = { ...DEFAULT_SCORING_CONFIG, ...strategy, ...scoringConfig, fundamentalWeight: 0, technicalWeight: 1 };
  const warnings = [];
  if (strategy.fundamentalWeight > 0) {
    warnings.push(
      `Strategy "${strategy.name}" normally weighs fundamentals at ${(strategy.fundamentalWeight * 100).toFixed(0)}%, but historical fundamentals aren't available for backtesting — this run is technical-only (indicator weights still apply).`
    );
  }
  return { config, warnings };
}

/**
 * Historical simulation only — never places exchange orders. See simulateStrategy() for the
 * no-look-ahead mechanics; this wraps it with data fetching, DB persistence, and metrics.
 */
async function runBacktest({
  symbol,
  exchange,
  timeframe = '1h',
  startUtc,
  endUtc,
  initialCapital = 10000,
  feePercent = 0.1,
  slippagePercent = 0.05,
  riskSettings = { maxRiskPerTradePercent: 1, minRiskRewardRatio: 1.5 },
  strategyId = DEFAULT_STRATEGY_ID,
  scoringConfig = {},
}) {
  const runId = uuidv4();
  const startMs = new Date(startUtc).getTime();
  const endMs = new Date(endUtc).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Invalid backtest date range: endUtc must be after startUtc.');
  }

  const strategy = getStrategy(strategyId);

  backtestRepository.insertRun({
    id: runId, symbol, exchange, timeframe, startUtc, endUtc, initialCapital, feePercent, slippagePercent,
    strategyVersion: STRATEGY_VERSION, strategyId: strategy.id, createdAtUtc: new Date().toISOString(), metricsJson: null, status: 'running',
  });

  try {
    const { candles, startIndex } = await fetchCandlesForBacktest({ symbol, exchange, timeframe, startMs, endMs });
    const { config, warnings: configWarnings } = buildScoringConfig(strategy, scoringConfig);

    const { trades, equityCurve, warnings: simWarnings } = simulateStrategy({
      candles, startIndex, symbol, initialCapital, feePercent, slippagePercent, riskSettings, config,
    });
    const warnings = [...configWarnings, ...simWarnings];

    trades.forEach((t) => backtestRepository.insertTrade({ runId, ...t }));
    equityCurve.forEach((p) => backtestRepository.insertEquityPoint(runId, p.tsUtc, p.equity));

    const metrics = computeMetrics({ trades, equityCurve, initialCapital });
    const result = {
      runId, symbol, exchange, timeframe, startUtc, endUtc, initialCapital, feePercent, slippagePercent,
      strategyVersion: STRATEGY_VERSION, strategyId: strategy.id, strategyName: strategy.name, metrics, warnings,
      disclaimer: 'Past performance does not guarantee future results.',
    };

    backtestRepository.updateRun(runId, { metricsJson: JSON.stringify({ metrics, warnings }), status: 'completed' });
    return { ...result, trades, equityCurve };
  } catch (err) {
    logger.error('backtesting', `Backtest run ${runId} failed: ${err.message}`);
    backtestRepository.updateRun(runId, { metricsJson: JSON.stringify({ error: err.message }), status: 'failed' });
    throw err;
  }
}

module.exports = { runBacktest, fetchCandlesForBacktest, simulateStrategy, buildScoringConfig };
