'use strict';

// Regression test for a real perf bug: getPublicExchange()/getPublicFuturesExchange() used to
// construct a brand new ccxt client on every call, so ccxt's own "skip loadMarkets() over the
// network once markets are already cached on this instance" optimization never had a chance to
// kick in — every position/signal/candle fetch re-downloaded the exchange's entire market list.
// These clients carry no credentials and are safe to share across callers, so the factory now
// caches one instance per exchange id. This is pure/synchronous (no network calls — just object
// identity), so it's covered as a plain unit test rather than needing a live exchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');

test('getPublicExchange returns the same client instance on repeated calls for the same exchange', () => {
  const first = exchangeClientFactory.getPublicExchange('kucoin');
  const second = exchangeClientFactory.getPublicExchange('kucoin');
  assert.equal(first, second);
});

test('getPublicExchange returns distinct instances for distinct exchanges', () => {
  const kucoin = exchangeClientFactory.getPublicExchange('kucoin');
  const coinex = exchangeClientFactory.getPublicExchange('coinex');
  assert.notEqual(kucoin, coinex);
});

test('getPublicExchange caching is case-insensitive on the exchange id', () => {
  const lower = exchangeClientFactory.getPublicExchange('coinex');
  const upper = exchangeClientFactory.getPublicExchange('COINEX');
  assert.equal(lower, upper);
});

test('getPublicFuturesExchange returns the same client instance on repeated calls for the same exchange', () => {
  const first = exchangeClientFactory.getPublicFuturesExchange('kucoin');
  const second = exchangeClientFactory.getPublicFuturesExchange('kucoin');
  assert.equal(first, second);
});

test('getPublicExchange and getPublicFuturesExchange caches are independent (spot vs futures clients never collide)', () => {
  const spot = exchangeClientFactory.getPublicExchange('kucoin');
  const futures = exchangeClientFactory.getPublicFuturesExchange('kucoin');
  assert.notEqual(spot, futures);
});
