'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const exchangeClientFactory = require('../../src/services/exchanges/exchange-client-factory');
const { getSymbolsForExchange } = require('../../src/services/market-data/symbol-list-service');

function fakeExchangeWithMarkets(marketsBySymbol) {
  return {
    markets: marketsBySymbol,
    async loadMarkets() { return this.markets; },
  };
}

test('getSymbolsForExchange pushes digit-leading symbols (e.g. Nobitex-style multiplier tokens) after letter-leading ones, so common assets surface first', async (t) => {
  const markets = {
    '1M_BTT/USDT': { symbol: '1M_BTT/USDT', active: true, spot: true },
    '100K_FLOKI/USDT': { symbol: '100K_FLOKI/USDT', active: true, spot: true },
    'BTC/USDT': { symbol: 'BTC/USDT', active: true, spot: true },
    'ETH/USDT': { symbol: 'ETH/USDT', active: true, spot: true },
    'AAVE/USDT': { symbol: 'AAVE/USDT', active: true, spot: true },
  };
  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => fakeExchangeWithMarkets(markets));

  const symbols = await getSymbolsForExchange('fake-exchange-digit-sort-test');
  assert.deepEqual(symbols, ['AAVE/USDT', 'BTC/USDT', 'ETH/USDT', '100K_FLOKI/USDT', '1M_BTT/USDT']);
});

test('getSymbolsForExchange still ranks preferred quotes (USDT/USD/USDC) above other quotes, ahead of the digit-leading rule', async (t) => {
  const markets = {
    'BTC/IRT': { symbol: 'BTC/IRT', active: true, spot: true },
    '1M_BTT/USDT': { symbol: '1M_BTT/USDT', active: true, spot: true },
  };
  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => fakeExchangeWithMarkets(markets));

  const symbols = await getSymbolsForExchange('fake-exchange-quote-priority-test');
  assert.deepEqual(symbols, ['1M_BTT/USDT', 'BTC/IRT']);
});

test('getSymbolsForExchange excludes inactive/closed markets and non-spot markets', async (t) => {
  const markets = {
    'BTC/USDT': { symbol: 'BTC/USDT', active: true, spot: true },
    'CLOSED/USDT': { symbol: 'CLOSED/USDT', active: false, spot: true },
    'FUTURES/USDT': { symbol: 'FUTURES/USDT', active: true, spot: false },
  };
  t.mock.method(exchangeClientFactory, 'getPublicExchange', () => fakeExchangeWithMarkets(markets));

  const symbols = await getSymbolsForExchange('fake-exchange-filter-test');
  assert.deepEqual(symbols, ['BTC/USDT']);
});
