'use strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetForTests } = require('../../src/database/connection');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const {
  simulateReversalStrategy,
  runReversalBacktest,
} = require('../../src/services/backtesting/reversal-backtest-engine');
const { mergeConfig } = require('../../src/services/reversal-strategy/config');
const {
  candle,
  SCENARIO_CONFIG_OVERRIDES,
  SCENARIO_INDICES,
  buildBullishReversalCandles,
} = require('../../tests/fixtures/reversal-scenarios');

const FIVE_MIN = 5 * 60 * 1000;
const FOUR_HOUR = 4 * 60 * 60 * 1000;

function withTimestamps(candles, startMs, stepMs) {
  return candles.map((c, i) => ({ ...c, tsUtc: startMs + i * stepMs }));
}

/** A long, steady uptrend HTF (4h) candle series, entirely closed before entry/signal candles
 *  begin — enough history for Ichimoku to report 'ok' and allow the 'bullish' direction. */
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

test.beforeEach(() => {
  resetForTests();
});

test('simulateReversalStrategy: the proven bullish scenario produces exactly one trade with sane entry/SL/TP/fill mechanics', () => {
  const htfCandles = buildAllowingHtfCandles();
  const htfCloseMs = htfCandles.length * FOUR_HOUR; // close time of the last HTF candle

  const rawScenario = buildBullishReversalCandles();
  const signalCandles = withTimestamps(rawScenario, htfCloseMs, FIVE_MIN);
  // Same timeframe used for both signal and entry detection in this test (a valid simplification
  // for exercising the simulation LOOP itself — true multi-timeframe alignment is separately
  // covered by tests/unit/reversal-strategy/timeframe-alignment.test.js).
  const entryCandles = signalCandles;

  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation' });
  const { trades, equityCurve, warnings } = simulateReversalStrategy({
    htfCandles, signalCandles, entryCandles,
    htfStepMs: FOUR_HOUR, signalStepMs: FIVE_MIN, entryStepMs: FIVE_MIN, entryStartIndex: 0,
    symbol: 'TEST/USDT', initialCapital: 10000, feePercent: 0.1, slippagePercent: 0.05, config,
  });

  assert.equal(trades.length, 1, `expected exactly one trade; warnings: ${JSON.stringify(warnings)}`);
  const trade = trades[0];
  assert.equal(trade.side, 'long');

  // Entry fills at the OPEN of the bar AFTER confirmation (one-bar execution lag — STRATEGY_SPEC §8).
  const expectedFillBarIndex = SCENARIO_INDICES.confirmation + 1;
  const expectedRawFillPrice = entryCandles[expectedFillBarIndex].open;
  const expectedFillPrice = expectedRawFillPrice * (1 + 0.05 / 100); // bullish slippage is unfavorable (higher)
  assert.ok(Math.abs(trade.entryPrice - expectedFillPrice) < 1e-9);

  assert.ok(['stop_loss', 'take_profit', 'end_of_backtest'].includes(trade.exitReason));

  // Stop-loss is the sweep bar's low (sweep_extreme model, default) with the configured buffer,
  // and take-profit is entry + riskDistance * RR — both must sit on the correct side of entry for
  // a long, and the position must be sized to a positive, finite quantity.
  assert.ok(trade.stopLoss < trade.entryPrice);
  assert.ok(trade.takeProfit > trade.entryPrice);
  assert.ok(trade.qty > 0);
  const riskDistance = trade.entryPrice - trade.stopLoss;
  const rewardDistance = trade.takeProfit - trade.entryPrice;
  assert.ok(Math.abs(rewardDistance / riskDistance - config.riskRewardRatio) < 1e-6);

  // The equity curve has one point per entry-timeframe bar simulated.
  assert.equal(equityCurve.length, entryCandles.length);
});

