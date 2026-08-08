'use strict';

const { getDb } = require('../connection');

function insertRun(run) {
  const db = getDb();
  db.prepare(
    `INSERT INTO backtest_runs (
       id, symbol, exchange, timeframe, start_utc, end_utc, initial_capital,
       fee_percent, slippage_percent, strategy_version, strategy_id, created_at_utc, metrics_json, status
     ) VALUES (
       @id, @symbol, @exchange, @timeframe, @startUtc, @endUtc, @initialCapital,
       @feePercent, @slippagePercent, @strategyVersion, @strategyId, @createdAtUtc, @metricsJson, @status
     )`
  ).run({ strategyId: null, ...run });
  return getRun(run.id);
}

function updateRun(id, { metricsJson, status }) {
  const db = getDb();
  db.prepare(`UPDATE backtest_runs SET metrics_json = ?, status = ? WHERE id = ?`).run(metricsJson, status, id);
  return getRun(id);
}

function getRun(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id);
}

function listRuns({ limit = 50, offset = 0 } = {}) {
  const db = getDb();
  return db.prepare('SELECT * FROM backtest_runs ORDER BY created_at_utc DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function insertTrade(trade) {
  const db = getDb();
  db.prepare(
    `INSERT INTO backtest_trades (
       run_id, symbol, side, entry_price, exit_price, qty, entered_at_utc, exited_at_utc, pnl, signal_id, exit_reason
     ) VALUES (
       @runId, @symbol, @side, @entryPrice, @exitPrice, @qty, @enteredAtUtc, @exitedAtUtc, @pnl, @signalId, @exitReason
     )`
  ).run({ signalId: null, exitReason: null, ...trade });
}

function listTrades(runId) {
  const db = getDb();
  return db.prepare('SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY entered_at_utc').all(runId);
}

function insertEquityPoint(runId, tsUtc, equity) {
  const db = getDb();
  db.prepare('INSERT INTO backtest_equity_curve (run_id, ts_utc, equity) VALUES (?, ?, ?)').run(runId, tsUtc, equity);
}

function listEquityCurve(runId) {
  const db = getDb();
  return db.prepare('SELECT ts_utc, equity FROM backtest_equity_curve WHERE run_id = ? ORDER BY ts_utc').all(runId);
}

module.exports = { insertRun, updateRun, getRun, listRuns, insertTrade, listTrades, insertEquityPoint, listEquityCurve };
