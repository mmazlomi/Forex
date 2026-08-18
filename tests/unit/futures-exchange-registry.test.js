'use strict';

// exchange-client-factory.js's FUTURES_EXCHANGES registry is the single source of truth for
// "which exchanges support futures here" — used by futures-controller.js, futures-real-orders.js,
// and futures-auto-trader.js. This is pure/synchronous (no network calls), so it's covered as a
// plain unit test rather than needing a live exchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');

test('isFuturesExchangeSupported: kucoin and coinex are supported, other exchanges are not', () => {
  assert.equal(exchangeClientFactory.isFuturesExchangeSupported('kucoin'), true);
  assert.equal(exchangeClientFactory.isFuturesExchangeSupported('coinex'), true);
  assert.equal(exchangeClientFactory.isFuturesExchangeSupported('KUCOIN'), true, 'case-insensitive');
  assert.equal(exchangeClientFactory.isFuturesExchangeSupported('binance'), false);
  assert.equal(exchangeClientFactory.isFuturesExchangeSupported('bybit'), false, 'Bybit was rejected for unreachability — see docs/architecture.md');
  assert.equal(exchangeClientFactory.isFuturesExchangeSupported(undefined), false);
});

test('getFuturesLeverageMode: kucoin is inline, coinex is preset', () => {
  assert.equal(exchangeClientFactory.getFuturesLeverageMode('kucoin'), 'inline');
  assert.equal(exchangeClientFactory.getFuturesLeverageMode('coinex'), 'preset');
  assert.equal(exchangeClientFactory.getFuturesLeverageMode('binance'), undefined);
});

test('getSupportedFuturesExchanges: returns both exchanges with human-readable names', () => {
  const list = exchangeClientFactory.getSupportedFuturesExchanges();
  const byId = Object.fromEntries(list.map((e) => [e.id, e.name]));
  assert.equal(list.length, 2);
  assert.ok(byId.kucoin);
  assert.ok(byId.coinex);
});

test('getPublicFuturesExchange: resolves kucoin to the dedicated kucoinfutures ccxt class', () => {
  const client = exchangeClientFactory.getPublicFuturesExchange('kucoin');
  assert.equal(client.id, 'kucoinfutures');
});

test('getPublicFuturesExchange: resolves coinex to the unified coinex ccxt class with defaultType=swap', () => {
  const client = exchangeClientFactory.getPublicFuturesExchange('coinex');
  assert.equal(client.id, 'coinex');
  assert.equal(client.options.defaultType, 'swap');
});

test('getPublicFuturesExchange: throws for an unsupported exchange, listing what IS supported', () => {
  assert.throws(() => exchangeClientFactory.getPublicFuturesExchange('binance'), /kucoin.*coinex|coinex.*kucoin/);
});
