'use strict';

const riskSettingsRepository = require('../database/repositories/risk-settings-repository');
const emergencyStopRepository = require('../database/repositories/emergency-stop-repository');
const config = require('../../config/config');
const logger = require('../services/logging/logger');
const { sendSuccess, sendError } = require('../utils/http-response');

function defaultsFor(mode) {
  return {
    maxRiskPerTradePercent: config.maxRiskPerTradePercent,
    maxDailyLossPercent: config.maxDailyLossPercent,
    maxOpenPositions: config.maxOpenPositions,
    maxOrderValue: config.maxOrderValue,
    minRiskRewardRatio: config.minRiskRewardRatio,
    maxPortfolioExposurePercent: 50,
  };
}

async function getRiskSettings(req, res) {
  const settings = riskSettingsRepository.ensureDefaults(req.user.id, req.tradingMode, defaultsFor(req.tradingMode));
  sendSuccess(res, settings);
}

const BOUNDS = {
  maxRiskPerTradePercent: [0.01, 10],
  maxDailyLossPercent: [0.1, 25],
  maxOpenPositions: [1, 50],
  maxOrderValue: [1, 10_000_000],
  minRiskRewardRatio: [0.1, 20],
  maxPortfolioExposurePercent: [1, 100],
};

async function putRiskSettings(req, res) {
  const updates = {};
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (req.body[key] === undefined) continue;
    const value = Number(req.body[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return sendError(res, 'VALIDATION_ERROR', `${key} must be a number between ${min} and ${max}.`);
    }
    updates[key] = value;
  }

  const existing = riskSettingsRepository.ensureDefaults(req.user.id, req.tradingMode, defaultsFor(req.tradingMode));
  const merged = {
    maxRiskPerTradePercent: existing.max_risk_per_trade_percent,
    maxDailyLossPercent: existing.max_daily_loss_percent,
    maxOpenPositions: existing.max_open_positions,
    maxOrderValue: existing.max_order_value,
    minRiskRewardRatio: existing.min_risk_reward_ratio,
    maxPortfolioExposurePercent: existing.max_portfolio_exposure_percent,
    ...updates,
  };

  const updated = riskSettingsRepository.upsertRiskSettings(req.user.id, req.tradingMode, merged);
  logger.info('risk-settings', `Risk settings updated for mode "${req.tradingMode}"`, updates, req.tradingMode);
  sendSuccess(res, updated, 'Risk settings updated.');
}

// The global scope is a genuine instance-wide panic button, deliberately usable by any logged-in
// user (no admin/role system in this app) — see docs/architecture.md's emergency-stop section.
// demo/real are this user's own scoped stops.
async function postEmergencyStop(req, res) {
  const { scope, reason } = req.body || {};
  if (!['global', 'demo', 'real'].includes(scope)) {
    return sendError(res, 'VALIDATION_ERROR', 'scope must be "global", "demo", or "real".');
  }
  const state = emergencyStopRepository.setActive(scope, req.user.id, true, reason || 'Manually triggered.');
  logger.warn('emergency-stop', `Emergency stop ACTIVATED for scope "${scope}"`, { reason }, scope === 'global' ? null : scope);
  sendSuccess(res, state, 'Emergency stop activated.');
}

async function postEmergencyStopReset(req, res) {
  const { scope, confirm } = req.body || {};
  if (!['global', 'demo', 'real'].includes(scope)) {
    return sendError(res, 'VALIDATION_ERROR', 'scope must be "global", "demo", or "real".');
  }
  if (confirm !== true) {
    return sendError(res, 'VALIDATION_ERROR', 'Resetting an emergency stop requires { "confirm": true } in the request body.');
  }
  const state = emergencyStopRepository.setActive(scope, req.user.id, false, null);
  logger.warn('emergency-stop', `Emergency stop RESET for scope "${scope}"`, {}, scope === 'global' ? null : scope);
  sendSuccess(res, state, 'Emergency stop reset.');
}

module.exports = { getRiskSettings, putRiskSettings, postEmergencyStop, postEmergencyStopReset };
