'use strict';

// checkSpotTrigger/checkFuturesTrigger are the core stop-loss/take-profit trigger-direction logic
// position-risk-watcher.js uses for every open position — pure and side-effect-free, tested
// directly here rather than only indirectly through the slower integration tests, matching the
// convention pending-orders-watcher.test.js already established for checkFillCondition.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkSpotTrigger, checkFuturesTrigger, computeSpotTrailingUpdate, computeFuturesTrailingUpdate,
  checkAdaptiveTpTriggers, checkReversalExit, applySpikeAndExhaustionChecks,
} = require('../../src/services/scheduler/position-risk-watcher');

test('spot (long-only): stop-loss triggers at-or-below the stored level', () => {
  const position = { stop_loss: 90, take_profit: 130 };
  assert.equal(checkSpotTrigger(position, 91), null);
  assert.equal(checkSpotTrigger(position, 90), 'stop_loss');
  assert.equal(checkSpotTrigger(position, 80), 'stop_loss');
});

test('spot (long-only): take-profit triggers at-or-above the stored level', () => {
  const position = { stop_loss: 90, take_profit: 130 };
  assert.equal(checkSpotTrigger(position, 129), null);
  assert.equal(checkSpotTrigger(position, 130), 'take_profit');
  assert.equal(checkSpotTrigger(position, 200), 'take_profit');
});

test('spot: a position with only one of the two levels set only checks that one', () => {
  assert.equal(checkSpotTrigger({ stop_loss: 90, take_profit: null }, 80), 'stop_loss');
  assert.equal(checkSpotTrigger({ stop_loss: null, take_profit: 130 }, 200), 'take_profit');
  assert.equal(checkSpotTrigger({ stop_loss: null, take_profit: null }, 1), null);
});

test('futures long: same direction as spot — stop-loss below entry, take-profit above', () => {
  const position = { side: 'long', stop_loss: 50000, take_profit: 80000 };
  assert.equal(checkFuturesTrigger(position, 50001), null);
  assert.equal(checkFuturesTrigger(position, 50000), 'stop_loss');
  assert.equal(checkFuturesTrigger(position, 80000), 'take_profit');
});

test('futures short: direction is inverted — stop-loss ABOVE entry, take-profit BELOW (the case most likely to be gotten backwards)', () => {
  const position = { side: 'short', stop_loss: 65000, take_profit: 50000 };
  assert.equal(checkFuturesTrigger(position, 64999), null, 'not triggered yet, still between take-profit and stop-loss');
  assert.equal(checkFuturesTrigger(position, 65000), 'stop_loss', 'price rising through a short\'s stop-loss must trigger it');
  assert.equal(checkFuturesTrigger(position, 50000), 'take_profit', 'price falling through a short\'s take-profit must trigger it');
});

test('futures: stop-loss is checked before take-profit when (implausibly) both conditions hold', () => {
  // Not a realistic price (stop below take for a long implies stop > take is impossible given a
  // valid entry), but pins the tie-break behavior: stop-loss wins if both ever somehow match.
  const position = { side: 'long', stop_loss: 100, take_profit: 90 };
  assert.equal(checkFuturesTrigger(position, 100), 'stop_loss');
});

test('computeSpotTrailingUpdate: no update when trailing_percent is not set', () => {
  const position = { trailing_percent: null, entry_price: 100, stop_loss: 90 };
  assert.equal(computeSpotTrailingUpdate(position, 150), null);
});

test('computeSpotTrailingUpdate: seeds the high-water-mark from entry_price on the first favorable tick', () => {
  const position = { trailing_percent: 2, entry_price: 100, stop_loss: 90, trailing_high_water_mark: null };
  const update = computeSpotTrailingUpdate(position, 110);
  assert.deepEqual(update, { stopLoss: 110 * 0.98, highWaterMark: 110 });
});

test('computeSpotTrailingUpdate: no update when price has not made a new high since the last check', () => {
  const position = { trailing_percent: 2, entry_price: 100, stop_loss: 107.8, trailing_high_water_mark: 110 };
  assert.equal(computeSpotTrailingUpdate(position, 105), null, 'price pulled back but stayed below the recorded high — nothing to ratchet');
  assert.equal(computeSpotTrailingUpdate(position, 110), null, 'exactly matching the prior high is not a NEW high');
});

