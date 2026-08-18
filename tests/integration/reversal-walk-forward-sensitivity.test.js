'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const { runReversalWalkForward } = require('../../src/services/backtesting/reversal-walk-forward');
const { runReversalSensitivitySweep, buildOverfittingNote } = require('../../src/services/backtesting/reversal-sensitivity');
const { candle, SCENARIO_CONFIG_OVERRIDES } = require('../../tests/fixtures/reversal-scenarios');

const FIVE_MIN = 5 * 60 * 1000;
const FOUR_HOUR = 4 * 60 * 60 * 1000;

function withTimestamps(candles, startMs, stepMs) {
  return candles.map((c, i) => ({ ...c, tsUtc: startMs + i * stepMs }));
}

function toOhlcv(c) {
  return [c.tsUtc, c.open, c.high, c.low, c.close, 1];
}

function buildFlatHtfAndEntryCandles(entryCount) {
  const htf = [];
  let price = 100;
  for (let i = 0; i < 100; i += 1) {
    const open = price;
    price += 1;
    htf.push({ open, close: price, high: price + 0.5, low: open - 0.5, tsUtc: i * FOUR_HOUR });
  }
  const htfCloseMs = 100 * FOUR_HOUR;
  const flat = withTimestamps(Array.from({ length: entryCount }, () => candle(100, 100.5, 99.5, 100)), htfCloseMs, FIVE_MIN);
  return { htf, flat, htfCloseMs };
}

function mockFlatExchange(t) {
  const { htf, flat, htfCloseMs } = buildFlatHtfAndEntryCandles(400); // enough to span several windows
  const candlesByTimeframe = { '4h': htf.map(toOhlcv), '15m': flat.map(toOhlcv), '5m': flat.map(toOhlcv) };
  const client = {
    markets: { 'BTC/USDT': {} },
    loadMarkets: async () => {},
    fetchOHLCV: async (symbol, timeframe, since) => (candlesByTimeframe[timeframe] || []).filter((c) => c[0] >= since),
  };
  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => client);
  return { htfCloseMs, entryCount: flat.length };
}

test.beforeEach(() => {
  resetForTests();
});

test('runReversalWalkForward splits the range into the requested number of windows and aggregates consistently', async (t) => {
  const { htfCloseMs, entryCount } = mockFlatExchange(t);
  const startUtc = new Date(htfCloseMs).toISOString();
  const endUtc = new Date(htfCloseMs + entryCount * FIVE_MIN).toISOString();

  const result = await runReversalWalkForward({
    symbol: 'BTC/USDT', exchange: 'kucoin', startUtc, endUtc, windowCount: 4, initialCapital: 10000,
    configOverrides: { ...SCENARIO_CONFIG_OVERRIDES, signalTimeframe: '15m', entryTimeframe: '5m' },
  });

  assert.equal(result.windows.length, 4);
  assert.equal(result.windows[0].startUtc, startUtc);
  assert.equal(result.windows[3].endUtc, endUtc);
  // Flat/no-signal data everywhere -> zero trades in every window -> perfectly consistent (zero variance).
  assert.equal(result.aggregate.winRatePercent.mean, 0);
  assert.equal(result.aggregate.netPnlPercent.stdev, 0);
  assert.equal(result.aggregate.profitableWindowCount, 0);
});

