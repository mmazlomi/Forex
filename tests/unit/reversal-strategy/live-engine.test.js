'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const marketDataService = require('../../../src/services/market-data/market-data-service');
const { processLiveCycle, resetLiveStatesForTests, getLiveStateForTests, getLiveStatus } = require('../../../src/services/reversal-strategy/live-engine');
const { STATES } = require('../../../src/services/reversal-strategy/state-machine');
const { SCENARIO_CONFIG_OVERRIDES, SCENARIO_INDICES, buildBullishReversalCandles } = require('../../fixtures/reversal-scenarios');

const FIVE_MIN = 5 * 60 * 1000;
const FOUR_HOUR = 4 * 60 * 60 * 1000;
// Fixed, far-in-the-past epoch so every candle in these fixtures is safely "closed" relative to
// the real wall-clock Date.now() the engine uses internally — avoids mocking Date.now entirely.
const BASE_TS = Date.UTC(2020, 0, 1);

function toDbRow(c, i, stepMs) {
  return { ts_utc: BASE_TS + i * stepMs, open: c.open, high: c.high, low: c.low, close: c.close, volume: 1 };
}

function buildAllowingHtfRows(count = 100) {
  const rows = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price += 1;
    rows.push({ ts_utc: BASE_TS - (count - i) * FOUR_HOUR, open, close: price, high: price + 0.5, low: open - 0.5, volume: 1 });
  }
  return rows;
}

// signal and entry share the SAME timeframe string ('5m') in this test's CONFIG (see CONFIG's own
// comment), so both are served from one array — `signal`/`entry` are always the same data at
// every call site below anyway.
function mockCandles(t, { htf, signal, entry }) {
  t.mock.method(marketDataService, 'getCandles', async ({ timeframe }) => {
    if (timeframe === '4h') return htf;
    if (timeframe === '5m') return entry ?? signal;
    throw new Error(`unexpected timeframe in test mock: ${timeframe}`);
  });
}

const ASSET = { market: 'futures', mode: 'demo', userId: 1, symbol: 'BTC/USDT:USDT', exchange: 'kucoin' };
// Both signal and entry mocks below reuse the SAME 5-minute-spaced scenario array (a valid
// simplification for exercising the live engine's own logic — see reversal-backtest.test.js's
// identical convention), so signalTimeframe must match the data's real spacing (5m), not the
// app's actual default (15m) — a mismatch here would desync the bar-closed cutoff math.
const CONFIG = { ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation', signalTimeframe: '5m', entryTimeframe: '5m' };

test.beforeEach(() => {
  resetLiveStatesForTests();
});

test('processLiveCycle returns null and never fetches candles when a position is already open (DB truth)', async (t) => {
  const spy = t.mock.method(marketDataService, 'getCandles', async () => { throw new Error('should not be called'); });
  const result = await processLiveCycle({ ...ASSET, hasOpenPosition: true, configOverrides: CONFIG });
  assert.equal(result, null);
  assert.equal(spy.mock.callCount(), 0);
  assert.equal(getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange).machine.getState(), STATES.POSITION_OPEN);
});

test('processLiveCycle resyncs POSITION_OPEN -> IDLE when the DB shows no open position (closed externally by position-risk-watcher.js)', async (t) => {
  mockCandles(t, { htf: [], signal: [], entry: [] });
  // First cycle: establishes POSITION_OPEN.
  await processLiveCycle({ ...ASSET, hasOpenPosition: true, configOverrides: CONFIG });
  assert.equal(getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange).machine.getState(), STATES.POSITION_OPEN);

  // Second cycle: DB now shows no open position -> the machine must reset to IDLE.
  await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });
  assert.equal(getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange).machine.getState(), STATES.IDLE);
});

test('processLiveCycle runs the full proven bullish scenario in one cycle and returns a priced entry decision', async (t) => {
  const scenario = buildBullishReversalCandles();
  const signalRows = scenario.map((c, i) => toDbRow(c, i, FIVE_MIN));
  mockCandles(t, { htf: buildAllowingHtfRows(), signal: signalRows, entry: signalRows });

  const result = await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });

  assert.ok(result, 'expected an entry decision to be returned');
  assert.equal(result.direction, 'bullish');
  assert.ok(result.stopLoss < result.takeProfit);
  assert.equal(result.sweep.sweepIndex, SCENARIO_INDICES.sweep);

  const live = getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange);
  assert.equal(live.machine.getState(), STATES.ENTRY_TRIGGERED);
});

test('processLiveCycle only processes NEWLY closed bars on each call, not re-processing what a prior cycle already saw', async (t) => {
  const scenario = buildBullishReversalCandles();
  const signalRows = scenario.map((c, i) => toDbRow(c, i, FIVE_MIN));
  const htfRows = buildAllowingHtfRows();

  // Cycle 1: only the data up through just before CHOCH is "available" (as if fetched mid-sequence).
  const partial = signalRows.slice(0, SCENARIO_INDICES.choch); // stops before the CHOCH-breaking bar
  mockCandles(t, { htf: htfRows, signal: partial, entry: partial });
  const firstResult = await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });
  assert.equal(firstResult, null);
  const afterFirst = getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange);
  assert.equal(afterFirst.machine.getState(), STATES.WAITING_FOR_CHOCH);
  const signalTsAfterFirst = afterFirst.lastProcessedSignalTsUtc;
  assert.ok(signalTsAfterFirst > -Infinity);

  // Cycle 2: the full dataset is now available — must pick up exactly where it left off and reach
  // ENTRY_TRIGGERED, not silently skip or double-process anything.
  mockCandles(t, { htf: htfRows, signal: signalRows, entry: signalRows });
  const secondResult = await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });
  assert.ok(secondResult, 'expected the second cycle to complete the setup and trigger an entry');
  assert.equal(secondResult.direction, 'bullish');
});

