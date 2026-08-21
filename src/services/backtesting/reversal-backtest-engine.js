'use strict';

// Multi-timeframe, no-lookahead backtest engine for the Liquidity Sweep Reversal (LSR) strategy.
// See docs/reversal-strategy/ARCHITECTURE.md §3-5 for the full data-flow/no-lookahead design this
// implements. Mirrors backtest-engine.js's split between a pure `simulate*` core (reusable by an
// optimizer/walk-forward/sensitivity runner against the same pre-fetched candles) and a DB-aware
// `run*` wrapper — same convention, not shared code, since the execution models genuinely differ
// (see ARCHITECTURE.md §0 for why).

const { v4: uuidv4 } = require('uuid');
const { fetchHistoricalRange } = require('./historical-data');
const { timeframeToMs } = require('../market-data/candle-validator');
const { mergeConfig, validateConfig } = require('../reversal-strategy/config');
const { createReversalStateMachine, STATES } = require('../reversal-strategy/state-machine');
const { evaluateTrendFilter } = require('../reversal-strategy/htf-trend-filter');
const { isSessionAllowed } = require('../reversal-strategy/session-filter');
const { computeStopLoss } = require('../reversal-strategy/stop-loss');
const { computeTakeProfit } = require('../reversal-strategy/take-profit');
const { computeMaxRiskAmount, computePositionSize } = require('../risk/position-sizing');
const { createRiskGuardState, recordTradeResult, canOpenNewTrade } = require('../reversal-strategy/risk-guards');
const { createLookaheadSafeCursor } = require('../reversal-strategy/timeframe-alignment');
const { computeExtendedMetrics } = require('./reversal-metrics');
const { computeAllIndicators } = require('../technical-analysis');
const { computeAdaptiveTargets } = require('../risk/adaptive-take-profit-engine');
const { mergeConfig: mergeAdaptiveTpConfig } = require('../risk/adaptive-take-profit-config');
const backtestRepository = require('../../database/repositories/backtest-repository');
const logger = require('../logging/logger');

const STRATEGY_ID = 'liquidity-sweep-reversal';
const STRATEGY_NAME = 'Liquidity Sweep Reversal (LSR)';
const STRATEGY_VERSION = '1.0.0';

// Generous margins above each timeframe's own strictest indicator/lookback requirement (Ichimoku
// needs 78 HTF candles; RSI/swing detection need far fewer on the signal timeframe) so nothing
// reports "insufficient history" right at the start of the requested date range.
const WARMUP_HTF_CANDLES = 100;
const WARMUP_SIGNAL_CANDLES = 120;
const WARMUP_ENTRY_CANDLES = 20;

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