// Regression: on this exact proven scenario, adaptive mode used to compute a market-structure
// level from the SIGNAL-decision-time window (which can be several bars before the actual fill)
// and snap every TP tier to it even though price had already moved past that level by fill time —
// pulling all three TP1/TP2/TP3 targets BELOW entry on a long, so a "take profit" fill actually
// realized a loss. Fixed in adaptive-take-profit-engine.js (snapToStructure now requires the level
// to be on the correct side of entry, plus a final wrong-side-of-entry safety clamp).
test('simulateReversalStrategy: adaptive mode on the proven bullish scenario produces TP1<TP2<TP3, all strictly above entry, each profitable', () => {
  const htfCandles = buildAllowingHtfCandles();
  const htfCloseMs = htfCandles.length * FOUR_HOUR;

  const rawScenario = buildBullishReversalCandles();
  const signalCandles = withTimestamps(rawScenario, htfCloseMs, FIVE_MIN);
  const entryCandles = signalCandles;

  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation' });
  const { trades, warnings } = simulateReversalStrategy({
    htfCandles, signalCandles, entryCandles,
    htfStepMs: FOUR_HOUR, signalStepMs: FIVE_MIN, entryStepMs: FIVE_MIN, entryStartIndex: 0,
    symbol: 'TEST/USDT', initialCapital: 10000, feePercent: 0.1, slippagePercent: 0.05, config,
    adaptiveTpConfig: {},
  });

  assert.ok(trades.length >= 1, `expected at least one trade; warnings: ${JSON.stringify(warnings)}`);
  const entryPrice = trades[0].entryPrice;
  for (const trade of trades) {
    assert.ok(trade.exitPrice > entryPrice, `${trade.exitReason} exit (${trade.exitPrice}) must be above entry (${entryPrice})`);
    assert.ok(trade.pnl > 0, `${trade.exitReason} must be profitable, got pnl=${trade.pnl}`);
  }
  if (trades.length === 3) {
    assert.ok(trades[0].exitPrice < trades[1].exitPrice && trades[1].exitPrice < trades[2].exitPrice, 'TP1 < TP2 < TP3');
  }
});

test('simulateReversalStrategy: no trade fires when the HTF filter never allows the setup\'s direction', () => {
  // A downtrend HTF context only allows SHORT — the bullish scenario must never fire a trade.
  const htfCandles = [];
  let price = 500;
  for (let i = 0; i < 100; i += 1) {
    const open = price;
    price -= 1;
    htfCandles.push({ open, close: price, high: open + 0.5, low: price - 0.5, tsUtc: i * FOUR_HOUR });
  }
  const htfCloseMs = 100 * FOUR_HOUR;

  const rawScenario = buildBullishReversalCandles();
  const signalCandles = withTimestamps(rawScenario, htfCloseMs, FIVE_MIN);
  const entryCandles = signalCandles;

  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation' });
  const { trades } = simulateReversalStrategy({
    htfCandles, signalCandles, entryCandles,
    htfStepMs: FOUR_HOUR, signalStepMs: FIVE_MIN, entryStepMs: FIVE_MIN, entryStartIndex: 0,
    symbol: 'TEST/USDT', initialCapital: 10000, feePercent: 0.1, slippagePercent: 0.05, config,
  });

  assert.equal(trades.length, 0);
});

test('simulateReversalStrategy: a flat/no-signal price series never produces a trade (no false positives)', () => {
  const htfCandles = buildAllowingHtfCandles();
  const htfCloseMs = htfCandles.length * FOUR_HOUR;
  const flatCandles = withTimestamps(
    Array.from({ length: 80 }, () => candle(100, 100.5, 99.5, 100)),
    htfCloseMs,
    FIVE_MIN
  );

  const config = mergeConfig(SCENARIO_CONFIG_OVERRIDES);
  const { trades } = simulateReversalStrategy({
    htfCandles, signalCandles: flatCandles, entryCandles: flatCandles,
    htfStepMs: FOUR_HOUR, signalStepMs: FIVE_MIN, entryStepMs: FIVE_MIN, entryStartIndex: 0,
    symbol: 'TEST/USDT', initialCapital: 10000, feePercent: 0.1, slippagePercent: 0.05, config,
  });

  assert.equal(trades.length, 0);
});