test('processLiveCycle cancels an ENTRY_TRIGGERED setup that never resulted in an open position (order was rejected)', async (t) => {
  const scenario = buildBullishReversalCandles();
  const signalRows = scenario.map((c, i) => toDbRow(c, i, FIVE_MIN));
  mockCandles(t, { htf: buildAllowingHtfRows(), signal: signalRows, entry: signalRows });

  const result = await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });
  assert.ok(result);
  assert.equal(getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange).machine.getState(), STATES.ENTRY_TRIGGERED);

  // Next cycle: still no open position in the DB (the order the caller placed must have been
  // rejected) -> the stale ENTRY_TRIGGERED setup must be discarded, not left stuck forever.
  mockCandles(t, { htf: [], signal: [], entry: [] });
  const nextResult = await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });
  assert.equal(nextResult, null);
  assert.equal(getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange).machine.getState(), STATES.IDLE);
});

test('different symbols/modes get fully independent live state', async (t) => {
  mockCandles(t, { htf: [], signal: [], entry: [] });
  await processLiveCycle({ ...ASSET, hasOpenPosition: true, configOverrides: CONFIG });
  const other = await processLiveCycle({ market: 'futures', mode: 'demo', userId: 1, symbol: 'ETH/USDT:USDT', exchange: 'kucoin', hasOpenPosition: false, configOverrides: CONFIG });
  assert.equal(other, null); // empty candle sets -> nothing actionable, but crucially no crash / no cross-talk
  assert.equal(getLiveStateForTests('demo', 1, 'BTC/USDT:USDT', 'kucoin').machine.getState(), STATES.POSITION_OPEN);
  assert.equal(getLiveStateForTests('demo', 1, 'ETH/USDT:USDT', 'kucoin').machine.getState(), STATES.IDLE);
});

// getLiveStatus is the read-only accessor the Signals Setting Results table polls (via
// reversal-controller.js) — unlike getLiveStateForTests it's meant for real (non-test) callers, so
// it's covered on its own rather than assumed identical to the test accessor.
test('getLiveStatus returns null when no cycle has ever run for this asset', () => {
  assert.equal(getLiveStatus(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange, ASSET.market), null);
});

test('getLiveStatus surfaces state + direction + chochLevel once a setup is mid-sequence (WAITING_FOR_CHOCH)', async (t) => {
  const scenario = buildBullishReversalCandles();
  const signalRows = scenario.map((c, i) => toDbRow(c, i, FIVE_MIN));
  const partial = signalRows.slice(0, SCENARIO_INDICES.choch);
  mockCandles(t, { htf: buildAllowingHtfRows(), signal: partial, entry: partial });

  await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });

  const status = getLiveStatus(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange, ASSET.market);
  assert.equal(status.state, STATES.WAITING_FOR_CHOCH);
  assert.equal(status.direction, 'bullish');
  assert.ok(typeof status.chochLevel === 'number');
  assert.ok(status.asOfTsUtc, 'expected a real timestamp once at least one bar has been processed');
  assert.equal(new Date(status.asOfTsUtc).toISOString(), status.asOfTsUtc, 'must be a valid ISO string');
});

test('getLiveStatus.asOfTsUtc is null until the first cycle has actually processed a bar', async (t) => {
  // An empty candle set still creates a live-state entry (processLiveCycle returns early after
  // fetching, but getOrCreateLiveState already ran) — asOfTsUtc must stay null, not epoch-0
  // (new Date(-Infinity) would silently produce "Invalid Date" if this guard were missing).
  mockCandles(t, { htf: [], signal: [], entry: [] });
  await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });
  const status = getLiveStatus(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange, ASSET.market);
  assert.equal(status.asOfTsUtc, null);
});

test('getLiveStatus never advances the state machine — safe to call repeatedly without disturbing the scheduler', async (t) => {
  const scenario = buildBullishReversalCandles();
  const signalRows = scenario.map((c, i) => toDbRow(c, i, FIVE_MIN));
  const partial = signalRows.slice(0, SCENARIO_INDICES.choch);
  mockCandles(t, { htf: buildAllowingHtfRows(), signal: partial, entry: partial });
  await processLiveCycle({ ...ASSET, hasOpenPosition: false, configOverrides: CONFIG });

  const before = getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange).lastProcessedSignalTsUtc;
  getLiveStatus(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange, ASSET.market);
  getLiveStatus(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange, ASSET.market);
  const after = getLiveStateForTests(ASSET.mode, ASSET.userId, ASSET.symbol, ASSET.exchange).lastProcessedSignalTsUtc;
  assert.equal(after, before);
});
