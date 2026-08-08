'use strict';

const ccxt = require('ccxt');
const exchangeClientFactory = require('../services/exchanges/exchange-client-factory');
const { CUSTOM_EXCHANGES } = require('../services/exchanges/custom-exchange-registry');
const { getSymbolsForExchange } = require('../services/market-data/symbol-list-service');
const { sendSuccess, sendError } = require('../utils/http-response');

// Curated subset of ccxt's 100+ supported exchanges — a raw dropdown of everything ccxt
// supports would be unusable. These are the exchanges actually reachable in normal use
// and worth surfacing; anything else is still usable via POST /api/assets by exchange id,
// this list is just what's offered by default in the picker. 'nobitex' isn't a ccxt exchange at
// all — it's a hand-written adapter (see custom-exchange-registry.js and
// docs/architecture.md §16), included here the same way since it's ccxt-shaped from the rest of
// the app's point of view.
const CURATED_EXCHANGE_IDS = [
  'binance', 'bybit', 'okx', 'kucoin', 'kraken', 'coinbase', 'bitget',
  'gate', 'mexc', 'htx', 'bitfinex', 'bitstamp', 'gemini', 'cryptocom', 'coinex', 'nobitex',
];

async function listExchanges(req, res) {
  const exchanges = CURATED_EXCHANGE_IDS.filter((id) => CUSTOM_EXCHANGES[id] || ccxt[id]).map((id) => {
    const ExchangeClass = CUSTOM_EXCHANGES[id] || ccxt[id];
    const instance = new ExchangeClass({});
    const probe = exchangeClientFactory.probeSandboxSupport(id);
    return { id, name: instance.name || id, hasSandbox: probe.hasSandbox };
  });
  sendSuccess(res, exchanges);
}

// Not in the original spec — the symbol field's suggestions were a fixed list of 7 hardcoded
// majors, which doesn't reflect what's actually tradable on the selected exchange. Returns
// every active spot symbol (USDT/USD/USDC-quoted pairs first), cached per exchange for an hour.
async function listSymbols(req, res) {
  const { exchange } = req.query;
  if (!exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'exchange query parameter is required.');
  }
  const symbols = await getSymbolsForExchange(exchange.toLowerCase());
  sendSuccess(res, symbols);
}

module.exports = { listExchanges, listSymbols };