function toCamelCase(row) {
  return { tsUtc: row.ts_utc, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
}

function applyFee(value, feePercent) {
  return value * (feePercent / 100);
}

/**
 * Fetches (and DB-caches, via the existing candles cache) all three timeframes needed for one
 * LSR backtest over [startMs, endMs], each with its own warmup margin before startMs. Separated
 * from simulateReversalStrategy() so a future optimizer/walk-forward/sensitivity runner can fetch
 * once and simulate many parameter combinations in-memory — see optimizer.js's identical
 * rationale for the equivalent split in the existing single-timeframe engine.
 */
async function fetchReversalCandles({ symbol, exchange, startMs, endMs, market = 'spot', config }) {
  const htfStepMs = timeframeToMs(config.htfTimeframe);
  const signalStepMs = timeframeToMs(config.signalTimeframe);
  const entryStepMs = timeframeToMs(config.entryTimeframe);

  const [htfRaw, signalRaw, entryRaw] = await Promise.all([
    fetchHistoricalRange({ symbol, exchange, timeframe: config.htfTimeframe, sinceMs: startMs - WARMUP_HTF_CANDLES * htfStepMs, untilMs: endMs, market }),
    fetchHistoricalRange({ symbol, exchange, timeframe: config.signalTimeframe, sinceMs: startMs - WARMUP_SIGNAL_CANDLES * signalStepMs, untilMs: endMs, market }),
    fetchHistoricalRange({ symbol, exchange, timeframe: config.entryTimeframe, sinceMs: startMs - WARMUP_ENTRY_CANDLES * entryStepMs, untilMs: endMs, market }),
  ]);

  const htfCandles = htfRaw.map(toCamelCase);
  const signalCandles = signalRaw.map(toCamelCase);
  const entryCandles = entryRaw.map(toCamelCase);

  const entryStartIndex = entryCandles.findIndex((c) => c.tsUtc >= startMs);
  if (entryStartIndex === -1 || entryCandles.length - entryStartIndex < 2) {
    throw new Error('Not enough historical entry-timeframe candles in the requested range to run a backtest.');
  }
  if (signalCandles.length === 0 || htfCandles.length === 0) {
    throw new Error('Not enough historical signal/HTF-timeframe candles in the requested range to run a backtest.');
  }

  return { htfCandles, signalCandles, entryCandles, htfStepMs, signalStepMs, entryStepMs, entryStartIndex };
}

// Mirrors backtest-engine.js's identical adaptive-TP helpers (see its comments for the full
// rationale) — duplicated rather than shared, matching this file's own established "structural
// twin, not shared code" convention (see this file's header comment), since the execution models
// (single vs. triple timeframe, long-only vs. long+short) genuinely differ enough that a shared
// abstraction would need as many branches as just having two files. Side-aware for LSR's
// long+short support, unlike the spot-only engine's version.
const ADAPTIVE_TP_TIERS = ['tp1', 'tp2', 'tp3'];

/**
 * Builds adaptive-TP fields for a new position, or null if adaptiveTpConfig wasn't supplied or
 * the engine couldn't compute targets (fails safe — caller keeps the single fixed takeProfit).
 * `entryIndicators` is computed by the caller on signalCandles windowed to the triggering sweep's
 * own index (never later data) — same no-lookahead convention stop-loss.js's 'atr' model already
 * uses for this exact setup, kept consistent here rather than windowing to a different point.
 */
function buildAdaptivePositionFieldsReversal({ adaptiveTpConfig, entryPrice, side, stopLoss, entryIndicators }) {
  if (!adaptiveTpConfig) return null;
  const mergedConfig = mergeAdaptiveTpConfig(adaptiveTpConfig);
  const result = computeAdaptiveTargets({
    entryPrice,
    side,
    atr: entryIndicators.atr.status === 'ok' ? entryIndicators.atr.value : null,
    atrPercent: entryIndicators.atr.status === 'ok' ? (entryIndicators.atr.value / entryPrice) * 100 : null,
    stopLoss,
    trendStrength: entryIndicators.adx,
    marketStructure: entryIndicators.supportResistance,
    volumeCondition: entryIndicators.volumeAnalysis,
    config: mergedConfig,
  });
  if (result.TP1 === null) return null;

  return {
    tp1: result.TP1, tp2: result.TP2, tp3: result.TP3,
    partialExitPercentages: result.partialExitPercentages,
    recommendedTrailingMultiplier: result.recommendedTrailingMultiplier,
    entryAtr: entryIndicators.atr.status === 'ok' ? entryIndicators.atr.value : null,
    filledTiers: new Set(),
    trailingActive: false,
    trailingStop: null,
    highWaterMark: entryPrice, // ratchets up (long) or down (short) from here once trailing activates
  };
}

function realizePartialExitReversal({ position, symbol, exitPrice, qty, exitReason, tsUtc, feePercent, dirMult }) {
  const exitValue = exitPrice * qty;
  const grossPnl = dirMult * (exitPrice - position.entryPrice) * qty;
  const fee = applyFee(exitValue, feePercent);
  const pnl = grossPnl - fee;
  position.qty -= qty;
  return {
    trade: {
      symbol, side: position.direction === 'bullish' ? 'long' : 'short', entryPrice: position.entryPrice, exitPrice, qty,
      enteredAtUtc: position.entryTsUtc, exitedAtUtc: tsUtc, pnl, exitReason,
      signalId: null, sweepIndex: position.sweep.sweepIndex, chochLevel: position.chochLevel.price,
      stopLoss: position.stopLoss, takeProfit: position.tp3,
    },
    cashDelta: pnl,
  };
}

/** Side-aware version of backtest-engine.js's checkAdaptiveExits — see its comments for the
 *  shape/reasoning; the only real difference is direction-awareness (a short's tiers sit BELOW
 *  entry and its stop/trailing-stop condition is bar.high, mirroring bullish throughout). */
function checkAdaptiveExitsReversal({ position, bar, symbol, feePercent, slippagePercent }) {
  const isBullish = position.direction === 'bullish';
  const dirMult = isBullish ? 1 : -1;
  const producedTrades = [];
  let cashDelta = 0;
  const effectiveStop = position.trailingActive ? position.trailingStop : position.stopLoss;

  const stopHit = isBullish ? bar.low <= effectiveStop : bar.high >= effectiveStop;
  if (stopHit) {
    const exitPrice = effectiveStop * (1 + (isBullish ? -1 : 1) * (slippagePercent / 100));
    const { trade, cashDelta: delta } = realizePartialExitReversal({
      position, symbol, exitPrice, qty: position.qty, exitReason: position.trailingActive ? 'trailing_stop' : 'stop_loss',
      tsUtc: new Date(bar.tsUtc).toISOString(), feePercent, dirMult,
    });
    producedTrades.push(trade);
    cashDelta += delta;
    return { producedTrades, cashDelta, closed: true };
  }

  for (const tier of ADAPTIVE_TP_TIERS) {
    if (position.qty <= 0) break;
    if (position.filledTiers.has(tier)) continue;
    const tierPrice = position[tier];
    const tierHit = isBullish ? bar.high >= tierPrice : bar.low <= tierPrice;
    if (!tierHit) continue;

    position.filledTiers.add(tier);
    const tierQty = position.originalQty * (position.partialExitPercentages[tier] / 100);
    const clampedQty = Math.min(tierQty, position.qty);
    const exitPrice = tierPrice * (1 + (isBullish ? -1 : 1) * (slippagePercent / 100));
    const exitReasonMap = { tp1: 'take_profit_1', tp2: 'take_profit_2', tp3: 'take_profit_3' };
    const { trade, cashDelta: delta } = realizePartialExitReversal({
      position, symbol, exitPrice, qty: clampedQty, exitReason: exitReasonMap[tier],
      tsUtc: new Date(bar.tsUtc).toISOString(), feePercent, dirMult,
    });
    producedTrades.push(trade);
    cashDelta += delta;

    if (tier === 'tp1' && !position.trailingActive) {
      position.trailingActive = true;
      position.highWaterMark = isBullish ? Math.max(position.highWaterMark, bar.high) : Math.min(position.highWaterMark, bar.low);
      position.trailingStop = isBullish
        ? position.highWaterMark - position.entryAtr * position.recommendedTrailingMultiplier
        : position.highWaterMark + position.entryAtr * position.recommendedTrailingMultiplier;
    }
  }

  const closed = position.qty <= position.originalQty * 1e-5;
  if (position.trailingActive && !closed) {
    if (isBullish) {
      position.highWaterMark = Math.max(position.highWaterMark, bar.high);
      const candidateStop = position.highWaterMark - position.entryAtr * position.recommendedTrailingMultiplier;
      if (candidateStop > position.trailingStop) position.trailingStop = candidateStop; // never loosens
    } else {
      position.highWaterMark = Math.min(position.highWaterMark, bar.low);
      const candidateStop = position.highWaterMark + position.entryAtr * position.recommendedTrailingMultiplier;
      if (candidateStop < position.trailingStop) position.trailingStop = candidateStop; // never loosens
    }
  }

  return { producedTrades, cashDelta, closed };
}

/**
 * The core no-look-ahead simulation loop — pure and synchronous, no network/DB access. See
 * ARCHITECTURE.md §3 for the bar-by-bar data flow this implements and §4 for exactly how each
 * step avoids lookahead. Position accounting is mark-to-market / margin-free (cash is debited
 * only by fees, credited/debited by realized P&L on close — Phase 1 does not model leverage or a
 * margin call; see docs/reversal-strategy/IMPLEMENTATION_PLAN.md's known-limitations list).
 */
function simulateReversalStrategy({ htfCandles, signalCandles, entryCandles, htfStepMs, signalStepMs, entryStepMs, entryStartIndex, symbol, initialCapital, feePercent, slippagePercent, config, adaptiveTpConfig }) {
  let cash = initialCapital;
  let position = null;
  let pendingEntry = null;
  const trades = [];
  const equityCurve = [];
  const warnings = [];

  const machine = createReversalStateMachine(config);
  const riskGuardState = createRiskGuardState();

  // Two independent HTF cursors: one advanced by signal-bar close times (gates a NEW setup from
  // starting), one advanced by entry-bar close times (re-checked right at the moment of firing an
  // entry) — see this file's header comment on why they must be separate cursor instances.
  const htfCursorForSignal = createLookaheadSafeCursor(htfCandles, htfStepMs);
  const htfCursorForEntry = createLookaheadSafeCursor(htfCandles, htfStepMs);
  const signalCursor = createLookaheadSafeCursor(signalCandles, signalStepMs);
  let lastProcessedSignalIndex = -1;

  function directionMultiplier(dir) {
    return dir === 'bullish' ? 1 : -1;
  }

  /** Runs onSignalBarClose for every signal-timeframe bar that has newly closed as of `atTsUtc`,
   *  in chronological order (never skipping one, even if several closed between two entry bars —
   *  correctness of the sequential state machine depends on seeing every bar in order). */
  function processNewlyClosedSignalBars(atTsUtc) {
    const result = signalCursor.advanceTo(atTsUtc);
    if (!result) return;
    for (let idx = lastProcessedSignalIndex + 1; idx <= result.index; idx += 1) {
      const signalBarCloseTsUtc = signalCandles[idx].tsUtc + signalStepMs;
      const htfResult = htfCursorForSignal.advanceTo(signalBarCloseTsUtc);
      const allowedDirections = htfResult ? evaluateTrendFilter(htfCandles, htfResult.index, config).allowedDirections : [];
      if (isSessionAllowed(signalBarCloseTsUtc, config)) {
        machine.onSignalBarClose(signalCandles, idx, allowedDirections);
      }
    }
    lastProcessedSignalIndex = result.index;
  }

  for (let i = entryStartIndex; i < entryCandles.length; i += 1) {
    const bar = entryCandles[i];
    // "Now" for every causality check below is bar i's OWN CLOSE time (tsUtc is open time, per
    // this codebase's ccxt-standard convention — see timeframe-alignment.js's header comment) —
    // we are deciding things AFTER this bar has closed, using its own O/H/L/C, exactly like every
    // other per-bar decision point in this engine. Using bar.tsUtc (its OPEN time) here would be
    // a subtle lookahead-adjacent bug: it would make a signal/HTF bar that closes exactly when
    // bar i opens look like it "hasn't closed yet" one bar too late.
    const barCloseTsUtc = bar.tsUtc + entryStepMs;

    // 1. Advance sweep/divergence/CHOCH detection for any signal-timeframe bar(s) that closed by now.
    processNewlyClosedSignalBars(barCloseTsUtc);

    // 2. Fill any pending entry decided on a PRIOR bar, at THIS bar's open (one-bar execution lag
    //    — see STRATEGY_SPEC.md §8).
    if (pendingEntry && !position) {
      const fillPrice = bar.open * (1 + directionMultiplier(pendingEntry.direction) * (slippagePercent / 100));
      const takeProfit = computeTakeProfit(fillPrice, pendingEntry.stopLoss, pendingEntry.direction, config);
      const maxRiskAmount = computeMaxRiskAmount(cash, config.riskPerTradePercent);
      const qty = computePositionSize(maxRiskAmount, fillPrice, pendingEntry.stopLoss);

      const guard = canOpenNewTrade(riskGuardState, { tsUtc: bar.tsUtc, equity: cash, config });
      if (!guard.allowed) {
        warnings.push(`Skipped entry at ${new Date(bar.tsUtc).toISOString()}: risk guard blocked (${guard.reason}).`);
      } else if (qty && qty > 0) {
        cash -= applyFee(qty * fillPrice, feePercent);
        position = {
          direction: pendingEntry.direction, qty, originalQty: qty, entryPrice: fillPrice,
          stopLoss: pendingEntry.stopLoss, takeProfit,
          entryTsUtc: new Date(bar.tsUtc).toISOString(), sweep: pendingEntry.sweep, chochLevel: pendingEntry.chochLevel,
        };
        const adaptiveFields = buildAdaptivePositionFieldsReversal({
          adaptiveTpConfig, entryPrice: fillPrice, side: pendingEntry.direction === 'bullish' ? 'long' : 'short',
          stopLoss: pendingEntry.stopLoss, entryIndicators: pendingEntry.entryIndicators,
        });
        if (adaptiveFields) Object.assign(position, adaptiveFields);
        riskGuardState.openTradesCount += 1;
        machine.notifyPositionOpened(position);
      } else {
        warnings.push(`Skipped entry at ${new Date(bar.tsUtc).toISOString()}: could not size a position (zero risk distance).`);
      }
      pendingEntry = null;
    }

    // 3. Manage an open position: check SL/TP against this bar's high/low. Stop-loss is checked
    //    before take-profit when a single bar could plausibly have hit both — the conservative
    //    assumption (see ARCHITECTURE.md §5), matching the existing spot engine exactly.
    if (position && position.filledTiers) {
      // Adaptive path — partial exits + trailing, side-aware. Risk-guard/state-machine bookkeeping
      // (recordTradeResult, openTradesCount, notifyPositionClosed) only fires once, on the leg that
      // FULLY closes the position, using the SUM of every leg's pnl — partial legs don't touch the
      // risk guards or state machine at all, since the position is still open.
      const { producedTrades, cashDelta, closed } = checkAdaptiveExitsReversal({ position, bar, symbol, feePercent, slippagePercent });
      cash += cashDelta;
      trades.push(...producedTrades);
      position.realizedPnlSum = (position.realizedPnlSum || 0) + producedTrades.reduce((sum, t) => sum + t.pnl, 0);
      if (closed) {
        recordTradeResult(riskGuardState, { pnl: position.realizedPnlSum, closedAtTsUtc: bar.tsUtc });
        riskGuardState.openTradesCount -= 1;
        const lastTrade = producedTrades[producedTrades.length - 1];
        machine.notifyPositionClosed({ exitPrice: lastTrade.exitPrice, reason: lastTrade.exitReason, pnl: position.realizedPnlSum });
        position = null;
      } else {
        machine.notifyPositionManaged();
      }
    } else if (position) {
      // Baseline path — untouched from before adaptiveTpConfig existed.
      let exitPrice = null;
      let exitReason = null;
      const dirMult = directionMultiplier(position.direction);

      if (position.direction === 'bullish') {
        if (bar.low <= position.stopLoss) { exitPrice = position.stopLoss * (1 - slippagePercent / 100); exitReason = 'stop_loss'; }
        else if (bar.high >= position.takeProfit) { exitPrice = position.takeProfit * (1 - slippagePercent / 100); exitReason = 'take_profit'; }
      } else {
        if (bar.high >= position.stopLoss) { exitPrice = position.stopLoss * (1 + slippagePercent / 100); exitReason = 'stop_loss'; }
        else if (bar.low <= position.takeProfit) { exitPrice = position.takeProfit * (1 + slippagePercent / 100); exitReason = 'take_profit'; }
      }

      if (exitPrice !== null) {
        const grossPnl = dirMult * (exitPrice - position.entryPrice) * position.qty;
        const exitFee = applyFee(exitPrice * position.qty, feePercent);
        const pnl = grossPnl - exitFee;
        cash += pnl;
        const exitedAtUtc = new Date(bar.tsUtc).toISOString();
        trades.push({
          symbol, side: position.direction === 'bullish' ? 'long' : 'short',
          entryPrice: position.entryPrice, exitPrice, qty: position.qty,
          enteredAtUtc: position.entryTsUtc, exitedAtUtc, pnl, exitReason,
          signalId: null, sweepIndex: position.sweep.sweepIndex, chochLevel: position.chochLevel.price,
          stopLoss: position.stopLoss, takeProfit: position.takeProfit,
        });
        recordTradeResult(riskGuardState, { pnl, closedAtTsUtc: bar.tsUtc });
        riskGuardState.openTradesCount -= 1;
        machine.notifyPositionClosed({ exitPrice, reason: exitReason, pnl });
        position = null;
      } else {
        machine.notifyPositionManaged();
      }
    }

    // 4. If flat, advance the retest/entry-confirmation logic on the entry timeframe.
    if (!position && !pendingEntry && isSessionAllowed(barCloseTsUtc, config)) {
      const htfEntryResult = htfCursorForEntry.advanceTo(barCloseTsUtc);
      const allowedAtEntry = htfEntryResult ? evaluateTrendFilter(htfCandles, htfEntryResult.index, config).allowedDirections : [];
      const entryEvents = machine.onEntryBarClose(entryCandles, i, allowedAtEntry);
      const triggered = entryEvents.find((e) => e.state === STATES.ENTRY_TRIGGERED);
      if (triggered) {
        const stopLoss = computeStopLoss(signalCandles, triggered.sweep, triggered.direction, config);
        if (stopLoss === null) {
          warnings.push(`Entry at ${new Date(bar.tsUtc).toISOString()} skipped: ATR stop-loss unavailable (insufficient history).`);
        } else {
          // Windowed to the sweep's own index (never later data) — same no-lookahead convention
          // stop-loss.js's 'atr' model already uses for this exact setup, kept consistent here.
          const entryIndicators = adaptiveTpConfig ? computeAllIndicators(signalCandles.slice(0, triggered.sweep.sweepIndex + 1)) : null;
          pendingEntry = { direction: triggered.direction, stopLoss, sweep: triggered.sweep, chochLevel: triggered.chochLevel, entryIndicators };
        }
      }
    }

    const unrealizedPnl = position ? directionMultiplier(position.direction) * (bar.close - position.entryPrice) * position.qty : 0;
    equityCurve.push({ tsUtc: new Date(bar.tsUtc).toISOString(), equity: cash + unrealizedPnl });
  }

  if (position) {
    const lastBar = entryCandles[entryCandles.length - 1];
    const exitPrice = lastBar.close;
    const dirMult = directionMultiplier(position.direction);
    const grossPnl = dirMult * (exitPrice - position.entryPrice) * position.qty;
    const pnl = grossPnl - applyFee(exitPrice * position.qty, feePercent);
    cash += pnl;
    trades.push({
      symbol, side: position.direction === 'bullish' ? 'long' : 'short',
      entryPrice: position.entryPrice, exitPrice, qty: position.qty,
      enteredAtUtc: position.entryTsUtc, exitedAtUtc: new Date(lastBar.tsUtc).toISOString(), pnl, exitReason: 'end_of_backtest',
      signalId: null, sweepIndex: position.sweep.sweepIndex, chochLevel: position.chochLevel.price,
      stopLoss: position.stopLoss, takeProfit: position.takeProfit,
    });
    warnings.push('Open position at the end of the backtest window was force-closed at the final candle close.');
  }

  return { trades, equityCurve, warnings };
}

/**
 * Historical simulation only — never places an exchange order, demo or real. Fetches all three
 * timeframes, runs the simulation, persists to the SAME backtest_runs/backtest_trades/
 * backtest_equity_curve tables the existing spot engine uses (strategy_id='liquidity-sweep-reversal'
 * distinguishes these rows — no schema change needed, those columns were already free-text/nullable).
 */
async function runReversalBacktest({
  symbol,
  exchange,
  market = 'spot',
  startUtc,
  endUtc,
  initialCapital = 10000,
  feePercent = 0.1,
  slippagePercent = 0.05,
  configOverrides = {},
  adaptiveTpConfig,
}) {
  const config = mergeConfig(configOverrides);
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    throw new Error(`Invalid reversal-strategy config: ${configErrors.join('; ')}`);
  }

  const runId = uuidv4();
  const startMs = new Date(startUtc).getTime();
  const endMs = new Date(endUtc).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Invalid backtest date range: endUtc must be after startUtc.');
  }

  backtestRepository.insertRun({
    id: runId, symbol, exchange, timeframe: config.entryTimeframe, startUtc, endUtc, initialCapital, feePercent, slippagePercent,
    strategyVersion: STRATEGY_VERSION, strategyId: STRATEGY_ID, createdAtUtc: new Date().toISOString(), metricsJson: null, status: 'running',
  });

  try {
    const fetched = await fetchReversalCandles({ symbol, exchange, startMs, endMs, market, config });
    const { trades, equityCurve, warnings } = simulateReversalStrategy({ ...fetched, symbol, initialCapital, feePercent, slippagePercent, config, adaptiveTpConfig });

    // backtest_trades has no columns for sweepIndex/chochLevel (LSR-specific context, useful in
    // the in-memory/returned trade objects for the final report, but not part of the shared
    // schema) — node:sqlite's DatabaseSync throws on an unbound named parameter, so only the
    // known columns are passed through here.
    trades.forEach(({ symbol: tradeSymbol, side, entryPrice, exitPrice, qty, enteredAtUtc, exitedAtUtc, pnl, signalId, exitReason }) => {
      backtestRepository.insertTrade({ runId, symbol: tradeSymbol, side, entryPrice, exitPrice, qty, enteredAtUtc, exitedAtUtc, pnl, signalId, exitReason });
    });
    equityCurve.forEach((p) => backtestRepository.insertEquityPoint(runId, p.tsUtc, p.equity));

    const entryStepMs = fetched.entryStepMs;
    const periodsPerYear = MS_PER_YEAR / entryStepMs;
    const metrics = computeExtendedMetrics({ trades, equityCurve, initialCapital, periodsPerYear });

    const result = {
      runId, symbol, exchange, market, startUtc, endUtc, initialCapital, feePercent, slippagePercent,
      strategyVersion: STRATEGY_VERSION, strategyId: STRATEGY_ID, strategyName: STRATEGY_NAME,
      config, metrics, warnings,
      disclaimer: 'Past performance does not guarantee future results. This is a research backtest, not a live-trading recommendation.',
    };

    backtestRepository.updateRun(runId, { metricsJson: JSON.stringify({ metrics, warnings }), status: 'completed' });
    return { ...result, trades, equityCurve };
  } catch (err) {
    logger.error('reversal-backtesting', `Reversal backtest run ${runId} failed: ${err.message}`);
    backtestRepository.updateRun(runId, { metricsJson: JSON.stringify({ error: err.message }), status: 'failed' });
    throw err;
  }
}

module.exports = {
  runReversalBacktest,
  simulateReversalStrategy,
  fetchReversalCandles,
  buildAdaptivePositionFieldsReversal,
  checkAdaptiveExitsReversal,
  realizePartialExitReversal,
  STRATEGY_ID,
  STRATEGY_NAME,
  STRATEGY_VERSION,
};
