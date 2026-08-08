'use strict';

const { getDb } = require('../connection');

function getRiskSettings(userId, mode) {
  const db = getDb();
  return db.prepare('SELECT * FROM futures_risk_settings WHERE user_id = ? AND mode = ?').get(userId, mode);
}

function upsertRiskSettings(userId, mode, settings) {
  const db = getDb();
  const updatedAtUtc = new Date().toISOString();
  db.prepare(
    `INSERT INTO futures_risk_settings (
       user_id, mode, max_risk_per_trade_percent, max_daily_loss_percent, max_open_positions,
       max_order_value, min_risk_reward_ratio, max_portfolio_exposure_percent, max_leverage, updated_at_utc
     ) VALUES (
       @userId, @mode, @maxRiskPerTradePercent, @maxDailyLossPercent, @maxOpenPositions,
       @maxOrderValue, @minRiskRewardRatio, @maxPortfolioExposurePercent, @maxLeverage, @updatedAtUtc
     )
     ON CONFLICT(user_id, mode) DO UPDATE SET
       max_risk_per_trade_percent = excluded.max_risk_per_trade_percent,
       max_daily_loss_percent = excluded.max_daily_loss_percent,
       max_open_positions = excluded.max_open_positions,
       max_order_value = excluded.max_order_value,
       min_risk_reward_ratio = excluded.min_risk_reward_ratio,
       max_portfolio_exposure_percent = excluded.max_portfolio_exposure_percent,
       max_leverage = excluded.max_leverage,
       updated_at_utc = excluded.updated_at_utc`
  ).run({ userId, mode, updatedAtUtc, ...settings });
  return getRiskSettings(userId, mode);
}

function ensureDefaults(userId, mode, defaults) {
  const existing = getRiskSettings(userId, mode);
  if (existing) return existing;
  return upsertRiskSettings(userId, mode, defaults);
}

module.exports = { getRiskSettings, upsertRiskSettings, ensureDefaults };
