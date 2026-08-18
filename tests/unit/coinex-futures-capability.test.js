'use strict';

// Verifies the real, installed ccxt CoinEx class actually has the capabilities this app's
// CoinEx-futures support depends on — same discipline as kucoin-futures-capability.test.js.
// Unlike KuCoin, CoinEx is a single UNIFIED ccxt class serving spot and swap off one class via
// options.defaultType — there is no separate "coinexfutures" class.
const test = require('node:test');
const assert = require('node:assert/strict');
const ccxt = require('ccxt');

test('ccxt has no separate coinexfutures class — coinex is unified spot+swap', () => {
  assert.equal(typeof ccxt.coinex, 'function');
  assert.equal(ccxt.coinexfutures, undefined);
});

test('ccxt coinex declares support for the futures capabilities this app depends on', () => {
  const client = new ccxt.coinex({ options: { defaultType: 'swap' } });
  assert.equal(client.has.swap, true);
  assert.equal(client.has.setLeverage, true);
  assert.equal(client.has.setMarginMode, true);
  assert.equal(client.has.fetchPositions, true);
  assert.equal(client.has.createOrder, true);
  assert.equal(client.has.fetchBalance, true);
});

test('setLeverage/fetchPositions/createOrder/fetchBalance exist as callable methods', () => {
  const client = new ccxt.coinex({ options: { defaultType: 'swap' } });
  assert.equal(typeof client.setLeverage, 'function');
  assert.equal(typeof client.fetchPositions, 'function');
  assert.equal(typeof client.createOrder, 'function');
  assert.equal(typeof client.fetchBalance, 'function');
});
