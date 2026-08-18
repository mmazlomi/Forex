'use strict';

// The orchestrating state machine — see docs/reversal-strategy/STRATEGY_SPEC.md §13. Ties every
// other detector module together across bars, with configurable expiry windows so a setup that
// stalls out is discarded rather than lingering forever.
//
//   IDLE -> LIQUIDITY_SWEEP_DETECTED -> DIVERGENCE_CONFIRMED -> WAITING_FOR_CHOCH -> CHOCH_CONFIRMED
//        -> WAITING_FOR_RETEST -> ENTRY_TRIGGERED -> POSITION_OPEN -> POSITION_MANAGED -> POSITION_CLOSED -> IDLE
//
// Two callers drive this, one per timeframe (see ARCHITECTURE.md §3's data flow):
//   - onSignalBarClose(...): called once per NEWLY CLOSED signal-timeframe bar. Owns
//     IDLE -> ... -> CHOCH_CONFIRMED (sweep, divergence, CHOCH all live on the signal timeframe).
//   - onEntryBarClose(...): called once per entry-timeframe bar. Owns
//     CHOCH_CONFIRMED -> WAITING_FOR_RETEST -> ENTRY_TRIGGERED (retest/confirmation is
//     finer-grained than CHOCH, by design — the CHOCH level is a fixed price, checkable at any
//     resolution). CHOCH_CONFIRMED is lazily upgraded to WAITING_FOR_RETEST on the first
//     entry-bar call after it, purely as bookkeeping — no detection logic happens in that step.
//
// LIQUIDITY_SWEEP_DETECTED -> DIVERGENCE_CONFIRMED collapses into the SAME onSignalBarClose call
// (see STRATEGY_SPEC.md §5's design decision — divergence is a property of the sweep bar itself,
// not a separately-timed later event) but is still emitted as two distinct events for
// observability, and the state field visibly passes through both.
//
// Position lifecycle (POSITION_OPEN/POSITION_MANAGED/POSITION_CLOSED) is driven by the backtest
// (or, later, live) engine calling notifyPositionOpened/notifyPositionManaged/notifyPositionClosed
// — this module never decides fills or SL/TP hits itself (see ARCHITECTURE.md §3).

const { detectSweep } = require('./liquidity-sweep-detector');
const { detectDivergence } = require('./rsi-divergence-detector');
const { findChochLevel, isChochBreak } = require('./market-structure');
const { isRetestTouch, isConfirmationCandle } = require('./retest-detector');

const STATES = Object.freeze({
  IDLE: 'IDLE',
  LIQUIDITY_SWEEP_DETECTED: 'LIQUIDITY_SWEEP_DETECTED',
  DIVERGENCE_CONFIRMED: 'DIVERGENCE_CONFIRMED',
  WAITING_FOR_CHOCH: 'WAITING_FOR_CHOCH',
  CHOCH_CONFIRMED: 'CHOCH_CONFIRMED',
  WAITING_FOR_RETEST: 'WAITING_FOR_RETEST',
  ENTRY_TRIGGERED: 'ENTRY_TRIGGERED',
  POSITION_OPEN: 'POSITION_OPEN',
  POSITION_MANAGED: 'POSITION_MANAGED',
  POSITION_CLOSED: 'POSITION_CLOSED',
});