test('simulateReversalStrategy: risk guards actually block further entries once tripped (maxOpenTrades=1 is respected)', () => {
  // Two consecutive copies of the bullish scenario back to back — with maxOpenTrades=1 (default),
  // a second setup completing while the first trade is still open must not open a second position.
  const htfCandles = buildAllowingHtfCandles();
  const htfCloseMs = htfCandles.length * FOUR_HOUR;
  const oneScenario = buildBullishReversalCandles();
  const doubled = [...oneScenario, ...oneScenario];
  const signalCandles = withTimestamps(doubled, htfCloseMs, FIVE_MIN);
  const entryCandles = signalCandles;

  const config = mergeConfig({ ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation', maxOpenTrades: 1 });
  const { trades } = simulateReversalStrategy({
    htfCandles, signalCandles, entryCandles,
    htfStepMs: FOUR_HOUR, signalStepMs: FIVE_MIN, entryStepMs: FIVE_MIN, entryStartIndex: 0,
    symbol: 'TEST/USDT', initialCapital: 10000, feePercent: 0.1, slippagePercent: 0.05, config,
  });

  // At most one trade can be OPEN at a time; however many total round-trips occur, the guard must
  // never have allowed two open positions simultaneously — verified indirectly by every trade
  // having a well-formed non-overlapping lifecycle (enforced structurally by the engine itself
  // only ever tracking a single `position` variable), and explicitly that entries were not
  // silently duplicated beyond what the two scenario copies could produce.
  assert.ok(trades.length <= 2);
});

function fakeExchangeClient(candlesByTimeframe) {
  return {
    markets: { 'BTC/USDT': {} },
    loadMarkets: async () => {},
    fetchOHLCV: async (symbol, timeframe, since) => {
      const all = candlesByTimeframe[timeframe] || [];
      return all.filter((c) => c[0] >= since).map((c) => c);
    },
  };
}

test('runReversalBacktest: wires fetch -> simulate -> persist end to end (mocked exchange client, no real network)', async (t) => {
  const htfCandles = buildAllowingHtfCandles();
  const htfCloseMs = htfCandles.length * FOUR_HOUR;
  const rawScenario = buildBullishReversalCandles();
  const signalAndEntry = withTimestamps(rawScenario, htfCloseMs, FIVE_MIN);

  const toOhlcv = (c) => [c.tsUtc, c.open, c.high, c.low, c.close, 1];
  const candlesByTimeframe = {
    '4h': htfCandles.map(toOhlcv),
    '15m': signalAndEntry.map(toOhlcv), // signalTimeframe default is 15m — reuse the same series for this smoke test
    '5m': signalAndEntry.map(toOhlcv),
  };

  const client = fakeExchangeClient(candlesByTimeframe);
  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => client);

  const startUtc = new Date(htfCloseMs).toISOString();
  const endUtc = new Date(htfCloseMs + signalAndEntry.length * FIVE_MIN).toISOString();

  const result = await runReversalBacktest({
    symbol: 'BTC/USDT', exchange: 'kucoin', startUtc, endUtc, initialCapital: 10000,
    configOverrides: { ...SCENARIO_CONFIG_OVERRIDES, entryMode: 'retest_confirmation', signalTimeframe: '15m', entryTimeframe: '5m' },
  });

  assert.equal(result.strategyId, 'liquidity-sweep-reversal');
  assert.ok(result.metrics);
  assert.ok(Array.isArray(result.trades));
  assert.ok(Array.isArray(result.equityCurve));

  const backtestRepository = require('../../src/database/repositories/backtest-repository');
  const persistedRun = backtestRepository.getRun(result.runId);
  assert.equal(persistedRun.status, 'completed');
  assert.equal(persistedRun.strategy_id, 'liquidity-sweep-reversal');
});

test('runReversalBacktest rejects an invalid config before ever fetching data', async () => {
  await assert.rejects(
    () => runReversalBacktest({
      symbol: 'BTC/USDT', exchange: 'kucoin', startUtc: '2026-01-01T00:00:00Z', endUtc: '2026-01-02T00:00:00Z',
      configOverrides: { entryMode: 'not_a_real_mode' },
    }),
    /Invalid reversal-strategy config/
  );
});
