'use strict';

// Live (Demo/Real futures) driver for the Liquidity Sweep Reversal state machine — the Phase 2
// counterpart to reversal-backtest-engine.js. See docs/reversal-strategy/ARCHITECTURE.md §6 for
// why this is a thin, separate wrapper reusing every detector module rather than a rewrite: the
// only genuinely different edges are "where do candles come from" (live exchange fetch vs.
// in-memory backtest arrays) and "what happens on ENTRY_TRIGGERED" (return a decision for the
// caller to place a real order, vs. a simulated fill).
//
// State persistence: one `createReversalStateMachine` instance per (mode, userId, symbol,
// exchange), held in an in-memory Map for the life of the Node process. A setup that's mid-
// sequence (e.g. WAITING_FOR_CHOCH) is LOST on server restart — the machine simply starts fresh
// at IDLE, which is safe (worst case: one missed signal, never a wrong or duplicate entry) but is
// a real Phase 2 limitation worth knowing about; see docs/reversal-strategy/IMPLEMENTATION_PLAN.md.
//
// Position lifecycle is resynced from DB TRUTH every cycle, not trusted from the machine's own
// prior-cycle bookkeeping — the machine has no other way to learn that a position closed via
// position-risk-watcher.js (a completely separate scheduler) or that an order it triggered was
// rejected by the risk pipeline. See processLiveCycle's resync block below.

const marketDataService = require('../market-data/market-data-service');
const { timeframeToMs } = require('../market-data/candle-validator');
const { createReversalStateMachine, STATES } = require('./state-machine');
const { evaluateTrendFilter } = require('./htf-trend-filter');
const { isSessionAllowed } = require('./session-filter');
const { computeStopLoss } = require('./stop-loss');
const { computeTakeProfit } = require('./take-profit');
const { mergeConfig } = require('./config');
const { latestClosedCandleIndexAsOf } = require('./timeframe-alignment');

// Comfortably above every detector's own minimum (Ichimoku needs 78 HTF candles; RSI/swing need
// far fewer) so a freshly-added asset isn't stuck reporting "insufficient history" for weeks.
const HTF_FETCH_LIMIT = 150;
const SIGNAL_FETCH_LIMIT = 150;
const ENTRY_FETCH_LIMIT = 50;