function createReversalStateMachine(config) {
  let state = STATES.IDLE;
  let setup = null; // everything accumulated about the in-progress setup/position

  function toIdle(events, reason) {
    state = STATES.IDLE;
    setup = null;
    events.push({ state: STATES.IDLE, reason });
  }

  /** Called once per newly-closed signal-timeframe bar. Owns IDLE..CHOCH_CONFIRMED. */
  function onSignalBarClose(signalCandles, index, htfAllowedDirections) {
    const events = [];

    if (state === STATES.IDLE) {
      const sweep = detectSweep(signalCandles, index, config);
      if (!sweep || !htfAllowedDirections.includes(sweep.direction)) return events;
      events.push({ state: STATES.LIQUIDITY_SWEEP_DETECTED, sweep });

      const divergence = detectDivergence(signalCandles, sweep, config);
      if (!divergence) return events; // sweep alone is not enough — stays IDLE
      events.push({ state: STATES.DIVERGENCE_CONFIRMED, divergence });

      const chochLevel = findChochLevel(signalCandles, sweep.sweepIndex, sweep.direction, config.swingLookback);
      if (!chochLevel) return events; // nothing to break — stays IDLE

      setup = { sweep, divergence, direction: sweep.direction, chochLevel, chochWaitStartIndex: index };
      state = STATES.WAITING_FOR_CHOCH;
      events.push({ state: STATES.WAITING_FOR_CHOCH, chochLevel });
      return events;
    }

    if (state === STATES.WAITING_FOR_CHOCH) {
      const elapsed = index - setup.chochWaitStartIndex;
      if (elapsed > config.chochExpiryBars) {
        toIdle(events, 'CHOCH_EXPIRED');
        return events;
      }
      if (isChochBreak(signalCandles, index, setup.chochLevel, setup.direction, config.chochConfirmationBasis)) {
        setup.chochBarIndex = index;
        state = STATES.CHOCH_CONFIRMED;
        events.push({ state: STATES.CHOCH_CONFIRMED, chochBarIndex: index });
      }
      return events;
    }

    return events;
  }

  function triggerEntry(events, entryIndex, htfAllowedDirections) {
    if (!htfAllowedDirections.includes(setup.direction)) {
      toIdle(events, 'HTF_FILTER_REVOKED_AT_ENTRY');
      return events;
    }
    setup.entrySignalBarIndex = entryIndex;
    state = STATES.ENTRY_TRIGGERED;
    events.push({
      state: STATES.ENTRY_TRIGGERED,
      direction: setup.direction,
      sweep: setup.sweep,
      divergence: setup.divergence,
      chochLevel: setup.chochLevel,
      entrySignalBarIndex: entryIndex,
    });
    return events;
  }

  /** Called once per entry-timeframe bar. Owns CHOCH_CONFIRMED..ENTRY_TRIGGERED. No-op in every
   *  other state (including while a position is open — SL/TP is the caller's concern). */
  function onEntryBarClose(entryCandles, index, htfAllowedDirections) {
    const events = [];
    if (state !== STATES.CHOCH_CONFIRMED && state !== STATES.WAITING_FOR_RETEST) return events;

    let justTransitioned = false;
    if (state === STATES.CHOCH_CONFIRMED) {
      state = STATES.WAITING_FOR_RETEST;
      setup.retestWaitStartIndex = index;
      setup.retestTouchIndex = null;
      events.push({ state: STATES.WAITING_FOR_RETEST });
      justTransitioned = true;
    }

    if (config.entryMode === 'immediate') {
      return triggerEntry(events, index, htfAllowedDirections);
    }

    // The CHOCH breakout bar's own range necessarily spans the level it just broke (it opened on
    // one side and closed on the other) — that's the breakout itself, not a genuine pullback
    // retest. Start watching for a real retest from the NEXT bar onward.
    if (justTransitioned) return events;

    const level = setup.chochLevel.price;

    if (setup.retestTouchIndex === null) {
      const elapsed = index - setup.retestWaitStartIndex;
      if (elapsed > config.retestExpiryBars) {
        toIdle(events, 'RETEST_EXPIRED');
        return events;
      }
      if (!isRetestTouch(entryCandles, index, level, config.retestTolerancePercent)) return events;

      if (config.entryMode === 'retest') {
        return triggerEntry(events, index, htfAllowedDirections);
      }
      // retest_confirmation: remember the touch, now wait for a rejection candle.
      setup.retestTouchIndex = index;
      events.push({ state: STATES.WAITING_FOR_RETEST, retestTouchIndex: index });
      return events;
    }

    // Already touched the zone (retest_confirmation mode) — now waiting for the rejection candle.
    const confirmElapsed = index - setup.retestTouchIndex;
    if (confirmElapsed > config.confirmationExpiryBars) {
      toIdle(events, 'CONFIRMATION_EXPIRED');
      return events;
    }
    if (isConfirmationCandle(entryCandles, index, level, setup.direction, config.retestTolerancePercent)) {
      return triggerEntry(events, index, htfAllowedDirections);
    }
    return events;
  }

  // `setup` can legitimately be null here: live trading (live-engine.js) calls this to resync
  // from DB truth on a freshly-created machine (e.g. after a server restart with a pre-existing
  // open position, or a position opened manually rather than via this machine's own sequence) —
  // there's no sweep/divergence/CHOCH pedigree to attach it to in that case.
  function notifyPositionOpened(position) {
    if (!setup) setup = {};
    setup.position = position;
    state = STATES.POSITION_OPEN;
  }

  /** Live trading only (a backtest fill is always deterministic, so this never applies there) —
   *  discards an ENTRY_TRIGGERED setup whose order could not actually be filled (risk guard
   *  rejection, insufficient balance, exchange error, stop-loss unavailable, etc.), resetting to
   *  IDLE so a fresh setup can be tracked. No-op if the machine isn't currently ENTRY_TRIGGERED. */
  function cancelEntry(reason) {
    if (state !== STATES.ENTRY_TRIGGERED) return [];
    const events = [];
    toIdle(events, reason || 'ENTRY_CANCELLED');
    return events;
  }

  /** Call on every subsequent entry-timeframe bar the position stays open (after the fill bar). */
  function notifyPositionManaged() {
    if (state === STATES.POSITION_OPEN || state === STATES.POSITION_MANAGED) {
      state = STATES.POSITION_MANAGED;
    }
  }

  function notifyPositionClosed(exitInfo) {
    const events = [{ state: STATES.POSITION_CLOSED, exitInfo }];
    state = STATES.POSITION_CLOSED;
    setup = null;
    state = STATES.IDLE; // ready for the next setup — see STRATEGY_SPEC.md §13
    return events;
  }

  return {
    onSignalBarClose,
    onEntryBarClose,
    notifyPositionOpened,
    notifyPositionManaged,
    notifyPositionClosed,
    cancelEntry,
    getState: () => state,
    getSetup: () => setup,
  };
}

module.exports = { createReversalStateMachine, STATES };
