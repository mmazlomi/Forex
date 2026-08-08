'use strict';

const signalsRepository = require('../database/repositories/signals-repository');
const signalsService = require('../services/signals');
const { listStrategies } = require('../services/signals/strategies');
const { sendSuccess, sendError } = require('../utils/http-response');

async function listSignals(req, res) {
  const { symbol, mode } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  sendSuccess(res, signalsRepository.listSignals({ symbol, mode, limit, offset }));
}

async function analyzeSignal(req, res) {
  const { symbol, exchange, timeframe, assetType, providerId, mode, strategyId } = req.body || {};
  if (!symbol || !exchange || !assetType) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol, exchange, and assetType are required.');
  }
  if (!['crypto', 'stock'].includes(assetType)) {
    return sendError(res, 'VALIDATION_ERROR', 'assetType must be "crypto" or "stock".');
  }
  const signal = await signalsService.generateSignal({
    symbol, exchange, timeframe: timeframe || '1h', assetType, providerId, mode: mode || 'demo', userId: req.user.id, strategyId,
  });
  sendSuccess(res, signal, 'Signal generated.', 201);
}

async function getStrategies(req, res) {
  sendSuccess(res, listStrategies());
}

module.exports = { listSignals, analyzeSignal, getStrategies };
