'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('=== Portfolio Balances ===');
const spotPort = db.prepare("SELECT * FROM demo_portfolio").all();
console.log('Demo Spot Portfolio:', spotPort);

const futPort = db.prepare("SELECT * FROM demo_futures_portfolio").all();
console.log('Demo Futures Portfolio:', futPort);

console.log('\n=== Currently OPEN Spot Positions (Full) ===');
const openSpot = db.prepare("SELECT id, symbol, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, tp1_filled_at_utc, tp2_filled_at_utc, realized_pnl_partial_sum FROM demo_positions WHERE status = 'open'").all();
console.log(JSON.stringify(openSpot, null, 2));

console.log('\n=== Currently OPEN Futures Positions (Full) ===');
const openFut = db.prepare("SELECT id, symbol, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, tp1_filled_at_utc, tp2_filled_at_utc, realized_pnl_partial_sum FROM demo_futures_positions WHERE status = 'open'").all();
console.log(JSON.stringify(openFut, null, 2));

console.log('\n=== Top Winners & Losers (Spot) ===');
const topSpotTrades = db.prepare(`
  SELECT symbol, side, entry_price, exit_price, realized_pnl, exit_reason, opened_at_utc, closed_at_utc
  FROM demo_positions
  WHERE status = 'closed' AND opened_at_utc >= '2026-09-15T12:47:29.000Z'
  ORDER BY realized_pnl DESC
  LIMIT 5
`).all();
console.log('Top 5 Wins Spot:', topSpotTrades);

console.log('\n=== Top Winners & Losers (Futures) ===');
const topFutTrades = db.prepare(`
  SELECT symbol, side, entry_price, exit_price, realized_pnl, exit_reason, opened_at_utc, closed_at_utc
  FROM demo_futures_positions
  WHERE status = 'closed' AND opened_at_utc >= '2026-09-15T12:47:29.000Z'
  ORDER BY realized_pnl DESC
  LIMIT 5
`).all();
console.log('Top 5 Wins Futures:', topFutTrades);