test('runReversalWalkForward rejects a windowCount below 2', async () => {
  await assert.rejects(
    () => runReversalWalkForward({ symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2026-01-01T00:00:00Z', endUtc: '2026-01-02T00:00:00Z', windowCount: 1 }),
    /windowCount must be an integer >= 2/
  );
});

test('runReversalSensitivitySweep runs one backtest per value and fetches candles only ONCE for a non-timeframe parameter', async (t) => {
  const { htfCloseMs, entryCount } = mockFlatExchange(t);
  const startUtc = new Date(htfCloseMs).toISOString();
  const endUtc = new Date(htfCloseMs + entryCount * FIVE_MIN).toISOString();

  const fetchSpy = t.mock.method(exchangeClientFactory, 'getPublicExchange');

  const result = await runReversalSensitivitySweep({
    symbol: 'BTC/USDT', exchange: 'kucoin', startUtc, endUtc,
    paramPath: 'rsiPeriod', values: [7, 14, 21],
    baseConfigOverrides: { ...SCENARIO_CONFIG_OVERRIDES, signalTimeframe: '15m', entryTimeframe: '5m' },
  });

  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results.map((r) => r.value), [7, 14, 21]);
  for (const r of result.results) assert.ok(r.metrics, `value ${r.value} should have produced metrics, got: ${JSON.stringify(r)}`);

  // Fetch-once: getPublicExchange is called once per fetchHistoricalRange call, and
  // fetchReversalCandles makes 3 (one per timeframe) — for a NON-timeframe swept parameter, that
  // should happen exactly once total across all 3 values, not once per value.
  assert.equal(fetchSpy.mock.callCount(), 3);
});

test('runReversalSensitivitySweep fetches candles separately per value when sweeping a timeframe parameter itself', async (t) => {
  const { htfCloseMs, entryCount } = mockFlatExchange(t);
  const startUtc = new Date(htfCloseMs).toISOString();
  const endUtc = new Date(htfCloseMs + entryCount * FIVE_MIN).toISOString();
  const fetchSpy = t.mock.method(exchangeClientFactory, 'getPublicExchange');

  await runReversalSensitivitySweep({
    symbol: 'BTC/USDT', exchange: 'kucoin', startUtc, endUtc,
    paramPath: 'entryTimeframe', values: ['5m', '5m'], // same value twice is enough to prove 2 separate fetches happen
    baseConfigOverrides: { ...SCENARIO_CONFIG_OVERRIDES, signalTimeframe: '15m' },
  });

  assert.equal(fetchSpy.mock.callCount(), 6); // 3 timeframe fetches x 2 values
});

test('runReversalSensitivitySweep records a per-value error instead of aborting the whole sweep on an invalid config value', async (t) => {
  const { htfCloseMs, entryCount } = mockFlatExchange(t);
  const startUtc = new Date(htfCloseMs).toISOString();
  const endUtc = new Date(htfCloseMs + entryCount * FIVE_MIN).toISOString();

  const result = await runReversalSensitivitySweep({
    symbol: 'BTC/USDT', exchange: 'kucoin', startUtc, endUtc,
    paramPath: 'entryMode', values: ['retest', 'not_a_real_mode', 'immediate'],
    baseConfigOverrides: { ...SCENARIO_CONFIG_OVERRIDES, signalTimeframe: '15m', entryTimeframe: '5m' },
  });

  assert.equal(result.results.length, 3);
  assert.ok(result.results[0].metrics);
  assert.ok(result.results[1].error);
  assert.ok(result.results[2].metrics);
});

test('buildOverfittingNote is null when there are too few successful results or every result is flat', () => {
  assert.equal(buildOverfittingNote([{ value: 1, metrics: { totalPnlPercent: 5 } }]), null); // only 1 result
  assert.equal(
    buildOverfittingNote([
      { value: 1, metrics: { totalPnlPercent: 0 } },
      { value: 2, metrics: { totalPnlPercent: 0 } },
      { value: 3, metrics: { totalPnlPercent: 0 } },
    ]),
    null
  );
});

test('buildOverfittingNote flags a value that outperforms every neighbor by more than 4x', () => {
  const note = buildOverfittingNote([
    { value: 1, metrics: { totalPnlPercent: 1 } },
    { value: 2, metrics: { totalPnlPercent: 40 } }, // the "spike"
    { value: 3, metrics: { totalPnlPercent: -2 } },
    { value: 4, metrics: { totalPnlPercent: 3 } },
  ]);
  assert.ok(note);
  assert.match(note, /"?2"?/); // mentions the spiking value
});

test('buildOverfittingNote does NOT flag consistently strong performance across neighboring values', () => {
  const note = buildOverfittingNote([
    { value: 1, metrics: { totalPnlPercent: 18 } },
    { value: 2, metrics: { totalPnlPercent: 22 } },
    { value: 3, metrics: { totalPnlPercent: 20 } },
    { value: 4, metrics: { totalPnlPercent: 19 } },
  ]);
  assert.equal(note, null);
});
