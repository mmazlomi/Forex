'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('=== PORTFOLIO BALANCES ===');
console.log('Spot:', db.prepare("SELECT * FROM demo_portfolio").all());
console.log('Futures:', db.prepare("SELECT * FROM demo_futures_portfolio").all());

console.log('\n=== CURRENT OPEN SPOT POSITIONS ===');
const openSpot = db.prepare("SELECT id, symbol, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, tp1_filled_at_utc, tp2_filled_at_utc, realized_pnl_partial_sum FROM demo_positions WHERE status = 'open'").all();
console.log(`Count: ${openSpot.length}`);
console.log(openSpot);

console.log('\n=== CURRENT OPEN FUTURES POSITIONS ===');
const openFut = db.prepare("SELECT id, symbol, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, tp1_filled_at_utc, tp2_filled_at_utc, realized_pnl_partial_sum FROM demo_futures_positions WHERE status = 'open'").all();
console.log(`Count: ${openFut.length}`);
console.log(openFut);

console.log('\n=== CLOSED SPOT (LAST 24 HOURS) ===');
const closedSpot24h = db.prepare("SELECT id, symbol, side, entry_price, exit_price, realized_pnl, exit_reason, opened_at_utc, closed_at_utc FROM demo_positions WHERE status = 'closed' AND closed_at_utc >= '2026-09-23T08:00:00.000Z'").all();
console.log(`Count: ${closedSpot24h.length}`);
console.log(closedSpot24h);

console.log('\n=== CLOSED FUTURES (LAST 24 HOURS) ===');
const closedFut24h = db.prepare("SELECT id, symbol, side, entry_price, exit_price, realized_pnl, exit_reason, opened_at_utc, closed_at_utc FROM demo_futures_positions WHERE status = 'closed' AND closed_at_utc >= '2026-09-23T08:00:00.000Z'").all();
console.log(`Count: ${closedFut24h.length}`);
console.log(closedFut24h);

console.log('\n=== NEW POSITIONS (LAST 24 HOURS) ===');
const newSpot = db.prepare("SELECT id, symbol, side, entry_price, opened_at_utc, status FROM demo_positions WHERE opened_at_utc >= '2026-09-23T08:00:00.000Z'").all();
console.log('New Spot:', newSpot);
const newFut = db.prepare("SELECT id, symbol, side, entry_price, opened_at_utc, status FROM demo_futures_positions WHERE opened_at_utc >= '2026-09-23T08:00:00.000Z'").all();
console.log('New Futures:', newFut);
