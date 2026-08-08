'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSignal } = require('../../src/services/signals/scoring-engine');

function candles(n = 20) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    tsUtc: now - (n - i) * 3600_000, open: 99, high: 101, low: 98, close: 100, volume: 10,
  }));
}

const bullishIndicators = {
  rsi: { status: 'ok', value: 25 },
  macd: { status: 'ok', value: { macd: 1, signal: 0.5, histogram: 0.5 } },
  ema: { status: 'ok', value: 95, period: 20 },
  bollingerBands: { status: 'ok', value: { pb: 0.02, upper: 105, middle: 100, lower: 95 } },
  stochastic: { status: 'ok', value: { k: 15, d: 10 } },
  adx: { status: 'ok', value: { adx: 30, pdi: 25, mdi: 10 } },
  ichimoku: { status: 'ok', value: { conversion: 98, base: 96, spanA: 90, spanB: 85, cloudTop: 90, cloudBottom: 85 } },
  supportResistance: { status: 'ok', value: { nearestSupport: 99.5, nearestResistance: 110 } },
  atr: { status: 'ok', value: 2 },
  volumeAnalysis: { status: 'ok', value: { currentVolume: 10, volumeSma: 8, relativeVolume: 1.25 } },
};

const noHistoryIndicators = {
  rsi: { status: 'insufficient_history' }, macd: { status: 'insufficient_history' },
  ema: { status: 'insufficient_history' }, bollingerBands: { status: 'insufficient_history' },
  stochastic: { status: 'insufficient_history' }, adx: { status: 'insufficient_history' },
  ichimoku: { status: 'insufficient_history' },
  supportResistance: { status: 'insufficient_history' }, atr: { status: 'insufficient_history' },
  volumeAnalysis: { status: 'insufficient_history' },
};

test('Final Score = technicalScore * technicalWeight + fundamentalScore * fundamentalWeight', () => {
  const fundamentals = { fields: { healthStatus: { value: 'neutral' } } };
  const signal = computeSignal({ candles: candles(), indicators: bullishIndicators, fundamentals, config: {} });
  const expected = signal.technicalScore * 0.6 + 0 * 0.4;
  assert.ok(Math.abs(signal.finalScore - expected) < 1e-9);
});

test('produces a BUY signal with entry/stop/take constructed from ATR and meeting minRiskRewardRatio', () => {
  const fundamentals = { fields: { healthStatus: { value: 'healthy' } } };
  const signal = computeSignal({ candles: candles(), indicators: bullishIndicators, fundamentals, config: {} });
  assert.equal(signal.status, 'BUY');
  assert.equal(signal.entry, 100);
  assert.equal(signal.stopLoss, 96); // 100 - ATR(2) * multiplier(2)
  assert.equal(signal.takeProfit, 106); // 100 + 4 * minRiskRewardRatio(1.5)
  assert.ok(signal.riskRewardRatio >= 1.5);
});

test('never returns BUY/SELL when there is no candle history at all', () => {
  const signal = computeSignal({ candles: [], indicators: noHistoryIndicators, fundamentals: null, config: {} });
  assert.equal(signal.status, 'NO_DATA');
});

test('never returns BUY/SELL when no indicator has enough history', () => {
  const signal = computeSignal({ candles: candles(), indicators: noHistoryIndicators, fundamentals: null, config: {} });
  assert.equal(signal.status, 'NO_DATA');
  assert.equal(signal.technicalScore, null);
});

test('refuses BUY/SELL when fundamental data is unavailable and fundamentalWeight > 0 (never fabricates)', () => {
  const fundamentals = { fields: { healthStatus: { value: 'unavailable', unavailableReason: 'no_key' } } };
  const signal = computeSignal({ candles: candles(), indicators: bullishIndicators, fundamentals, config: {} });
  assert.equal(signal.status, 'NO_DATA');
  assert.ok(signal.warnings.some((w) => w.includes('fundamental')));
});

test('allows a technical-only BUY signal when fundamentalWeight is explicitly 0', () => {
  const fundamentals = { fields: { healthStatus: { value: 'unavailable', unavailableReason: 'no_key' } } };
  const signal = computeSignal({ candles: candles(), indicators: bullishIndicators, fundamentals, config: { fundamentalWeight: 0, technicalWeight: 1 } });
  assert.equal(signal.status, 'BUY');
});

test('downgrades a would-be BUY to HOLD when ATR is unavailable to size a stop-loss', () => {
  const fundamentals = { fields: { healthStatus: { value: 'healthy' } } };
  const indicators = { ...bullishIndicators, atr: { status: 'insufficient_history' } };
  const signal = computeSignal({ candles: candles(), indicators, fundamentals, config: {} });
  assert.equal(signal.status, 'HOLD');
  assert.equal(signal.entry, null);
  assert.ok(signal.warnings.some((w) => w.includes('ATR')));
});

test('Ichimoku cloud position actually moves technicalScore: price above the cloud scores higher than price below it', () => {
  const fundamentals = { fields: { healthStatus: { value: 'neutral' } } };
  const aboveCloud = { ...bullishIndicators, ichimoku: { status: 'ok', value: { conversion: 98, base: 96, spanA: 90, spanB: 85, cloudTop: 90, cloudBottom: 85 } } };
  const belowCloud = { ...bullishIndicators, ichimoku: { status: 'ok', value: { conversion: 105, base: 108, spanA: 110, spanB: 115, cloudTop: 115, cloudBottom: 110 } } };

  const aboveSignal = computeSignal({ candles: candles(), indicators: aboveCloud, fundamentals, config: {} });
  const belowSignal = computeSignal({ candles: candles(), indicators: belowCloud, fundamentals, config: {} });
  assert.ok(aboveSignal.technicalScore > belowSignal.technicalScore);
  assert.ok(aboveSignal.reasons.some((r) => r.includes('above the Ichimoku cloud')));
  assert.ok(belowSignal.reasons.some((r) => r.includes('below the Ichimoku cloud')));
});

test('only ever returns one of BUY, SELL, HOLD, NO_DATA', () => {
  const fundamentals = { fields: { healthStatus: { value: 'neutral' } } };
  const signal = computeSignal({ candles: candles(), indicators: bullishIndicators, fundamentals, config: {} });
  assert.ok(['BUY', 'SELL', 'HOLD', 'NO_DATA'].includes(signal.status));
});
