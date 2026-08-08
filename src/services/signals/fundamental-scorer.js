'use strict';

const HEALTH_SCORE = { healthy: 0.6, neutral: 0, weak: -0.6 };

/**
 * Converts a normalized fundamentals record (src/services/fundamental-analysis) into a
 * signed fundamentalScore in [-1, +1]. Returns fundamentalScore: null when the health
 * status itself is "unavailable" — that null is what forces NO_DATA upstream when the
 * fundamental weight is > 0, per the "never fabricate" rule.
 */
function computeFundamentalScore(fundamentals) {
  const health = fundamentals?.fields?.healthStatus;
  if (!health || health.value === 'unavailable') {
    return {
      fundamentalScore: null,
      reasons: [],
      summary: { healthStatus: 'unavailable', reason: health?.unavailableReason || 'no_fundamental_data' },
    };
  }

  const fundamentalScore = HEALTH_SCORE[health.value] ?? 0;
  const reason =
    health.basis === 'revenue_growth_ttm_yoy'
      ? `Revenue growth (TTM YoY) ${health.revenueGrowthTTMYoy?.toFixed?.(2) ?? health.revenueGrowthTTMYoy}% → ${health.value}`
      : `24h price change ${health.changePercent24h?.toFixed?.(2) ?? health.changePercent24h}% → market health ${health.value}`;

  return {
    fundamentalScore,
    reasons: [reason],
    summary: { healthStatus: health.value, basis: health.basis },
  };
}

module.exports = { computeFundamentalScore };