test('computeSpotTrailingUpdate: ratchets the stop up (never down) as price makes new highs', () => {
  const position = { trailing_percent: 2, entry_price: 100, stop_loss: 107.8, trailing_high_water_mark: 110 };
  const update = computeSpotTrailingUpdate(position, 120);
  assert.deepEqual(update, { stopLoss: 120 * 0.98, highWaterMark: 120 });
  assert.ok(update.stopLoss > position.stop_loss, 'the new stop must be strictly higher than the old one');
});

test('computeFuturesTrailingUpdate long: behaves exactly like spot — high-water-mark and stop both rise with price', () => {
  const position = { side: 'long', trailing_percent: 2, entry_price: 60000, stop_loss: 58800, trailing_high_water_mark: 60000 };
  assert.equal(computeFuturesTrailingUpdate(position, 60000), null, 'no new high, no update');
  const update = computeFuturesTrailingUpdate(position, 65000);
  assert.deepEqual(update, { stopLoss: 65000 * 0.98, highWaterMark: 65000 });
});

test('computeFuturesTrailingUpdate short: high-water-mark and stop both fall as price falls (mirror image of long)', () => {
  const position = { side: 'short', trailing_percent: 2, entry_price: 60000, stop_loss: 61200, trailing_high_water_mark: 60000 };
  assert.equal(computeFuturesTrailingUpdate(position, 61000), null, 'price rose — unfavorable for a short, no update');
  const update = computeFuturesTrailingUpdate(position, 55000);
  assert.deepEqual(update, { stopLoss: 55000 * 1.02, highWaterMark: 55000 });
  assert.ok(update.stopLoss < position.stop_loss, 'a short\'s new stop must be strictly lower (tighter) than the old one');
});

// checkSpotTrigger/checkFuturesTrigger: an adaptive-TP position's take_profit column (TP3, a
// display/fallback ceiling — see checkSpotTrigger's doc comment) must never itself trigger a
// close; checkAdaptiveTpTriggers is what actually closes an adaptive position, tier by tier.

test('checkSpotTrigger: skips the take_profit check for an adaptive-TP position (stop_loss still applies)', () => {
  const position = { stop_loss: 90, take_profit: 130, adaptive_tp_enabled: 1 };
  assert.equal(checkSpotTrigger(position, 135), null, 'take_profit must not fire for an adaptive position');
  assert.equal(checkSpotTrigger(position, 85), 'stop_loss', 'stop_loss still fires normally');
});

test('checkFuturesTrigger: skips the take_profit check for an adaptive-TP position (stop_loss still applies)', () => {
  const position = { side: 'long', stop_loss: 58000, take_profit: 65000, adaptive_tp_enabled: 1 };
  assert.equal(checkFuturesTrigger(position, 66000), null);
  assert.equal(checkFuturesTrigger(position, 57000), 'stop_loss');
});

// checkAdaptiveTpTriggers

test('checkAdaptiveTpTriggers: fires TP1 only when price has crossed just TP1 (long)', () => {
  const position = { side: 'buy', tp1_price: 110, tp1_qty_percent: 25, tp2_price: 120, tp2_qty_percent: 35, tp3_price: 130, tp3_qty_percent: 40 };
  const fired = checkAdaptiveTpTriggers(position, 112);
  assert.deepEqual(fired, [{ level: 1, price: 110, qtyPercent: 25 }]);
});

test('checkAdaptiveTpTriggers: a price gap through the poll interval fires every crossed tier, in order', () => {
  const position = { side: 'buy', tp1_price: 110, tp1_qty_percent: 25, tp2_price: 120, tp2_qty_percent: 35, tp3_price: 130, tp3_qty_percent: 40 };
  const fired = checkAdaptiveTpTriggers(position, 135); // gapped straight past all three
  assert.deepEqual(fired, [
    { level: 1, price: 110, qtyPercent: 25 },
    { level: 2, price: 120, qtyPercent: 35 },
    { level: 3, price: 130, qtyPercent: 40 },
  ]);
});

