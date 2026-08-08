'use strict';

const { getDb } = require('../connection');

// combinedStrategyIds/combinedVotes are only populated by generateCombinedSignal() (see
// signals/index.js) — null for every ordinary single-strategy signal, same optional-field
// pattern already established for strategyId below.
function insertSignal(signal) {
  const db = getDb();
  db.prepare(
    `INSERT INTO signals (
       id, symbol, exchange, timeframe, ts_utc, price,
       technical_score, fundamental_score, final_score, status, confidence,
       reasons_json, technical_summary_json, fundamental_summary_json,
       entry, stop_loss, take_profit, risk_reward_ratio,
       data_quality, warnings_json, strategy_version, strategy_id, source_mode,
       combined_strategy_ids_json, combined_votes_json
     ) VALUES (
       @id, @symbol, @exchange, @timeframe, @tsUtc, @price,
       @technicalScore, @fundamentalScore, @finalScore, @status, @confidence,
       @reasonsJson, @technicalSummaryJson, @fundamentalSummaryJson,
       @entry, @stopLoss, @takeProfit, @riskRewardRatio,
       @dataQuality, @warningsJson, @strategyVersion, @strategyId, @sourceMode,
       @combinedStrategyIds, @combinedVotes
     )`
  ).run({ strategyId: null, combinedStrategyIds: null, combinedVotes: null, ...signal });
  return signal;
}

function getSignal(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM signals WHERE id = ?').get(id);
}

function listSignals({ symbol, mode, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (symbol) {
    clauses.push('symbol = ?');
    params.push(symbol);
  }
  if (mode) {
    clauses.push('source_mode = ?');
    params.push(mode);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM signals ${where} ORDER BY ts_utc DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

module.exports = { insertSignal, getSignal, listSignals };
