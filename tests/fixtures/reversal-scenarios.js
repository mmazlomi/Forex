'use strict';

// Hand-built, PROGRAMMATICALLY VERIFIED synthetic OHLC scenarios for the Liquidity Sweep
// Reversal strategy (src/services/reversal-strategy/*). Each one was constructed by iterating
// against the real detector modules (not hand-computed) until it produced a genuine end-to-end
// setup: sweep (idx 33) -> divergence -> CHOCH break (idx 49) -> retest touch (idx 50) ->
// confirmation candle (idx 51) -> ENTRY_TRIGGERED, verified for all three entry modes. Shared by
// tests/unit/reversal-strategy/state-machine.test.js and tests/integration/reversal-backtest.test.js
// so both exercise the exact same, already-proven price action instead of independently
// hand-waved data.

function candle(open, high, low, close) {
  return { open, high, low, close };
}

/** Default merged-config overrides these scenarios were tuned against. */
const SCENARIO_CONFIG_OVERRIDES = {
  swingLookback: 2,
  sweepMinPenetrationPercent: 0.05,
  sweepLookbackBars: 50,
  rsiPeriod: 14,
  maxDivergenceDistanceBars: 50,
  chochExpiryBars: 30,
  retestTolerancePercent: 0.5,
  retestExpiryBars: 30,
  confirmationExpiryBars: 10,
};

/**
 * A clean bullish reversal: swing high @108 (idx 13, the CHOCH target) -> steep decline into a
 * confirmed swing low @74.8 (idx 22) -> a choppy, weaker-momentum bleed to a marginal new low
 * that sweeps the swing low and reclaims same-bar (idx 33, RSI divergence: 24.17 > 13.42) ->
 * rally breaking closes back above 108 (idx 49, CHOCH) -> pullback touching the 108 zone
 * (idx 50) -> bullish rejection candle closing back above the zone (idx 51, entry fires here in
 * 'retest_confirmation' mode; idx 50 in 'retest' mode; idx 49 in 'immediate' mode).
 */
function buildBullishReversalCandles() {
  const c = [];
  for (let i = 0; i < 12; i += 1) c.push(candle(100, 100.5, 99.5, 100));
  c.push(candle(100, 101, 99, 100));
  c.push(candle(101, 108, 100, 107)); // idx 13: swing high @108
  c.push(candle(107, 107, 104, 105));
  c.push(candle(105, 105, 102, 103));
  let price = 103;
  for (let i = 0; i < 7; i += 1) {
    const open = price;
    price -= 4;
    c.push(candle(open, open + 0.2, price - 0.2, price));
  }
  const swingLowPrice = price;
  c.push(candle(price, price + 3, price - 0.1, price + 2));
  c.push(candle(price + 2, price + 3, price + 1.5, price + 2.5));
  price += 2.5;
  for (let i = 0; i < 9; i += 1) {
    let open = price;
    price -= 1;
    c.push(candle(open, open + 0.5, price - 0.3, price));
    open = price;
    price += 0.6;
    c.push(candle(open, price + 0.3, open - 0.1, price));
  }
  const dip = swingLowPrice - 1;
  const reclaim = swingLowPrice + 0.5;
  c.push(candle(price, price + 0.2, dip, reclaim)); // idx 33: sweep bar
  price = reclaim;

  for (let i = 0; i < 6; i += 1) {
    const open = price;
    price += 6;
    c.push(candle(open, price + 0.3, open - 0.3, price)); // rally through the CHOCH level
  }
  const peak = price;
  price -= 5;
  c.push(candle(peak, peak + 0.2, 107.6, price)); // idx 50: retest touch
  const rejOpen = price;
  const rejClose = rejOpen + 4;
  c.push(candle(rejOpen, rejClose + 0.3, rejOpen - 0.3, rejClose)); // idx 51: confirmation candle
  price = rejClose;
  for (let i = 0; i < 4; i += 1) {
    const open = price;
    price += 3;
    c.push(candle(open, price + 0.2, open - 0.2, price));
  }
  return c;
}

/** Exact mirror of buildBullishReversalCandles — same bar indices for every stage (sweep 33,
 *  CHOCH 49, retest touch 50, confirmation 51), inverted direction. */
function buildBearishReversalCandles() {
  const c = [];
  for (let i = 0; i < 12; i += 1) c.push(candle(100, 100.5, 99.5, 100));
  c.push(candle(100, 101, 99, 100));
  c.push(candle(101, 102, 94, 95)); // idx 13: swing low @94
  c.push(candle(95, 97, 95, 97));
  c.push(candle(97, 99, 97, 99));
  let price = 99;
  for (let i = 0; i < 7; i += 1) {
    const open = price;
    price += 4;
    c.push(candle(open, price + 0.2, open - 0.2, price));
  }
  const swingHighPrice = price;
  c.push(candle(price, price + 0.1, price - 3, price - 2));
  c.push(candle(price - 2, price - 1.5, price - 3, price - 2.5));
  price -= 2.5;
  for (let i = 0; i < 9; i += 1) {
    let open = price;
    price += 1;
    c.push(candle(open, price + 0.3, open - 0.5, price));
    open = price;
    price -= 0.6;
    c.push(candle(open, open + 0.1, price - 0.3, price));
  }
  const spike = swingHighPrice + 1;
  const reclaim = swingHighPrice - 0.5;
  c.push(candle(price, spike, price - 0.2, reclaim)); // idx 33: sweep bar
  price = reclaim;

  for (let i = 0; i < 6; i += 1) {
    const open = price;
    price -= 6;
    c.push(candle(open, open + 0.3, price - 0.3, price)); // decline through the CHOCH level
  }
  const trough = price;
  price += 5;
  c.push(candle(trough, 94.4, trough - 0.2, price)); // idx 50: retest touch
  const rejOpen = price;
  const rejClose = rejOpen - 4;
  c.push(candle(rejOpen, rejOpen + 0.3, rejClose - 0.3, rejClose)); // idx 51: confirmation candle
  price = rejClose;
  for (let i = 0; i < 4; i += 1) {
    const open = price;
    price -= 3;
    c.push(candle(open, open + 0.2, price - 0.2, price));
  }
  return c;
}

const SCENARIO_INDICES = Object.freeze({
  sweep: 33,
  choch: 49,
  retestTouch: 50,
  confirmation: 51,
});

module.exports = {
  candle,
  SCENARIO_CONFIG_OVERRIDES,
  SCENARIO_INDICES,
  buildBullishReversalCandles,
  buildBearishReversalCandles,
};
