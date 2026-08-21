'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const { runAdaptiveTpSweep, buildAdaptiveTpConfigForCombo, splitInSampleAndHoldout, MAX_COMBINATIONS } = require('../../src/services/backtesting/adaptive-tp-sweep');
const { validateConfig } = require('../../src/services/risk/adaptive-take-profit-config');
const { SCENARIO_CONFIG_OVERRIDES, buildBullishReversalCandles } = require('../../tests/fixtures/reversal-scenarios');

const FIVE_MIN = 5 * 60 * 1000;
const FOUR_HOUR = 4 * 60 * 60 * 1000;

test.beforeEach(() => {
  resetForTests();
});

// ---------- buildAdaptiveTpConfigForCombo ----------

test('buildAdaptiveTpConfigForCombo: "atr" mode scales TP1/TP2/TP3 in the fixed 1:2:3 ratio and is a valid config', () => {
  const config = buildAdaptiveTpConfigForCombo('atr', 1.5, 2.0);
  assert.equal(config.tp1AtrMultiplier, 1.5);
  assert.equal(config.tp2AtrMultiplier, 3.0);
  assert.equal(config.tp3AtrMultiplier, 4.5);
  assert.equal(config.trailingAtrMultiplier, 2.0);
  assert.deepEqual(validateConfig({ ...require('../../src/services/risk/adaptive-take-profit-config').DEFAULT_CONFIG, ...config }), []);
});

test('buildAdaptiveTpConfigForCombo: "r_multiple" mode scales TP1/TP2/TP3 R-multiples the same way', () => {
  const config = buildAdaptiveTpConfigForCombo('r_multiple', 2, 1.5);
  assert.equal(config.tp1RMultiple, 2);
  assert.equal(config.tp2RMultiple, 4);
  assert.equal(config.tp3RMultiple, 6);
});

// ---------- splitInSampleAndHoldout ----------

test('splitInSampleAndHoldout: the holdout is the LATER slice, sized exactly by holdoutPercent', () => {
  const { inSample, holdout } = splitInSampleAndHoldout(0, 1000, 30);
  assert.equal(inSample.startMs, 0);
  assert.equal(inSample.endMs, 700);
  assert.equal(holdout.startMs, 700);
  assert.equal(holdout.endMs, 1000);
});

test('splitInSampleAndHoldout: 0% holdout puts the entire range in-sample', () => {
  const { inSample, holdout } = splitInSampleAndHoldout(0, 1000, 0);
  assert.equal(inSample.endMs, 1000);
  assert.equal(holdout.startMs, holdout.endMs);
});

// ---------- validation ----------

test('runAdaptiveTpSweep: rejects an unknown engine', async () => {
  await assert.rejects(
    runAdaptiveTpSweep({ engine: 'bogus', symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2020-01-01', endUtc: '2020-02-01' }),
    /engine must be/,
  );
});

test('runAdaptiveTpSweep: rejects an unknown targetMode', async () => {
  await assert.rejects(
    runAdaptiveTpSweep({ engine: 'spot', targetMode: 'bogus', symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2020-01-01', endUtc: '2020-02-01' }),
    /targetMode must be/,
  );
});

test('runAdaptiveTpSweep: rejects holdoutPercent out of [0, 100)', async () => {
  await assert.rejects(
    runAdaptiveTpSweep({ engine: 'spot', holdoutPercent: 100, symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2020-01-01', endUtc: '2020-02-01' }),
    /holdoutPercent/,
  );
});

test('runAdaptiveTpSweep: rejects an invalid date range before ever fetching data', async () => {
  await assert.rejects(
    runAdaptiveTpSweep({ engine: 'spot', symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2020-02-01', endUtc: '2020-01-01' }),
    /endUtc must be after startUtc/,
  );
});

test('runAdaptiveTpSweep: rejects a grid exceeding MAX_COMBINATIONS', async () => {
  await assert.rejects(
    runAdaptiveTpSweep({
      engine: 'spot', symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2020-01-01', endUtc: '2020-02-01',
      atrMultiplierGrid: Array.from({ length: 20 }, (_, i) => i + 1), trailingMultiplierGrid: Array.from({ length: 10 }, (_, i) => i + 1),
    }),
    new RegExp(`exceeding the limit of ${MAX_COMBINATIONS}`),
  );
});

// ---------- end-to-end (reversal engine, mocked exchange, tiny grid) ----------

function withTimestamps(candles, startMs, stepMs) {
  return candles.map((c, i) => ({ ...c, tsUtc: startMs + i * stepMs }));
}

function buildAllowingHtfCandles(count = 100) {
  const c = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price += 1;
    c.push({ open, close: price, high: price + 0.5, low: open - 0.5, tsUtc: i * FOUR_HOUR });
  }
  return c;
}

function fakeExchangeClient(candlesByTimeframe) {
  return {
    markets: { 'BTC/USDT': {} },
    loadMarkets: async () => {},
    fetchOHLCV: async (symbol, timeframe, since) => (candlesByTimeframe[timeframe] || []).filter((c) => c[0] >= since),
  };
}

test('runAdaptiveTpSweep (reversal engine, end-to-end): runs the full grid, ranks it, and validates the best config against a never-optimized-on holdout slice', async (t) => {
  const htfCandles = buildAllowingHtfCandles();
  const htfCloseMs = htfCandles.length * FOUR_HOUR;
  const rawScenario = buildBullishReversalCandles();
  const signalAndEntry = withTimestamps(rawScenario, htfCloseMs, FIVE_MIN);

  const toOhlcv = (c) => [c.tsUtc, c.open, c.high, c.low, c.close, 1];
  const candlesByTimeframe = {
    '4h': htfCandles.map(toOhlcv),
    '15m': signalAndEntry.map(toOhlcv),
    '5m': signalAndEntry.map(toOhlcv),
  };
  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => fakeExchangeClient(candlesByTimeframe));

  const startUtc = new Date(htfCloseMs).toISOString();
  const endUtc = new Date(htfCloseMs + signalAndEntry.length * FIVE_MIN).toISOString();

  const result = await runAdaptiveTpSweep({
    engine: 'reversal', symbol: 'BTC/USDT', exchange: 'kucoin', startUtc, endUtc, holdoutPercent: 20,
    reversalConfigOverrides: { ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation', signalTimeframe: '15m', entryTimeframe: '5m' },
    atrMultiplierGrid: [1.0, 2.0], trailingMultiplierGrid: [1.5],
  });

  assert.equal(result.combinationsRun, 2);
  assert.equal(result.inSampleLeaderboard.length, 2);
  assert.ok(result.bestConfig);
  assert.ok(result.outOfSample);
  assert.ok(result.outOfSample.metrics || result.outOfSample.error);
  // This scenario has too few trades to clear the default minTradeCount, so every combo is
  // disqualified (compositeScore -Infinity) — exercises the "best = ranked[0] fallback" path.
  assert.equal(result.inSampleLeaderboard[0].compositeScore, -Infinity);
});
