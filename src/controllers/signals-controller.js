'use strict';

const signalsRepository = require('../database/repositories/signals-repository');
const signalsService = require('../services/signals');
const { listStrategies, scoringRejectionReason } = require('../services/signals/strategies');
const { sendSuccess, sendError } = require('../utils/http-response');

// Liquidity Sweep Reversal is deliberately NOT part of strategies.js's own listStrategies() (see
// that file's comment on EXTENDED_STRATEGY_IDS) — optimizer.js/strategy-selector.js both default
// to listStrategies() as their real-backtest candidate set, and LSR isn't a scoreable weighted
// config, so it must never leak into that list. It's appended here, API-response-only, for BOTH
// spot and futures — the underlying strategy engine emits both bullish (long) and bearish (short)
// signals regardless of market (ARCHITECTURE.md §0), and each execution adapter filters what it
// can't run: reversal-spot-auto-trader.js discards bearish decisions (long-only, no naked
// shorts), reversal-auto-trader.js (futures) executes both. Traded by one of those two dedicated
// schedulers, never by auto-trader.js/futures-auto-trader.js's normal signal-generation path
// (both have an explicit early-return guard skipping LSR-tagged assets).
const { STRATEGY_ID: LSR_STRATEGY_ID, STRATEGY_NAME: LSR_STRATEGY_NAME } = require('../services/backtesting/reversal-backtest-engine');
const LSR_DESCRIPTOR = {
  id: LSR_STRATEGY_ID,
  name: LSR_STRATEGY_NAME,
  description: 'Liquidity Sweep -> RSI Divergence -> CHOCH -> Retest -> Entry, filtered by an Ichimoku higher-timeframe trend check. Long-only on Spot; long and short on Futures. A stateful, multi-timeframe sequence, not a per-candle score — see docs/reversal-strategy/.',
};

async function listSignals(req, res) {
  const { symbol, mode } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  sendSuccess(res, signalsRepository.listSignals({ symbol, mode, limit, offset }));
}

async function analyzeSignal(req, res) {
  const { symbol, exchange, timeframe, assetType, providerId, mode, strategyId, market } = req.body || {};
  if (!symbol || !exchange || !assetType) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol, exchange, and assetType are required.');
  }
  if (!['crypto', 'stock'].includes(assetType)) {
    return sendError(res, 'VALIDATION_ERROR', 'assetType must be "crypto" or "stock".');
  }
  if (market !== undefined && !['spot', 'futures'].includes(market)) {
    return sendError(res, 'VALIDATION_ERROR', 'market must be "spot" or "futures".');
  }
  const rejectionReason = scoringRejectionReason(strategyId);
  if (rejectionReason) {
    return sendError(res, 'VALIDATION_ERROR', rejectionReason);
  }
  const signal = await signalsService.generateSignal({
    symbol, exchange, timeframe: timeframe || '1h', assetType, providerId, mode: mode || 'demo', userId: req.user.id, strategyId, market,
  });
  sendSuccess(res, signal, 'Signal generated.', 201);
}

async function getStrategies(req, res) {
  sendSuccess(res, [...listStrategies(), LSR_DESCRIPTOR]);
}

module.exports = { listSignals, analyzeSignal, getStrategies };