test('checkAdaptiveTpTriggers: an already-filled tier is never returned again', () => {
  const position = {
    side: 'buy', tp1_price: 110, tp1_qty_percent: 25, tp1_filled_at_utc: '2026-01-01T00:00:00Z',
    tp2_price: 120, tp2_qty_percent: 35,
  };
  const fired = checkAdaptiveTpTriggers(position, 125);
  assert.deepEqual(fired, [{ level: 2, price: 120, qtyPercent: 35 }]);
});

test('checkAdaptiveTpTriggers: short position direction is inverted (tiers fire as price falls)', () => {
  const position = { side: 'short', tp1_price: 90, tp1_qty_percent: 25, tp2_price: 80, tp2_qty_percent: 35 };
  assert.deepEqual(checkAdaptiveTpTriggers(position, 95), []);
  assert.deepEqual(checkAdaptiveTpTriggers(position, 85), [{ level: 1, price: 90, qtyPercent: 25 }]);
});

test('checkAdaptiveTpTriggers: returns nothing for a position with no side (defensive, never throws)', () => {
  assert.deepEqual(checkAdaptiveTpTriggers({ tp1_price: 110 }, 120), []);
});

// checkReversalExit

function neutralIndicators() {
  const noData = { status: 'no_data' };
  return {
    rsi: noData, macd: noData, ema: noData, bollingerBands: noData, stochastic: noData,
    adx: noData, ichimoku: noData, supportResistance: noData, volumeAnalysis: noData, sma: noData,
  };
}

test('checkReversalExit: returns null when the position never opted into reversal-exit (no stored conditions)', () => {
  const position = { side: 'buy', exit_reversal_conditions_json: null };
  assert.equal(checkReversalExit(position, 100, null), null);
});

test('checkReversalExit: structure_break fires on price alone, no freshIndicators needed (long)', () => {
  const position = {
    side: 'buy',
    exit_reversal_conditions_json: JSON.stringify([{ type: 'structure_break', description: 'Loss of support', level: 95 }]),
  };
  assert.equal(checkReversalExit(position, 96, null), null, 'still above the support level');
  const fired = checkReversalExit(position, 94, null);
  assert.equal(fired.type, 'structure_break');
});

test('checkReversalExit: structure_break direction is inverted for a short', () => {
  const position = {
    side: 'short',
    exit_reversal_conditions_json: JSON.stringify([{ type: 'structure_break', description: 'Break above resistance', level: 105 }]),
  };
  assert.equal(checkReversalExit(position, 104, null), null);
  assert.ok(checkReversalExit(position, 106, null));
});

test('checkReversalExit: reversal_signal fires when a fresh technicalScore strongly opposes a long, and is skipped without freshIndicators', () => {
  const position = { side: 'buy', exit_reversal_conditions_json: JSON.stringify([{ type: 'reversal_signal', description: 'Bearish reversal' }]) };
  assert.equal(checkReversalExit(position, 100, null), null, 'no fresh indicators available this cycle — condition skipped, not blocked-open forever');

  const bearishIndicators = { ...neutralIndicators(), rsi: { status: 'ok', value: 85 } }; // overbought -> bearish
  const fired = checkReversalExit(position, 100, bearishIndicators);
  assert.equal(fired.type, 'reversal_signal');
  assert.ok(fired.technicalScore < 0);
});

test('checkReversalExit: reversal_signal does not fire on a weak/neutral score', () => {
  const position = { side: 'buy', exit_reversal_conditions_json: JSON.stringify([{ type: 'reversal_signal', description: 'Bearish reversal' }]) };
  const neutral = { ...neutralIndicators(), rsi: { status: 'ok', value: 55 } }; // mild, well under the 0.5 threshold
  assert.equal(checkReversalExit(position, 100, neutral), null);
});

test('checkReversalExit: reversal_signal direction is inverted for a short (fires on a strongly bullish score)', () => {
  const position = { side: 'short', exit_reversal_conditions_json: JSON.stringify([{ type: 'reversal_signal', description: 'Bullish reversal' }]) };
  const bullishIndicators = { ...neutralIndicators(), rsi: { status: 'ok', value: 15 } }; // oversold -> bullish
  const fired = checkReversalExit(position, 100, bullishIndicators);
  assert.equal(fired.type, 'reversal_signal');
  assert.ok(fired.technicalScore > 0);
});

