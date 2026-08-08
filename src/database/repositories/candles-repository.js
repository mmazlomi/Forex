'use strict';

const { getDb } = require('../connection');

function upsertCandles(candles) {
  if (!candles || candles.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, exchange, timeframe, ts_utc, open, high, low, close, volume, source)
     VALUES (@symbol, @exchange, @timeframe, @tsUtc, @open, @high, @low, @close, @volume, @source)
     ON CONFLICT(symbol, exchange, timeframe, ts_utc) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume, source = excluded.source`
  );
  let count = 0;
  for (const candle of candles) {
    stmt.run(candle);
    count += 1;
  }
  return count;
}

function getCandles({ symbol, exchange, timeframe, limit = 200 }) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM candles WHERE symbol = ? AND exchange = ? AND timeframe = ?
       ORDER BY ts_utc DESC LIMIT ?`
    )
    .all(symbol, exchange, timeframe, limit);
  return rows.reverse();
}

function getLatestCandleTime({ symbol, exchange, timeframe }) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT MAX(ts_utc) as latest FROM candles WHERE symbol = ? AND exchange = ? AND timeframe = ?`
    )
    .get(symbol, exchange, timeframe);
  return row && row.latest != null ? row.latest : null;
}

module.exports = { upsertCandles, getCandles, getLatestCandleTime };
