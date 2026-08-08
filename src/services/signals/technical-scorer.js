'use strict';

// Each scorer maps one indicator's already-computed value to a signed contribution in
// [-1, +1] plus a human-readable reason. Indicators with status !== 'ok' are skipped
// entirely (not scored as 0) so their weight doesn't dilute the average.
//
// Default weights below define the "Balanced" strategy. A Strategy definition
// (src/services/signals/strategies.js) can override any of these per-indicator weights —
// the underlying bullish/bearish direction logic never changes, only how much each
// indicator's vote counts toward the final score. Setting a weight to 0 effectively mutes
// that indicator for a given strategy.
const DEFAULT_WEIGHTS = {
  rsi: 1, macd: 1, ema: 1, bollingerBands: 0.7, stochastic: 0.7, adx: 0.6, ichimoku: 0.6, supportResistance: 0.6, volumeAnalysis: 0.3,
};

function clip(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function scoreRsi(rsi, weight) {
  if (rsi.status !== 'ok' || weight <= 0) return null;
  const value = rsi.value;
  if (value < 30) return { score: 0.6, weight, reason: `RSI ${value.toFixed(1)} < 30 → oversold (bullish)` };
  if (value > 70) return { score: -0.6, weight, reason: `RSI ${value.toFixed(1)} > 70 → overbought (bearish)` };
  return { score: clip((50 - value) / 100, -0.3, 0.3), weight, reason: `RSI ${value.toFixed(1)} in neutral zone` };
}

function scoreMacd(macd, weight) {
  if (macd.status !== 'ok' || weight <= 0) return null;
  const { macd: macdLine, signal, histogram } = macd.value;
  if (histogram > 0 && macdLine > signal) {
    return { score: 0.5, weight, reason: `MACD histogram ${histogram.toFixed(3)} positive, MACD above signal → bullish momentum` };
  }
  if (histogram < 0 && macdLine < signal) {
    return { score: -0.5, weight, reason: `MACD histogram ${histogram.toFixed(3)} negative, MACD below signal → bearish momentum` };
  }
  return { score: 0, weight, reason: 'MACD signal is inconclusive/crossing' };
}

function scoreTrend(price, ema, weight) {
  if (ema.status !== 'ok' || weight <= 0) return null;
  const diffPercent = ((price - ema.value) / ema.value) * 100;
  if (price > ema.value) {
    return { score: clip(diffPercent / 10, 0.1, 0.5), weight, reason: `Price ${diffPercent.toFixed(2)}% above EMA${ema.period} → uptrend` };
  }
  return { score: clip(diffPercent / 10, -0.5, -0.1), weight, reason: `Price ${diffPercent.toFixed(2)}% below EMA${ema.period} → downtrend` };
}

function scoreBollinger(bb, weight) {
  if (bb.status !== 'ok' || weight <= 0) return null;
  const { pb } = bb.value;
  if (pb <= 0.05) return { score: 0.4, weight, reason: `Price at %B ${pb.toFixed(2)} → near lower Bollinger Band, potential bounce` };
  if (pb >= 0.95) return { score: -0.4, weight, reason: `Price at %B ${pb.toFixed(2)} → near upper Bollinger Band, potential pullback` };
  return { score: 0, weight, reason: `Price at %B ${pb.toFixed(2)} → within Bollinger Bands` };
}

function scoreStochastic(stoch, weight) {
  if (stoch.status !== 'ok' || weight <= 0) return null;
  const { k, d } = stoch.value;
  if (k < 20 && k > d) return { score: 0.4, weight, reason: `Stochastic %K ${k.toFixed(1)} oversold and turning up` };
  if (k > 80 && k < d) return { score: -0.4, weight, reason: `Stochastic %K ${k.toFixed(1)} overbought and turning down` };
  return { score: 0, weight, reason: `Stochastic %K ${k.toFixed(1)} / %D ${d.toFixed(1)} inconclusive` };
}

function scoreAdx(adx, weight) {
  if (adx.status !== 'ok' || weight <= 0) return null;
  const { adx: strength, pdi, mdi } = adx.value;
  if (strength <= 25) return { score: 0, weight, reason: `ADX ${strength.toFixed(1)} ≤ 25 → weak/no trend` };
  if (pdi > mdi) return { score: 0.3, weight, reason: `ADX ${strength.toFixed(1)} > 25 with +DI > -DI → strong uptrend` };
  return { score: -0.3, weight, reason: `ADX ${strength.toFixed(1)} > 25 with -DI > +DI → strong downtrend` };
}

// Standard Ichimoku reading: price vs. the cloud sets the primary trend direction (above =
// bullish, below = bearish, inside = no clear trend), and the Tenkan/Kijun (conversion/base)
// relationship — the same fast/slow-line idea as an MA cross — either confirms that trend
// (stronger score) or lags behind it (weaker score).
function scoreIchimoku(ichimoku, price, weight) {
  if (!ichimoku || ichimoku.status !== 'ok' || weight <= 0) return null;
  const { conversion, base, cloudTop, cloudBottom } = ichimoku.value;
  const tenkanBullish = conversion > base;

  if (price > cloudTop) {
    return {
      score: tenkanBullish ? 0.7 : 0.4,
      weight,
      reason: `Price above the Ichimoku cloud${tenkanBullish ? ', Tenkan above Kijun' : ''} → bullish trend`,
    };
  }
  if (price < cloudBottom) {
    return {
      score: tenkanBullish ? -0.4 : -0.7,
      weight,
      reason: `Price below the Ichimoku cloud${!tenkanBullish ? ', Tenkan below Kijun' : ''} → bearish trend`,
    };
  }
  return { score: 0, weight, reason: 'Price inside the Ichimoku cloud → no clear trend' };
}

function scoreSupportResistance(sr, price, weight) {
  if (sr.status !== 'ok' || weight <= 0) return null;
  const { nearestSupport, nearestResistance } = sr.value;
  const nearSupport = nearestSupport !== null && (price - nearestSupport) / price <= 0.01;
  const nearResistance = nearestResistance !== null && (nearestResistance - price) / price <= 0.01;
  if (nearSupport) return { score: 0.3, weight, reason: `Price within 1% of support level ${nearestSupport}` };
  if (nearResistance) return { score: -0.3, weight, reason: `Price within 1% of resistance level ${nearestResistance}` };
  return null;
}

// Volume alone has no inherent direction — it's a confirmation signal. Uses price vs SMA as
// the directional context (already computed, no need to thread raw candles through): above-
// average volume while price sits above its SMA reads as bullish confirmation, and the mirror
// for below. Previously computed but never actually scored — a real gap; "Momentum" strategies
// specifically want this kind of confirmation, and it's a reasonable default contributor too.
function scoreVolume(volumeAnalysis, sma, price, weight) {
  if (!volumeAnalysis || volumeAnalysis.status !== 'ok' || !sma || sma.status !== 'ok' || weight <= 0) return null;
  const { relativeVolume } = volumeAnalysis.value;
  if (relativeVolume === null || relativeVolume <= 1.5) {
    return { score: 0, weight, reason: `Volume ${relativeVolume?.toFixed(2) ?? 'n/a'}x average → no strong confirmation` };
  }
  const direction = price > sma.value ? 1 : -1;
  return {
    score: direction * 0.4,
    weight,
    reason: `Volume ${relativeVolume.toFixed(2)}x average confirms ${direction > 0 ? 'upward' : 'downward'} move (price ${direction > 0 ? 'above' : 'below'} SMA${sma.period})`,
  };
}

/**
 * Combines all indicator sub-scores into a single technicalScore in [-1, +1], the list of
 * contributing reasons, and a summary. Returns technicalScore: null if no indicator had
 * enough history to contribute (forces NO_DATA upstream). `indicatorWeights` comes from the
 * active Strategy (see strategies.js) and defaults to the "Balanced" weights above.
 */
function computeTechnicalScore(indicators, price, indicatorWeights = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...indicatorWeights };
  const contributions = [
    scoreRsi(indicators.rsi, w.rsi),
    scoreMacd(indicators.macd, w.macd),
    scoreTrend(price, indicators.ema, w.ema),
    scoreBollinger(indicators.bollingerBands, w.bollingerBands),
    scoreStochastic(indicators.stochastic, w.stochastic),
    scoreAdx(indicators.adx, w.adx),
    scoreIchimoku(indicators.ichimoku, price, w.ichimoku),
    scoreSupportResistance(indicators.supportResistance, price, w.supportResistance),
    scoreVolume(indicators.volumeAnalysis, indicators.sma, price, w.volumeAnalysis),
  ].filter(Boolean);

  if (contributions.length === 0) {
    return { technicalScore: null, reasons: [], summary: { contributingIndicators: 0 } };
  }

  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  const weightedSum = contributions.reduce((sum, c) => sum + c.score * c.weight, 0);
  const technicalScore = clip(weightedSum / totalWeight, -1, 1);

  return {
    technicalScore,
    reasons: contributions.map((c) => c.reason),
    summary: {
      contributingIndicators: contributions.length,
      rsi: indicators.rsi.status === 'ok' ? indicators.rsi.value : null,
      macd: indicators.macd.status === 'ok' ? indicators.macd.value : null,
      adx: indicators.adx.status === 'ok' ? indicators.adx.value.adx : null,
      volume: indicators.volumeAnalysis.status === 'ok' ? indicators.volumeAnalysis.value : null,
    },
  };
}

module.exports = { computeTechnicalScore, DEFAULT_WEIGHTS };
