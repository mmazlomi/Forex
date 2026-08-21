'use strict';

const { v4: uuidv4 } = require('uuid');
const { fetchHistoricalRange } = require('./historical-data');
const { computeAllIndicators } = require('../technical-analysis');
const { computeSignal, DEFAULT_SCORING_CONFIG } = require('../signals/scoring-engine');
const { getStrategy, DEFAULT_STRATEGY_ID } = require('../signals/strategies');
const { computeMaxRiskAmount, computePositionSize } = require('../risk/position-sizing');
const { computeAdaptiveTargets } = require('../risk/adaptive-take-profit-engine');
const { mergeConfig: mergeAdaptiveTpConfig } = require('../risk/adaptive-take-profit-config');
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

// Ascending order for a long: TP1 fires before TP2 before TP3 (matches computeAtrTargets/
// computeRMultipleTargets always producing TP1 < TP2 < TP3 above entry for a long — spot is
// long-only, so 'short' tiers are never exercised by this engine, only by
// reversal-backtest-engine.js which supports futures shorts).
const ADAPTIVE_TP_TIERS = ['tp1', 'tp2', 'tp3'];

/**
 * Builds the adaptive-TP fields a new position needs, or null if adaptiveTpConfig wasn't
 * supplied (the byte-identical-to-baseline path) or the engine couldn't compute any targets
 * (e.g. both ATR and stop-loss unavailable — fails safe by falling back to the single fixed
 * takeProfit already carried on pendingEntry, exactly like the non-adaptive path).
 */
function buildAdaptivePositionFields({ adaptiveTpConfig, entryPrice, stopLoss, entryIndicators }) {
  if (!adaptiveTpConfig) return null;
  const mergedConfig = mergeAdaptiveTpConfig(adaptiveTpConfig);
  const result = computeAdaptiveTargets({
    entryPrice,
    side: 'long',
    atr: entryIndicators.atr.status === 'ok' ? entryIndicators.atr.value : null,
    atrPercent: entryIndicators.atr.status === 'ok' ? (entryIndicators.atr.value / entryPrice) * 100 : null,
    stopLoss,
    trendStrength: entryIndicators.adx,
    marketStructure: entryIndicators.supportResistance,
    volumeCondition: entryIndicators.volumeAnalysis,
    config: mergedConfig,
  });
  if (result.TP1 === null) return null; // fails safe — caller keeps the single fixed takeProfit instead

  return {
    tp1: result.TP1, tp2: result.TP2, tp3: result.TP3,
    partialExitPercentages: result.partialExitPercentages,
    recommendedTrailingMultiplier: result.recommendedTrailingMultiplier,
    entryAtr: entryIndicators.atr.status === 'ok' ? entryIndicators.atr.value : null,
    filledTiers: new Set(),
    trailingActive: false,
    trailingStop: null,
    highWaterMark: entryPrice,
  };
}

/** Realizes one partial-exit leg (or the final full close) against `position`, mutating
 *  `position.qty` down and pushing a trade row. Returns the trade row pushed, for callers that
 *  need to log/aggregate it further. */
function realizePartialExit({ position, symbol, exitPrice, qty, exitReason, tsUtc, feePercent }) {
  const exitValue = exitPrice * qty;
  const pnl = (exitPrice - position.entryPrice) * qty;
  const fee = applyFee(exitValue, feePercent);
  position.qty -= qty;
  return { trade: { symbol, side: 'buy', entryPrice: position.entryPrice, exitPrice, qty, enteredAtUtc: position.entryTsUtc, exitedAtUtc: tsUtc, pnl, signalId: position.signalId, exitReason }, cashDelta: exitValue - fee };
}

/**
 * Adaptive-mode per-bar exit check: stop-loss (or the active trailing stop) first, then each
 * unfired TP tier in ascending order against this bar's high — handles a single bar gapping
 * through multiple tiers by checking all three in sequence rather than stopping at the first hit.
 * Mutates `position` (qty, filledTiers, trailing state) and `cash` (via the returned delta),
 * returns the list of trade rows produced this bar (0, 1, or several) and whether the position
 * is now fully closed.
 */
