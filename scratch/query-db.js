'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../data/trading-bot.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('=== Database Schema ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));

for (const t of tables) {
  try {
    const count = db.prepare(`SELECT count(*) as count FROM "${t.name}"`).get();
    console.log(`Table ${t.name}: ${count.count} rows`);
  } catch (err) {
    console.log(`Table ${t.name}: error reading count - ${err.message}`);
  }
}
