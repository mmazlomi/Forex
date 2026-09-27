'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('=== Currently OPEN Spot Positions ===');
const openSpot = db.prepare("SELECT id, symbol, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, tp1_filled_at_utc, tp2_filled_at_utc, tp3_filled_at_utc FROM demo_positions WHERE status = 'open'").all();
console.log(openSpot);

console.log('\n=== Currently OPEN Futures Positions ===');
const openFut = db.prepare("SELECT id, symbol, side, qty, entry_price, stop_loss, take_profit, opened_at_utc, tp1_filled_at_utc, tp2_filled_at_utc, tp3_filled_at_utc FROM demo_futures_positions WHERE status = 'open'").all();
console.log(openFut);

console.log('\n=== Performance by Symbol (Spot Demo, Post-Update) ===');
const spotBySymbol = db.prepare(`
  SELECT symbol, COUNT(*) as trades, 
         SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
         ROUND(SUM(realized_pnl), 2) as total_pnl,
         ROUND(AVG(realized_pnl), 2) as avg_pnl
  FROM demo_positions
  WHERE status = 'closed' AND opened_at_utc >= '2026-09-15T12:47:29.000Z'
  GROUP BY symbol
  ORDER BY total_pnl DESC
`).all();
console.log(spotBySymbol);

console.log('\n=== Performance by Symbol (Futures Demo, Post-Update) ===');
const futBySymbol = db.prepare(`
  SELECT symbol, COUNT(*) as trades, 
         SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
         ROUND(SUM(realized_pnl), 2) as total_pnl,
         ROUND(AVG(realized_pnl), 2) as avg_pnl
  FROM demo_futures_positions
  WHERE status = 'closed' AND opened_at_utc >= '2026-09-15T12:47:29.000Z'
  GROUP BY symbol
  ORDER BY total_pnl DESC
`).all();
console.log(futBySymbol);

console.log('\n=== Recent Adaptive TP / Spike / Exhaustion in Logs ===');
const recentLogs = db.prepare(`
  SELECT level, message, created_at_utc 
  FROM logs 
  WHERE message LIKE '%spike%' OR message LIKE '%exhaustion%' OR message LIKE '%adaptive%' OR message LIKE '%take profit%' OR message LIKE '%trailing%'
  ORDER BY created_at_utc DESC
  LIMIT 20
`).all();
console.log(recentLogs);