function checkAdaptiveExits({ position, candle, symbol, feePercent, slippagePercent }) {
  const producedTrades = [];
  let cashDelta = 0;
  const effectiveStop = position.trailingActive ? position.trailingStop : position.stopLoss;

  if (candle.low <= effectiveStop) {
    const exitPrice = effectiveStop * (1 - slippagePercent / 100);
    const { trade, cashDelta: delta } = realizePartialExit({
      position, symbol, exitPrice, qty: position.qty, exitReason: position.trailingActive ? 'trailing_stop' : 'stop_loss',
      tsUtc: new Date(candle.tsUtc).toISOString(), feePercent,
    });
    producedTrades.push(trade);
    cashDelta += delta;
    return { producedTrades, cashDelta, closed: true };
  }

  for (const tier of ADAPTIVE_TP_TIERS) {
    if (position.qty <= 0) break;
    if (position.filledTiers.has(tier)) continue;
    const tierPrice = position[tier];
    if (candle.high < tierPrice) continue;

    position.filledTiers.add(tier);
    const percentKey = tier;
    const tierQty = position.originalQty * (position.partialExitPercentages[percentKey] / 100);
    const clampedQty = Math.min(tierQty, position.qty);
    const exitPrice = tierPrice * (1 - slippagePercent / 100);
    const exitReasonMap = { tp1: 'take_profit_1', tp2: 'take_profit_2', tp3: 'take_profit_3' };
    const { trade, cashDelta: delta } = realizePartialExit({
      position, symbol, exitPrice, qty: clampedQty, exitReason: exitReasonMap[tier],
      tsUtc: new Date(candle.tsUtc).toISOString(), feePercent,
    });
    producedTrades.push(trade);
    cashDelta += delta;

    if (tier === 'tp1' && !position.trailingActive) {
      position.trailingActive = true;
      position.highWaterMark = Math.max(position.highWaterMark, candle.high);
      position.trailingStop = position.highWaterMark - position.entryAtr * position.recommendedTrailingMultiplier;
    }
  }

  // Dust threshold: once under 0.001% of the original size is left, treat it as fully closed
  // rather than leaving an economically-meaningless sliver open for the rest of the backtest.
  const closed = position.qty <= position.originalQty * 1e-5;
  if (position.trailingActive && !closed) {
    position.highWaterMark = Math.max(position.highWaterMark, candle.high);
    const candidateStop = position.highWaterMark - position.entryAtr * position.recommendedTrailingMultiplier;
    if (candidateStop > position.trailingStop) position.trailingStop = candidateStop; // monotonic — never loosens
  }

  return { producedTrades, cashDelta, closed };
}

/**
 * The core no-look-ahead simulation loop: pure and synchronous — no network/DB access — so it
 * can be called repeatedly (by the hyperopt-lite optimizer) against the same pre-fetched
 * candles without re-fetching. A signal is decided using only candles[0..i] and filled at
 * candle i+1's open, matching how a live/demo order placed after candle i closes would fill.
 * Never places an exchange order under any circumstance — this only ever touches in-memory
 * `cash`/`position` variables.
 *
 * `adaptiveTpConfig` (optional, default undefined): when omitted, behavior is BYTE-IDENTICAL to
 * before adaptive TP existed — single stop-loss/take-profit, full-qty close only. When supplied
 * (a partial override merged onto adaptive-take-profit-config.js's DEFAULT_CONFIG), entries use
 * AdaptiveTakeProfitEngine's TP1/TP2/TP3 with partial exits and an ATR-distance trailing stop
 * (activated once TP1 fires) instead of the flat `atrMultiplier * minRiskRewardRatio` target. Each
 * partial leg is recorded as its own row in `trades` (own exitReason: 'take_profit_1'/_2/_3/
 * 'trailing_stop'/'stop_loss'/'end_of_backtest') — there is no position-linking id, matching
 * backtest_trades' existing schema, so metrics.js scores each leg as an independent trade
 * (a TP1 partial win counts as a win) rather than requiring position-level grouping.
 */
function simulateStrategy({ candles, startIndex, symbol, initialCapital, feePercent, slippagePercent, riskSettings, config, adaptiveTpConfig }) {
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
          side: 'buy', qty, originalQty: qty, entryPrice: fillPrice,
          stopLoss: pendingEntry.stopLoss, takeProfit: pendingEntry.takeProfit,
          entryTsUtc: new Date(candle.tsUtc).toISOString(), signalId: pendingEntry.signalId,
        };
        const adaptiveFields = buildAdaptivePositionFields({
          adaptiveTpConfig, entryPrice: fillPrice, stopLoss: pendingEntry.stopLoss, entryIndicators: pendingEntry.entryIndicators,
        });
        if (adaptiveFields) Object.assign(position, adaptiveFields);
      } else {
        warnings.push(`Skipped entry at ${new Date(candle.tsUtc).toISOString()}: insufficient capital for computed position size.`);
      }
      pendingEntry = null;
    }

    if (position) {
      if (position.filledTiers) {
        // Adaptive path.
        const { producedTrades, cashDelta, closed } = checkAdaptiveExits({ position, candle, symbol, feePercent, slippagePercent });
        cash += cashDelta;
        trades.push(...producedTrades);
        if (closed) position = null;
      } else {
        // Baseline path — untouched from before adaptiveTpConfig existed.
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
    }

    if (!position && !pendingEntry) {
      const window = candles.slice(0, i + 1);
      const indicators = computeAllIndicators(window);
      const signal = computeSignal({ candles: window, indicators, fundamentals: null, config, strategyVersion: STRATEGY_VERSION });
      if (signal.status === 'BUY' && signal.stopLoss !== null) {
        pendingEntry = { stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, signalId: null, entryIndicators: indicators };
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

module.exports = {
  runBacktest, fetchCandlesForBacktest, simulateStrategy, buildScoringConfig,
  buildAdaptivePositionFields, checkAdaptiveExits, realizePartialExit,
};
