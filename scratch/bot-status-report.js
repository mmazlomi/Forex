'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('=== 1. EMERGENCY STOP STATUS ===');
const globalStop = db.prepare("SELECT * FROM emergency_stop_global").all();
const userStop = db.prepare("SELECT * FROM emergency_stop_user").all();
console.log('Global Stop:', globalStop);
console.log('User Stop:', userStop);

console.log('\n=== 2. PORTFOLIO BALANCES ===');
const spotPort = db.prepare("SELECT * FROM demo_portfolio").all();
const futPort = db.prepare("SELECT * FROM demo_futures_portfolio").all();
console.log('Spot Portfolio:', spotPort);
console.log('Futures Portfolio:', futPort);

console.log('\n=== 3. CURRENTLY OPEN SPOT POSITIONS ===');
const openSpot = db.prepare(`
  SELECT id, symbol, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, 
         tp1_price, tp2_price, tp3_price, tp1_filled_at_utc, tp2_filled_at_utc, tp3_filled_at_utc,
         realized_pnl_partial_sum, trailing_high_water_mark
  FROM demo_positions 
  WHERE status = 'open'
  ORDER BY opened_at_utc DESC
`).all();
console.log(`Open Spot Count: ${openSpot.length}`);
console.log(openSpot);

console.log('\n=== 4. CURRENTLY OPEN FUTURES POSITIONS ===');
const openFut = db.prepare(`
  SELECT id, symbol, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, 
         tp1_price, tp2_price, tp3_price, tp1_filled_at_utc, tp2_filled_at_utc, tp3_filled_at_utc,
         realized_pnl_partial_sum, trailing_high_water_mark
  FROM demo_futures_positions 
  WHERE status = 'open'
  ORDER BY opened_at_utc DESC
`).all();
console.log(`Open Futures Count: ${openFut.length}`);
console.log(openFut);

console.log('\n=== 5. POSITIONS CLOSED IN THE LAST 24 HOURS (Since 2026-09-23T08:00:00Z) ===');
const closedSpot24h = db.prepare(`
  SELECT id, symbol, side, entry_price, exit_price, realized_pnl, exit_reason, opened_at_utc, closed_at_utc
  FROM demo_positions
  WHERE status = 'closed' AND closed_at_utc >= '2026-09-23T08:00:00.000Z'
  ORDER BY closed_at_utc DESC
`).all();
console.log(`Closed Spot (last 24h): ${closedSpot24h.length}`);
console.log(closedSpot24h);

const closedFut24h = db.prepare(`
  SELECT id, symbol, side, entry_price, exit_price, realized_pnl, exit_reason, opened_at_utc, closed_at_utc
  FROM demo_futures_positions
  WHERE status = 'closed' AND closed_at_utc >= '2026-09-23T08:00:00.000Z'
  ORDER BY closed_at_utc DESC
`).all();
console.log(`Closed Futures (last 24h): ${closedFut24h.length}`);
console.log(closedFut24h);

console.log('\n=== 6. NEW POSITIONS OPENED IN THE LAST 24 HOURS ===');
const newSpot24h = db.prepare(`
  SELECT id, symbol, side, entry_price, opened_at_utc, status
  FROM demo_positions
  WHERE opened_at_utc >= '2026-09-23T08:00:00.000Z'
  ORDER BY opened_at_utc DESC
`).all();
console.log(`New Spot Opened (last 24h): ${newSpot24h.length}`, newSpot24h);

const newFut24h = db.prepare(`
  SELECT id, symbol, side, entry_price, opened_at_utc, status
  FROM demo_futures_positions
  WHERE opened_at_utc >= '2026-09-23T08:00:00.000Z'
  ORDER BY opened_at_utc DESC
`).all();
console.log(`New Futures Opened (last 24h): ${newFut24h.length}`, newFut24h);

console.log('\n=== 7. LATEST LOGS & ACTIVITY ===');
const latestLogs = db.prepare(`
  SELECT id, level, category, message, created_at_utc
  FROM logs
  ORDER BY created_at_utc DESC
  LIMIT 25
`).all();
console.log(latestLogs);

console.log('\n=== 8. RECENT WARNINGS OR ERRORS ===');
const recentErrors = db.prepare(`
  SELECT id, level, category, message, created_at_utc
  FROM logs
  WHERE level IN ('warn', 'error') AND created_at_utc >= '2026-09-23T08:00:00.000Z'
  ORDER BY created_at_utc DESC
  LIMIT 15
`).all();
console.log('Recent warnings/errors count:', recentErrors.length);
console.log(recentErrors);
