'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('=== demo_positions summary ===');
const posStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
    SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
    MIN(opened_at_utc) as earliest_opened,
    MAX(opened_at_utc) as latest_opened,
    MIN(closed_at_utc) as earliest_closed,
    MAX(closed_at_utc) as latest_closed,
    SUM(realized_pnl) as total_realized_pnl,
    SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as win_count,
    SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as loss_count
  FROM demo_positions
`).get();
console.log('Spot Demo Stats:', posStats);

console.log('\n=== demo_futures_positions summary ===');
const futStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
    SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
    MIN(opened_at_utc) as earliest_opened,
    MAX(opened_at_utc) as latest_opened,
    MIN(closed_at_utc) as earliest_closed,
    MAX(closed_at_utc) as latest_closed,
    SUM(realized_pnl) as total_realized_pnl,
    SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as win_count,
    SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as loss_count
  FROM demo_futures_positions
`).get();
console.log('Futures Demo Stats:', futStats);

console.log('\n=== Exit Reasons in demo_positions ===');
const spotExitReasons = db.prepare(`
  SELECT exit_reason, COUNT(*) as count, SUM(realized_pnl) as pnl, AVG(realized_pnl) as avg_pnl
  FROM demo_positions
  WHERE status = 'closed'
  GROUP BY exit_reason
  ORDER BY count DESC
`).all();
console.log(spotExitReasons);

console.log('\n=== Exit Reasons in demo_futures_positions ===');
const futExitReasons = db.prepare(`
  SELECT exit_reason, COUNT(*) as count, SUM(realized_pnl) as pnl, AVG(realized_pnl) as avg_pnl
  FROM demo_futures_positions
  WHERE status = 'closed'
  GROUP BY exit_reason
  ORDER BY count DESC
`).all();
console.log(futExitReasons);
