'use strict';

// Central, validated map from mode -> table name. Table identifiers can't be parameterized
// in SQL, so every repository that's mode-aware routes through this instead of interpolating
// the caller's `mode` string directly — only 'demo'/'real' (or 'backtest' where relevant) are
// ever accepted, so there is no injection surface even though the table name ends up in the
// query text.
const PORTFOLIO_TABLES = { demo: 'demo_portfolio', real: 'real_portfolio' };
const POSITIONS_TABLES = { demo: 'demo_positions', real: 'real_positions' };
const ORDERS_TABLES = { demo: 'demo_orders', real: 'real_orders' };

const FUTURES_PORTFOLIO_TABLES = { demo: 'demo_futures_portfolio', real: 'real_futures_portfolio' };
const FUTURES_POSITIONS_TABLES = { demo: 'demo_futures_positions', real: 'real_futures_positions' };
const FUTURES_ORDERS_TABLES = { demo: 'demo_futures_orders', real: 'real_futures_orders' };
const FUTURES_ASSETS_TABLES = { demo: 'demo_futures_assets', real: 'real_futures_assets' };

function assertTradingMode(mode) {
  if (mode !== 'demo' && mode !== 'real') {
    throw new Error(`Invalid mode "${mode}" — must be "demo" or "real"`);
  }
}

function portfolioTable(mode) {
  assertTradingMode(mode);
  return PORTFOLIO_TABLES[mode];
}

function positionsTable(mode) {
  assertTradingMode(mode);
  return POSITIONS_TABLES[mode];
}

function ordersTable(mode) {
  assertTradingMode(mode);
  return ORDERS_TABLES[mode];
}

function futuresPortfolioTable(mode) {
  assertTradingMode(mode);
  return FUTURES_PORTFOLIO_TABLES[mode];
}

function futuresPositionsTable(mode) {
  assertTradingMode(mode);
  return FUTURES_POSITIONS_TABLES[mode];
}

function futuresOrdersTable(mode) {
  assertTradingMode(mode);
  return FUTURES_ORDERS_TABLES[mode];
}

function futuresAssetsTable(mode) {
  assertTradingMode(mode);
  return FUTURES_ASSETS_TABLES[mode];
}

module.exports = {
  assertTradingMode,
  portfolioTable,
  positionsTable,
  ordersTable,
  futuresPortfolioTable,
  futuresPositionsTable,
  futuresOrdersTable,
  futuresAssetsTable,
};
