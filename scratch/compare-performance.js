'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

const updateTimestamp = '2026-09-15T12:47:29.000Z';

console.log('=== Performance Before vs After Update (2026-09-15) ===');

function analyzePeriod(table, label, condition, params = []) {
  const query = `
    SELECT 
      COUNT(*) as total_trades,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
      ROUND(AVG(CASE WHEN realized_pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 2) as win_rate,
      ROUND(SUM(realized_pnl), 2) as total_pnl,
      ROUND(AVG(realized_pnl), 2) as avg_pnl,
      ROUND(AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE NULL END), 2) as avg_win,
      ROUND(AVG(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE NULL END), 2) as avg_loss,
      ROUND(ABS(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END) / NULLIF(SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END), 0)), 2) as profit_factor,
      SUM(CASE WHEN adaptive_tp_enabled = 1 THEN 1 ELSE 0 END) as adaptive_tp_count,
      SUM(CASE WHEN tp1_filled_at_utc IS NOT NULL THEN 1 ELSE 0 END) as tp1_filled_count,
      SUM(CASE WHEN tp2_filled_at_utc IS NOT NULL THEN 1 ELSE 0 END) as tp2_filled_count,
      SUM(CASE WHEN tp3_filled_at_utc IS NOT NULL THEN 1 ELSE 0 END) as tp3_filled_count
    FROM ${table}
    WHERE status = 'closed' AND ${condition}
  `;
  const res = db.prepare(query).get(...params);
  console.log(`[${table}] ${label}:`, res);
  return res;
}

console.log('\n--- SPOT DEMO ---');
analyzePeriod('demo_positions', 'BEFORE UPDATE (opened < 2026-09-15)', 'opened_at_utc < ?', [updateTimestamp]);
analyzePeriod('demo_positions', 'AFTER UPDATE (opened >= 2026-09-15)', 'opened_at_utc >= ?', [updateTimestamp]);

console.log('\n--- FUTURES DEMO ---');
analyzePeriod('demo_futures_positions', 'BEFORE UPDATE (opened < 2026-09-15)', 'opened_at_utc < ?', [updateTimestamp]);
analyzePeriod('demo_futures_positions', 'AFTER UPDATE (opened >= 2026-09-15)', 'opened_at_utc >= ?', [updateTimestamp]);

console.log('\n--- Exit reasons AFTER UPDATE ---');
const recentExitsSpot = db.prepare(`
  SELECT exit_reason, COUNT(*) as count, ROUND(SUM(realized_pnl), 2) as pnl, ROUND(AVG(realized_pnl), 2) as avg_pnl
  FROM demo_positions
  WHERE status = 'closed' AND opened_at_utc >= ?
  GROUP BY exit_reason
`).all(updateTimestamp);
console.log('Spot exits after update:', recentExitsSpot);

const recentExitsFut = db.prepare(`
  SELECT exit_reason, COUNT(*) as count, ROUND(SUM(realized_pnl), 2) as pnl, ROUND(AVG(realized_pnl), 2) as avg_pnl
  FROM demo_futures_positions
  WHERE status = 'closed' AND opened_at_utc >= ?
  GROUP BY exit_reason
`).all(updateTimestamp);
console.log('Futures exits after update:', recentExitsFut);
