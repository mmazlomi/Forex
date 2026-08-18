'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReversalStateMachine, STATES } = require('../../../src/services/reversal-strategy/state-machine');
const { mergeConfig } = require('../../../src/services/reversal-strategy/config');
const {
  candle,
  SCENARIO_CONFIG_OVERRIDES,
  SCENARIO_INDICES,
  buildBullishReversalCandles,
  buildBearishReversalCandles,
} = require('../../fixtures/reversal-scenarios');

const ALL_DIRECTIONS = ['bullish', 'bearish'];

function runToEntry(candles, config, htfAllowedDirections = ALL_DIRECTIONS) {
  const machine = createReversalStateMachine(config);
  const trace = [];
  for (let i = 0; i < candles.length; i += 1) {
    const sig = machine.onSignalBarClose(candles, i, htfAllowedDirections);
    const ent = machine.onEntryBarClose(candles, i, htfAllowedDirections);
    for (const e of [...sig, ...ent]) trace.push({ index: i, ...e });
    if (machine.getState() === STATES.ENTRY_TRIGGERED) return { fireIndex: i, machine, trace };
  }
  return { fireIndex: null, machine, trace };
}

test('bullish scenario: entryMode=immediate fires at the CHOCH bar itself', () => {
  const candles = buildBullishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'immediate' });
  const { fireIndex, machine } = runToEntry(candles, config);
  assert.equal(fireIndex, SCENARIO_INDICES.choch);
  assert.equal(machine.getSetup().direction, 'bullish');
});

test('bullish scenario: entryMode=retest fires at the first retest-zone touch, not the CHOCH bar', () => {
  const candles = buildBullishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest' });
  const { fireIndex } = runToEntry(candles, config);
  assert.equal(fireIndex, SCENARIO_INDICES.retestTouch);
});

test('bullish scenario: entryMode=retest_confirmation fires only after a genuine rejection candle', () => {
  const candles = buildBullishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation' });
  const { fireIndex, machine, trace } = runToEntry(candles, config);
  assert.equal(fireIndex, SCENARIO_INDICES.confirmation);

  // The full expected sequence of state names, in order, with no skipped stage.
  const sequence = trace.map((e) => e.state);
  assert.deepEqual(sequence, [
    STATES.LIQUIDITY_SWEEP_DETECTED,
    STATES.DIVERGENCE_CONFIRMED,
    STATES.WAITING_FOR_CHOCH,
    STATES.CHOCH_CONFIRMED,
    STATES.WAITING_FOR_RETEST, // lazy entry-timeframe bookkeeping transition
    STATES.WAITING_FOR_RETEST, // the zone-touch bar
    STATES.ENTRY_TRIGGERED,
  ]);
  const setup = machine.getSetup();
  assert.equal(setup.sweep.sweepIndex, SCENARIO_INDICES.sweep);
  assert.equal(setup.chochBarIndex, SCENARIO_INDICES.choch);
  assert.equal(setup.retestTouchIndex, SCENARIO_INDICES.retestTouch);
});

test('bearish scenario mirrors the bullish one exactly, direction inverted', () => {
  const candles = buildBearishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation' });
  const { fireIndex, machine } = runToEntry(candles, config);
  assert.equal(fireIndex, SCENARIO_INDICES.confirmation);
  assert.equal(machine.getSetup().direction, 'bearish');
});

test('the HTF filter vetoes a setup from ever starting when the sweep direction is not allowed', () => {
  const candles = buildBullishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'immediate' });
  const { fireIndex, machine } = runToEntry(candles, config, ['bearish']); // only SHORT allowed
  assert.equal(fireIndex, null);
  assert.equal(machine.getState(), STATES.IDLE);
});

test('the HTF filter re-checked at entry time cancels a setup if the trend flips mid-sequence', () => {
  const candles = buildBullishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'immediate' });
  const machine = createReversalStateMachine(config);
  for (let i = 0; i < candles.length; i += 1) {
    // Allow bullish everywhere EXCEPT right at the CHOCH/entry bar, simulating the HTF trend
    // flipping away just as the setup was about to fire.
    const allowed = i === SCENARIO_INDICES.choch ? ['bearish'] : ALL_DIRECTIONS;
    machine.onSignalBarClose(candles, i, allowed);
    const events = machine.onEntryBarClose(candles, i, allowed);
    if (i === SCENARIO_INDICES.choch) {
      assert.ok(events.some((e) => e.state === STATES.IDLE && e.reason === 'HTF_FILTER_REVOKED_AT_ENTRY'));
      assert.equal(machine.getState(), STATES.IDLE);
      return;
    }
  }
  assert.fail('expected the HTF-revoked-at-entry branch to have returned already');
});