test('checkReversalExit: malformed JSON is treated as no conditions, never throws', () => {
  const position = { side: 'buy', exit_reversal_conditions_json: 'not-json' };
  assert.equal(checkReversalExit(position, 100, null), null);
});

test('checkReversalExit (regression): ignores structure_break if the level was already breached at entry', () => {
  // Short position entered at 2485.91, but condition level was 2483.6 (< entry)
  const position = {
    side: 'short',
    entry_price: 2485.91,
    exit_reversal_conditions_json: JSON.stringify([{ type: 'structure_break', description: 'Break above 2483.6', level: 2483.6 }]),
  };
  // Price at 2486 (which is > 2483.6, but the level was already below entry so it is invalid)
  assert.equal(checkReversalExit(position, 2486, null), null);

  // For comparison, when condition level was genuinely above entry (e.g. 2495), breaking above 2495 DOES trigger
  const validPosition = {
    side: 'short',
    entry_price: 2485.91,
    exit_reversal_conditions_json: JSON.stringify([{ type: 'structure_break', description: 'Break above 2495', level: 2495 }]),
  };
  assert.equal(checkReversalExit(validPosition, 2490, null), null);
  const fired = checkReversalExit(validPosition, 2496, null);
  assert.ok(fired);
  assert.equal(fired.level, 2495);
});

test('applySpikeAndExhaustionChecks: ratchets stop_loss on favorable spike for long position', () => {
  const position = {
    id: 9999,
    user_id: 1,
    symbol: 'BTCUSDT',
    side: 'long',
    entry_price: 100,
    qty: 1,
    stop_loss: 95,
  };
  const freshIndicators = {
    atr: { status: 'ok', value: 4 },
    volumeAnalysis: { status: 'ok', value: { relativeVolume: 2.0 } },
    latestCandle: { open: 100, high: 115, low: 99, close: 114 }, // range 16 (4x ATR), body 14
  };
  // currentPrice 114 > 100 -> in profit
  applySpikeAndExhaustionChecks('demo', 'spot', position, 114, freshIndicators);
  // suggestedStop = 114 - 7 = 107 > 95
  assert.equal(position.stop_loss, 107);
  assert.equal(position.trailing_high_water_mark, 114);
});

test('applySpikeAndExhaustionChecks: ratchets stop_loss on momentum exhaustion (extreme RSI) for short position', () => {
  const position = {
    id: 9998,
    user_id: 1,
    symbol: 'ETHUSDT',
    side: 'short',
    entry_price: 100,
    qty: 1,
    stop_loss: 105,
  };
  const freshIndicators = {
    atr: { status: 'ok', value: 4 },
    rsi: { status: 'ok', value: 15 }, // extreme oversold <= 22
  };
  // currentPrice 80 < 100 -> in profit for short
  applySpikeAndExhaustionChecks('demo', 'futures', position, 80, freshIndicators);
  // suggestedStop = 80 + 4 * 0.75 = 83 < 105
  assert.equal(position.stop_loss, 83);
  assert.equal(position.trailing_high_water_mark, 80);
});

test('applySpikeAndExhaustionChecks: never loosens stop_loss if existing stop is already better', () => {
  const position = {
    id: 9997,
    user_id: 1,
    symbol: 'SOLUSDT',
    side: 'long',
    entry_price: 100,
    qty: 1,
    stop_loss: 112, // already higher than suggestedStop 107
  };
  const freshIndicators = {
    atr: { status: 'ok', value: 4 },
    volumeAnalysis: { status: 'ok', value: { relativeVolume: 2.0 } },
    latestCandle: { open: 100, high: 115, low: 99, close: 114 },
  };
  applySpikeAndExhaustionChecks('demo', 'spot', position, 114, freshIndicators);
  assert.equal(position.stop_loss, 112, 'Stop loss must remain untouched (ratchet rule)');
});