function toCamelCase(row) {
  return { tsUtc: row.ts_utc, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
}

const liveStates = new Map();

function stateKey(market, mode, userId, symbol, exchange) {
  return `${market}:${mode}:${userId}:${symbol}:${exchange}`;
}

function getOrCreateLiveState(market, mode, userId, symbol, exchange, config) {
  const key = stateKey(market, mode, userId, symbol, exchange);
  let entry = liveStates.get(key);
  if (!entry) {
    entry = { machine: createReversalStateMachine(config), lastProcessedSignalTsUtc: -Infinity, lastProcessedEntryTsUtc: -Infinity };
    liveStates.set(key, entry);
  }
  return entry;
}

/** Test-only, mirrors this app's resetForTests() convention — clears every in-memory machine. */
function resetLiveStatesForTests() {
  liveStates.clear();
}

/** Test/observability-only accessor — the current state of one asset's live machine, or null if
 *  no cycle has ever run for it yet. `market` defaults to 'futures' to match every existing
 *  caller/test written before spot support existed. */
function getLiveStateForTests(mode, userId, symbol, exchange, market = 'futures') {
  return liveStates.get(stateKey(market, mode, userId, symbol, exchange)) || null;
}

/**
 * Read-only status for the Signals Setting "Results" table — a curated, JSON-safe summary of
 * where this asset's LSR state machine currently sits, for display only. Never advances the
 * machine itself (unlike processLiveCycle) — safe to call as often as the UI wants, including from
 * an on-demand "Generate" click, without corrupting lastProcessedEntryTsUtc/lastProcessedSignalTsUtc
 * bookkeeping the way calling processLiveCycle() outside the scheduler's own cadence would.
 * Returns null if no cycle has ever run for this (mode, userId, symbol, exchange, market) yet —
 * e.g. the asset was just added and the scheduler hasn't reached it, or the server restarted (see
 * this file's header comment: state is in-memory only, lost on restart).
 */
function getLiveStatus(mode, userId, symbol, exchange, market) {
  const entry = liveStates.get(stateKey(market, mode, userId, symbol, exchange));
  if (!entry) return null;
  const setup = entry.machine.getSetup();
  // "As of" this bar close — the more recent of the two timeframes' last-processed candle, i.e.
  // how current this status actually is. Both start at -Infinity until a cycle has processed at
  // least one bar on that timeframe; null (not a bogus 1970 date) until at least one has.
  const asOfMs = Math.max(entry.lastProcessedSignalTsUtc, entry.lastProcessedEntryTsUtc);
  return {
    state: entry.machine.getState(),
    direction: setup?.direction ?? null,
    chochLevel: setup?.chochLevel?.price ?? null,
    sweptLevel: setup?.sweep?.sweptLevel ?? null,
    asOfTsUtc: Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : null,
  };
}

async function fetchCandleSet({ symbol, exchange, timeframe, limit, market }) {
  const rows = await marketDataService.getCandles({ symbol, exchange, timeframe, limit, market });
  return rows.map(toCamelCase);
}

/**
 * Advances one asset's persistent LSR machine by one live cycle. Returns `null` when there is
 * nothing actionable this cycle, or `{ direction, stopLoss, takeProfit, sweep, chochLevel }` once
 * a new entry has been triggered and successfully priced (stop-loss computed) — the caller
 * (reversal-auto-trader.js / reversal-spot-auto-trader.js) is responsible for actually placing
 * the order and for filtering out directions its market can't execute (spot is long-only —
 * ignoring a 'bearish' decision is the CALLER's job, not this market-agnostic engine's; see
 * ARCHITECTURE.md §0/§6 on why the strategy engine itself never special-cases spot vs futures).
 *
 * @param {'spot'|'futures'} market which market's candles/exchange-client to use — see
 *        market-data-service.js#getCandles's identical param. Required (no default) so a caller
 *        must make an explicit choice rather than silently getting one market's data.
 * @param {boolean} hasOpenPosition DB truth: does an open position already exist for this
 *        symbol/mode/user right now? (from the appropriate positions repository)
 */
async function processLiveCycle({ market, mode, userId, symbol, exchange, hasOpenPosition, configOverrides = {} }) {
  const config = mergeConfig(configOverrides);
  const live = getOrCreateLiveState(market, mode, userId, symbol, exchange, config);
  const { machine } = live;

  // --- Resync position lifecycle from DB truth (see this file's header comment) ---
  if (hasOpenPosition) {
    if (machine.getState() === STATES.POSITION_OPEN || machine.getState() === STATES.POSITION_MANAGED) {
      machine.notifyPositionManaged();
    } else {
      machine.notifyPositionOpened({}); // covers both a fresh fill and a restart with a pre-existing open position
    }
    return null; // never advance detection/entry logic while a position is open
  }
  const currentState = machine.getState();
  if (currentState === STATES.POSITION_OPEN || currentState === STATES.POSITION_MANAGED) {
    machine.notifyPositionClosed({ reason: 'closed_externally' }); // position-risk-watcher.js hit SL/TP since our last cycle
  } else if (currentState === STATES.ENTRY_TRIGGERED) {
    machine.cancelEntry('ENTRY_NOT_FILLED'); // the order we triggered last cycle did not result in an open position (rejected)
  }

  // --- Fetch fresh candles ---
  const [htfCandles, signalCandles, entryCandles] = await Promise.all([
    fetchCandleSet({ symbol, exchange, timeframe: config.htfTimeframe, limit: HTF_FETCH_LIMIT, market }),
    fetchCandleSet({ symbol, exchange, timeframe: config.signalTimeframe, limit: SIGNAL_FETCH_LIMIT, market }),
    fetchCandleSet({ symbol, exchange, timeframe: config.entryTimeframe, limit: ENTRY_FETCH_LIMIT, market }),
  ]);
  if (htfCandles.length === 0 || signalCandles.length === 0 || entryCandles.length === 0) return null;

  const nowTsUtc = Date.now();

  // One HTF snapshot reused for every bar processed this cycle — see this file's header comment
  // on why this is a reasonable simplification vs. the backtest engine's per-bar dual cursor.
  const htfAsOfIndex = latestClosedCandleIndexAsOf(htfCandles, timeframeToMs(config.htfTimeframe), nowTsUtc);
  const allowedDirections = htfAsOfIndex === -1 ? [] : evaluateTrendFilter(htfCandles, htfAsOfIndex, config).allowedDirections;

  // --- Interleave signal- and entry-bar processing in chronological order ---
  //
  // Feeding ALL newly-closed signal bars in one pass BEFORE any entry bars (two separate full
  // passes) would corrupt state-machine timing references that are anchored to an ENTRY-bar
  // index — most concretely retestWaitStartIndex, set the first time onEntryBarClose sees
  // CHOCH_CONFIRMED. If every signal bar (including the CHOCH-breaking one) is fed first, the
  // machine reaches CHOCH_CONFIRMED before any entry bar has been processed at all, so that
  // lazy transition fires on entry-bar index 0 instead of the entry bar that was chronologically
  // concurrent with the real CHOCH bar — retestExpiryBars then counts from the wrong origin and
  // the setup expires long before the real retest ever arrives. Interleaving (catch up signal
  // bars closed as of THIS entry bar's own close time, then process the entry bar) avoids this —
  // exactly mirroring reversal-backtest-engine.js's identical interleaving for the same reason.
  const signalStepMs = timeframeToMs(config.signalTimeframe);
  const entryStepMs = timeframeToMs(config.entryTimeframe);

  let signalIdx = signalCandles.findIndex((c) => c.tsUtc > live.lastProcessedSignalTsUtc);
  if (signalIdx === -1) signalIdx = signalCandles.length;

  function catchUpSignalBars(uptoTsUtc) {
    while (signalIdx < signalCandles.length) {
      const sBar = signalCandles[signalIdx];
      const signalCloseTsUtc = sBar.tsUtc + signalStepMs;
      if (signalCloseTsUtc > uptoTsUtc) break;
      live.lastProcessedSignalTsUtc = sBar.tsUtc;
      if (isSessionAllowed(signalCloseTsUtc, config)) machine.onSignalBarClose(signalCandles, signalIdx, allowedDirections);
      signalIdx += 1;
    }
  }

  let triggered = null;
  for (let i = 0; i < entryCandles.length; i += 1) {
    const bar = entryCandles[i];
    if (bar.tsUtc <= live.lastProcessedEntryTsUtc) continue;
    const entryCloseTsUtc = bar.tsUtc + entryStepMs;
    if (entryCloseTsUtc > nowTsUtc) break; // not closed yet — candles are oldest-first, nothing later can be closed either

    catchUpSignalBars(entryCloseTsUtc);

    live.lastProcessedEntryTsUtc = bar.tsUtc;
    if (isSessionAllowed(entryCloseTsUtc, config)) {
      const events = machine.onEntryBarClose(entryCandles, i, allowedDirections);
      triggered = events.find((e) => e.state === STATES.ENTRY_TRIGGERED);
      if (triggered) break;
    }
  }
  // Pick up any remaining signal bars closed by now even if the entry loop exited early (a
  // trigger, or simply ran out of new entry bars) — sweep/divergence/CHOCH detection should keep
  // advancing every cycle regardless of whether the entry side had anything new to do.
  catchUpSignalBars(nowTsUtc);

  if (!triggered) return null;

  const stopLoss = computeStopLoss(signalCandles, triggered.sweep, triggered.direction, config);
  if (stopLoss === null) {
    machine.cancelEntry('SL_UNAVAILABLE'); // ATR model, insufficient history — see stop-loss.js
    return null;
  }
  const referencePrice = entryCandles[entryCandles.length - 1].close; // most recent close as a sizing reference; the real fill price comes from the exchange once the order is placed
  const takeProfit = computeTakeProfit(referencePrice, stopLoss, triggered.direction, config);

  return { direction: triggered.direction, stopLoss, takeProfit, sweep: triggered.sweep, chochLevel: triggered.chochLevel };
}

module.exports = { processLiveCycle, resetLiveStatesForTests, getLiveStateForTests, getLiveStatus };