test('WAITING_FOR_CHOCH expires and resets to IDLE if price never breaks the level in time', () => {
  const candles = buildBullishReversalCandles();
  // chochExpiryBars=2 is far too short for this scenario's real gap (sweep@33 -> choch@49 = 16 bars)
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'immediate', chochExpiryBars: 2 });
  const { fireIndex, machine } = runToEntry(candles, config);
  assert.equal(fireIndex, null);
  assert.equal(machine.getState(), STATES.IDLE);
});

test('WAITING_FOR_RETEST expires and resets to IDLE if price never retests in time', () => {
  const candles = buildBullishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest', retestExpiryBars: 0 });
  const { fireIndex, machine } = runToEntry(candles, config);
  assert.equal(fireIndex, null);
  assert.equal(machine.getState(), STATES.IDLE);
});

test('retest_confirmation expires if a touch happens but no rejection candle follows in time', () => {
  const candles = buildBullishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation', confirmationExpiryBars: 0 });
  const { fireIndex, machine } = runToEntry(candles, config);
  assert.equal(fireIndex, null);
  assert.equal(machine.getState(), STATES.IDLE);
});

test('a flat/no-signal series never leaves IDLE', () => {
  const candles = Array.from({ length: 60 }, () => candle(100, 100.5, 99.5, 100));
  const config = mergeConfig(SCENARIO_CONFIG_OVERRIDES);
  const { fireIndex, machine } = runToEntry(candles, config);
  assert.equal(fireIndex, null);
  assert.equal(machine.getState(), STATES.IDLE);
});

test('position lifecycle notifications move the machine through OPEN -> MANAGED -> CLOSED -> IDLE', () => {
  // Drive it to ENTRY_TRIGGERED first via the proven scenario.
  const candles = buildBullishReversalCandles();
  const configImmediate = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'immediate' });
  const driven = createReversalStateMachine(configImmediate);
  for (let i = 0; i <= SCENARIO_INDICES.choch; i += 1) {
    driven.onSignalBarClose(candles, i, ALL_DIRECTIONS);
    driven.onEntryBarClose(candles, i, ALL_DIRECTIONS);
  }
  assert.equal(driven.getState(), STATES.ENTRY_TRIGGERED);

  driven.notifyPositionOpened({ entryPrice: 108, stopLoss: 74, takeProfit: 176 });
  assert.equal(driven.getState(), STATES.POSITION_OPEN);

  driven.notifyPositionManaged();
  assert.equal(driven.getState(), STATES.POSITION_MANAGED);
  driven.notifyPositionManaged(); // idempotent on subsequent bars
  assert.equal(driven.getState(), STATES.POSITION_MANAGED);

  const closeEvents = driven.notifyPositionClosed({ exitPrice: 176, reason: 'take_profit', pnl: 68 });
  assert.equal(closeEvents[0].state, STATES.POSITION_CLOSED);
  assert.equal(driven.getState(), STATES.IDLE); // ready for a new setup
  assert.equal(driven.getSetup(), null);
});

test('onEntryBarClose is a no-op while IDLE, WAITING_FOR_CHOCH, or a position is open/managed', () => {
  const config = mergeConfig(SCENARIO_CONFIG_OVERRIDES);
  const machine = createReversalStateMachine(config);
  assert.deepEqual(machine.onEntryBarClose([candle(1, 2, 0, 1)], 0, ALL_DIRECTIONS), []);
});

test('cancelEntry resets an ENTRY_TRIGGERED setup back to IDLE (live-trading rejection path)', () => {
  const candles = buildBullishReversalCandles();
  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'immediate' });
  const { fireIndex, machine } = runToEntry(candles, config);
  assert.equal(fireIndex, SCENARIO_INDICES.choch);
  assert.equal(machine.getState(), STATES.ENTRY_TRIGGERED);

  const events = machine.cancelEntry('INSUFFICIENT_BALANCE');
  assert.equal(events[0].state, STATES.IDLE);
  assert.equal(events[0].reason, 'INSUFFICIENT_BALANCE');
  assert.equal(machine.getState(), STATES.IDLE);
  assert.equal(machine.getSetup(), null);
});

test('cancelEntry is a no-op outside ENTRY_TRIGGERED', () => {
  const config = mergeConfig(SCENARIO_CONFIG_OVERRIDES);
  const machine = createReversalStateMachine(config);
  assert.deepEqual(machine.cancelEntry('whatever'), []);
  assert.equal(machine.getState(), STATES.IDLE);
});
