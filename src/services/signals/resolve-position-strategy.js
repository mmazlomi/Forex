'use strict';

const signalsRepository = require('../../database/repositories/signals-repository');

/**
 * Looks up the signal (if any) that triggered a trade and extracts the strategy fields to persist
 * directly on the resulting position — so "which strategy opened this position" is answerable from
 * the position row itself, no join to signals needed at read time. Resolved server-side from the
 * trusted signalId already in scope at order-fill time, never from client input. Returns all-null
 * strategy fields for a manual order placed without "Trade from Signal" (no signalId) or a
 * signalId that doesn't resolve to a stored signal.
 */
function resolvePositionStrategy(signalId) {
  const signal = signalId ? signalsRepository.getSignal(signalId) : null;
  return {
    strategyId: signal ? signal.strategy_id : null,
    combinedStrategyIdsJson: signal ? signal.combined_strategy_ids_json : null,
    combinedVotesJson: signal ? signal.combined_votes_json : null,
    // Which candle timeframe the signal was generated on (e.g. '1h') — the "timeframe that led
    // to the signal" for the Open Positions display. Null alongside the strategy fields above
    // when there's no signal to look up.
    timeframe: signal ? signal.timeframe : null,
  };
}

module.exports = { resolvePositionStrategy };
