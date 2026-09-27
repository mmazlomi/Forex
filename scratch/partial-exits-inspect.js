'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

const partialExits = db.prepare(`
  SELECT symbol, realized_pnl, tp1_filled_at_utc, tp2_filled_at_utc, tp3_filled_at_utc, realized_pnl_partial_sum, exit_reason, partial_exits_json
  FROM demo_positions
  WHERE tp1_filled_at_utc IS NOT NULL AND opened_at_utc >= '2026-09-15T12:47:29.000Z'
  LIMIT 5
`).all();
console.log('Sample Partial Exits Spot:', partialExits);

const partialExitsFut = db.prepare(`
  SELECT symbol, realized_pnl, tp1_filled_at_utc, tp2_filled_at_utc, tp3_filled_at_utc, realized_pnl_partial_sum, exit_reason, partial_exits_json
  FROM demo_futures_positions
  WHERE tp1_filled_at_utc IS NOT NULL AND opened_at_utc >= '2026-09-15T12:47:29.000Z'
  LIMIT 5
`).all();
console.log('Sample Partial Exits Futures:', partialExitsFut);

