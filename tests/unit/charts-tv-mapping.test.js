'use strict';

// public/js/charts.js is browser-only (no module.exports, relies on TradingView/LightweightCharts
// globals for the widget-creation functions) — but mapToTradingViewSymbol/mapTimeframeToTvInterval/
// hasTradingViewMapping are pure logic with no DOM dependency, so they're evaluated directly out of
// the real source file here rather than duplicated/reimplemented in the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/charts.js'), 'utf8');
const Charts = (0, eval)(`(function () { ${source}\nreturn Charts; })()`);

test('hasTradingViewMapping is true for every exchange in the app\'s curated ccxt-backed list', () => {
  for (const exchange of ['binance', 'bybit', 'okx', 'kucoin', 'kraken', 'coinbase', 'bitget', 'gate', 'mexc', 'htx', 'bitfinex', 'bitstamp', 'gemini', 'cryptocom', 'coinex']) {
    assert.equal(Charts.hasTradingViewMapping(exchange, 'crypto'), true, exchange);
  }
});

test('hasTradingViewMapping is false for nobitex — TradingView\'s only confirmed Nobitex listing is a single USDTIRT reference rate, not full market coverage, and the embed widget has no way to detect/fall back from a per-symbol resolution failure — so the chart falls back instead of risking a blank "invalid symbol" widget', () => {
  assert.equal(Charts.hasTradingViewMapping('nobitex', 'crypto'), false);
});

test('hasTradingViewMapping is true for stocks regardless of exchange (mapToTradingViewSymbol ignores exchange for stocks)', () => {
  assert.equal(Charts.hasTradingViewMapping('nobitex', 'stock'), true);
  assert.equal(Charts.hasTradingViewMapping('some-unmapped-broker', 'stock'), true);
});

test('mapToTradingViewSymbol builds EXCHANGE:SYMBOL for known crypto exchanges', () => {
  assert.equal(Charts.mapToTradingViewSymbol('BTC/USDT', 'kucoin', 'crypto'), 'KUCOIN:BTCUSDT');
});

test('mapTimeframeToTvInterval maps every app timeframe including "1w"', () => {
  assert.equal(Charts.mapTimeframeToTvInterval('1h'), '60');
  assert.equal(Charts.mapTimeframeToTvInterval('1w'), 'W');
});
