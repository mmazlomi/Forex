'use strict';

// Accessed via the namespace object (liveEngine.getLiveStatus(...) below), not destructured —
// this project's tests mock module functions via t.mock.method(moduleObject, 'fn', ...), which
// only intercepts property access, not a destructured local reference captured at require-time
// (same convention/reasoning as strategy-selector.js's identical comment on optimizer).
const liveEngine = require('../services/reversal-strategy/live-engine');
const { sendSuccess, sendError } = require('../utils/http-response');

// Human-readable label per state.js's STATES — one line, safe to show directly in the Signals
// Setting Results table for an LSR-tagged asset instead of dumping the raw state constant.
const STATE_LABELS = {
  IDLE: 'Idle — no setup in progress',
  LIQUIDITY_SWEEP_DETECTED: 'Liquidity sweep detected — checking for divergence',
  DIVERGENCE_CONFIRMED: 'Divergence confirmed — looking for a CHOCH level',
  WAITING_FOR_CHOCH: 'Waiting for a change-of-character (CHOCH) break',
  CHOCH_CONFIRMED: 'CHOCH confirmed — waiting to start the retest window',
  WAITING_FOR_RETEST: 'Waiting for price to retest the CHOCH level',
  ENTRY_TRIGGERED: 'Entry triggered — placing the order now',
  POSITION_OPEN: 'Position open',
  POSITION_MANAGED: 'Position open (managed)',
  POSITION_CLOSED: 'Position just closed — resetting',
};

/**
 * GET /api/reversal/status?symbol=&exchange=&market=spot|futures&mode=demo|real
 * Read-only — see live-engine.js#getLiveStatus's comment on why this is safe to call from a
 * manual "Generate" click without disturbing the scheduler's own state-machine bookkeeping.
 */
async function getStatus(req, res) {
  const { symbol, exchange, market, mode } = req.query;
  if (!symbol || !exchange) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol and exchange are required.');
  }
  if (!['spot', 'futures'].includes(market)) {
    return sendError(res, 'VALIDATION_ERROR', 'market must be "spot" or "futures".');
  }
  if (!['demo', 'real'].includes(mode)) {
    return sendError(res, 'VALIDATION_ERROR', 'mode must be "demo" or "real".');
  }

  const status = liveEngine.getLiveStatus(mode, req.user.id, symbol, exchange, market);
  if (!status) {
    return sendSuccess(res, { state: null, label: 'No cycle has run yet for this asset.' });
  }
  sendSuccess(res, { ...status, label: STATE_LABELS[status.state] || status.state });
}

module.exports = { getStatus };
