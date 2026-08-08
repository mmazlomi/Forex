'use strict';

const NobitexExchange = require('./custom-exchanges/nobitex-exchange');

// Exchanges ccxt doesn't support at all, given a ccxt-shaped adapter so the rest of the app
// (which resolves every exchange id via `ccxt[id]`-style lookups) doesn't need special-casing
// beyond checking this registry first — see exchange-client-factory.js#resolveExchangeClass()
// and docs/architecture.md §16.
const CUSTOM_EXCHANGES = {
  nobitex: NobitexExchange,
};

module.exports = { CUSTOM_EXCHANGES };
