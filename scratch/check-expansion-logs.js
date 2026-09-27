'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('--- Checking logs for Dynamic TP expansion ---');
const tpExpansionLogs = db.prepare(`
  SELECT * FROM logs 
  WHERE message LIKE '%Dynamic TP%' OR message LIKE '%expansion%' OR message LIKE '%expanded%'
  ORDER BY created_at_utc DESC
  LIMIT 50
`).all();

console.log('Found logs:', tpExpansionLogs.length);
console.log(tpExpansionLogs);

console.log('--- Checking git status and test results ---');
