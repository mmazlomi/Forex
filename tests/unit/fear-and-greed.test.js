'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fearAndGreedService = require('../../src/services/fundamental-analysis/fear-and-greed');

test('fearAndGreedService: getSentimentScore maps 0..100 accurately to -1..+1', () => {
  assert.equal(fearAndGreedService.getSentimentScore(50), 0);
  assert.equal(fearAndGreedService.getSentimentScore(100), 1);
  assert.equal(fearAndGreedService.getSentimentScore(0), -1);
  assert.equal(fearAndGreedService.getSentimentScore(25), -0.5);
  assert.equal(fearAndGreedService.getSentimentScore(75), 0.5);
});

test('fearAndGreedService: getFearAndGreed returns valid structure without throwing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ value: '25', value_classification: 'Extreme Fear', timestamp: '1726200000' }],
    }),
  }));

  const result = await fearAndGreedService.getFearAndGreed();
  assert.equal(typeof result.value, 'number');
  assert.equal(result.value, 25);
  assert.equal(result.classification, 'Extreme Fear');
});
