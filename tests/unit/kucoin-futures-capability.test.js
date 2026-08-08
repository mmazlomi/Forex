'use strict';

// Verifies the real, installed ccxt KuCoin Futures class actually has the capabilities this
// app's Phase 2 design depends on — not asserting our own code, asserting our assumptions about a
// third-party dependency, the same discipline used for Phase 1's order-type .has verification.
// Bybit was the original choice but proved unreachable from this app's production host (403/
// timeouts against api.bybit.com); KuCoin's futures API is a *separate* ccxt class
// (`kucoinfutures`, not `kucoin` with a defaultType option) — see exchange-client-factory.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const ccxt = require('ccxt');

test('ccxt has a dedicated kucoinfutures class, defaulting to swap', () => {
  assert.equal(typeof ccxt.kucoinfutures, 'function');
  const client = new ccxt.kucoinfutures({});
  assert.equal(client.id, 'kucoinfutures');
  assert.equal(client.options.defaultType, 'swap');
});

test('ccxt kucoinfutures declares support for the futures capabilities Phase 2 depends on', () => {
  const client = new ccxt.kucoinfutures({});
  assert.equal(client.has.swap, true);
  assert.equal(client.has.future, true);
  assert.equal(client.has.fetchPositions, true);
  assert.equal(client.has.setLeverage, true);
  assert.equal(client.has.setMarginMode, true);
  assert.equal(client.has.createOrder, true);
  assert.equal(client.has.fetchBalance, true);
});

test('setLeverage/setMarginMode/fetchPositions/createOrder/fetchBalance exist as callable methods', () => {
  const client = new ccxt.kucoinfutures({});
  assert.equal(typeof client.setLeverage, 'function');
  assert.equal(typeof client.setMarginMode, 'function');
  assert.equal(typeof client.fetchPositions, 'function');
  assert.equal(typeof client.createOrder, 'function');
  assert.equal(typeof client.fetchBalance, 'function');
});
