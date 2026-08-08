'use strict';

const { v4: uuidv4 } = require('uuid');
const marketDataService = require('../market-data/market-data-service');
const { computeAllIndicators } = require('../technical-analysis');
const fundamentalAnalysis = require('../fundamental-analysis');
const emergencyStopRepository = require('../../database/repositories/emergency-stop-repository');
const signalsRepository = require('../../database/repositories/signals-repository');
const logger = require('../logging/logger');
const { computeSignal, DEFAULT_SCORING_CONFIG } = require('./scoring-engine');
const { getStrategy, DEFAULT_STRATEGY_ID } = require('./strategies');

/**
 * Fetches everything a signal needs to be scored — candles, technical indicators, fundamentals —
 * exactly once. Shared by generateSignal() (single strategy) and generateCombinedSignal()
 * (multiple strategies scored against the SAME fetched inputs, so combining 2-3 strategies costs
 * one network round-trip, not 2-3).
 */
async function fetchSignalInputs({ symbol, exchange, timeframe, assetType, providerId, market }) {
  const candles = await marketDataService.getCandles({ symbol, exchange, timeframe, limit: 200, market });

  let indicators = null;
  let fundamentals = null;
  if (candles.length > 0) {
    indicators = computeAllIndicators(candles);
    try {
      fundamentals = await fundamentalAnalysis.getFundamentals({ symbol, assetType, providerId });
    } catch (err) {
      logger.error('signals', `Fundamental fetch failed for ${symbol}: ${err.message}`);
      fundamentals = { fields: { healthStatus: { value: 'unavailable', unavailableReason: 'fetch_failed' } } };
    }
  }
  return { candles, indicators, fundamentals };
}

/**
 * Scores already-fetched inputs against one named strategy (scoringConfig overrides win over the
 * strategy's own defaults, same precedence generateSignal() has always had). Never touches the
 * network/DB — pure given its inputs, so it's cheap to call once per selected strategy.
 */
function scoreWithStrategy({ candles, indicators, fundamentals, strategyId, scoringConfig = {} }) {
  const strategy = getStrategy(strategyId);
  const config = { ...DEFAULT_SCORING_CONFIG, ...strategy, ...scoringConfig };
  return candles.length > 0 && indicators
    ? computeSignal({ candles, indicators, fundamentals, config })
    : {
        price: null, technicalScore: null, fundamentalScore: null, finalScore: null, status: 'NO_DATA',
        confidence: 0, reasons: [], technicalSummary: {}, fundamentalSummary: {}, entry: null, stopLoss: null,
        takeProfit: null, riskRewardRatio: null, dataQuality: 'insufficient', warnings: ['No candle data available.'],
        strategyVersion: config.strategyVersion || '1.0.0', strategyId: strategy.id, strategyName: strategy.name,
      };
}

function suppressIfEmergencyStopped(result, mode, userId) {
  if (!emergencyStopRepository.isActive(mode, userId) || (result.status !== 'BUY' && result.status !== 'SELL')) {
    return result;
  }
  return {
    ...result,
    status: 'NO_DATA',
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskRewardRatio: null,
    warnings: [...result.warnings, 'Emergency stop is active; BUY/SELL signals are suppressed.'],
  };
}

function buildSignalRecord({ symbol, exchange, timeframe, mode, result, combinedStrategyIds, combinedVotes }) {
  return {
    id: uuidv4(),
    symbol,
    exchange,
    timeframe,
    tsUtc: new Date().toISOString(),
    price: result.price,
    technicalScore: result.technicalScore,
    fundamentalScore: result.fundamentalScore,
    finalScore: result.finalScore,
    status: result.status,
    confidence: result.confidence,
    reasonsJson: JSON.stringify(result.reasons),
    technicalSummaryJson: JSON.stringify(result.technicalSummary),
    fundamentalSummaryJson: JSON.stringify(result.fundamentalSummary),
    entry: result.entry,
    stopLoss: result.stopLoss,
    takeProfit: result.takeProfit,
    riskRewardRatio: result.riskRewardRatio,
    dataQuality: result.dataQuality,
    warningsJson: JSON.stringify(result.warnings),
    strategyVersion: result.strategyVersion,
    strategyId: combinedStrategyIds ? combinedStrategyIds.join('+') : result.strategyId,
    sourceMode: mode,
    combinedStrategyIds: combinedStrategyIds ? JSON.stringify(combinedStrategyIds) : null,
    combinedVotes: combinedVotes ? JSON.stringify(combinedVotes) : null,
  };
}

function toApiShape(signal, result) {
  return {
    ...signal,
    strategyName: result.strategyName,
    reasons: result.reasons,
    technicalSummary: result.technicalSummary,
    fundamentalSummary: result.fundamentalSummary,
    warnings: result.warnings,
  };
}

/**
 * Runs the full analysis pipeline for one symbol against one named strategy: fetch candles →
 * compute indicators → fetch fundamentals → score → persist. This is the single-strategy path —
 * used by manual "Generate Signal"/"Generate for Watchlist" always, and by the auto-traders for
 * any asset still in 'manual' strategy_mode (see generateCombinedSignal below for 'auto' mode).
 */
async function generateSignal({
  symbol,
  exchange,
  timeframe = '1h',
  assetType,
  providerId,
  mode = 'demo',
  userId,
  strategyId = DEFAULT_STRATEGY_ID,
  scoringConfig = {},
  market = 'spot',
}) {
  const { candles, indicators, fundamentals } = await fetchSignalInputs({ symbol, exchange, timeframe, assetType, providerId, market });
  let result = scoreWithStrategy({ candles, indicators, fundamentals, strategyId, scoringConfig });
  result = suppressIfEmergencyStopped(result, mode, userId);

  const signal = buildSignalRecord({ symbol, exchange, timeframe, mode, result });
  signalsRepository.insertSignal(signal);
  logger.info('signals', `Signal generated for ${symbol}@${exchange}/${timeframe}: ${signal.status}`, { finalScore: signal.finalScore, dataQuality: signal.dataQuality }, mode);

  return toApiShape(signal, result);
}

/**
 * Majority-vote combination over already-scored per-strategy results (pure — no network/DB — so
 * it's directly unit-testable with synthetic results). A status needs STRICTLY MORE THAN HALF the
 * votes to win; any other split (including a straight tie) resolves to HOLD — this never trades
 * on ambiguity. If every contributing strategy came back NO_DATA (they share the same fetched
 * inputs, so this only happens when there's genuinely no candle data at all), that propagates
 * as-is rather than being reinterpreted as a "no majority" HOLD.
 *
 * The winning side's representative fields (entry/stopLoss/takeProfit/reasons/summaries) come
 * from whichever AGREEING strategy has the highest |finalScore| — the strongest-conviction voter
 * on the winning side — rather than averaging different strategies' ATR-based stops together,
 * which would be harder to reason about and defend. When the result is a manufactured HOLD (no
 * strategy actually voted HOLD — e.g. a straight BUY/SELL split), a null-fields HOLD is
 * synthesized directly rather than borrowing a directional strategy's entry/stop/take, matching
 * the invariant every other HOLD signal already has (see scoring-engine.js).
 */
function combineByMajorityVote(perStrategyResults) {
  const votes = {};
  const statusCounts = { BUY: 0, SELL: 0, HOLD: 0, NO_DATA: 0 };
  for (const { strategyId, result } of perStrategyResults) {
    votes[strategyId] = result.status;
    statusCounts[result.status] += 1;
  }

  const total = perStrategyResults.length;
  if (statusCounts.NO_DATA === total) {
    return { status: 'NO_DATA', representative: perStrategyResults[0].result, votes };
  }

  const majorityThreshold = total / 2;
  let winningStatus = null;
  for (const status of ['BUY', 'SELL', 'HOLD']) {
    if (statusCounts[status] > majorityThreshold) {
      winningStatus = status;
      break;
    }
  }
  if (!winningStatus) winningStatus = 'HOLD'; // no strict majority -> safe default, never trades on ambiguity

  const agreeing = perStrategyResults.filter((r) => r.result.status === winningStatus);
  if (agreeing.length > 0) {
    const best = agreeing.reduce((a, b) => (Math.abs(b.result.finalScore ?? 0) > Math.abs(a.result.finalScore ?? 0) ? b : a));
    return { status: winningStatus, representative: best.result, votes };
  }

  const first = perStrategyResults[0].result;
  return {
    status: 'HOLD',
    representative: {
      price: first.price, technicalScore: null, fundamentalScore: null, finalScore: null,
      confidence: 0, reasons: [], technicalSummary: first.technicalSummary, fundamentalSummary: first.fundamentalSummary,
      entry: null, stopLoss: null, takeProfit: null, riskRewardRatio: null,
      dataQuality: first.dataQuality, warnings: ['Strategies split without a majority; no trade.'],
      strategyVersion: first.strategyVersion, strategyId: null, strategyName: null,
    },
    votes,
  };
}

/**
 * The 'auto' strategy_mode path: scores the SAME fetched inputs against every id in strategyIds
 * (2-3, chosen by strategy-selector.js's periodic backtesting — see its rankStrategiesForAsset),
 * combines them via majority vote, and persists one signal row carrying both the winning
 * representative result AND full per-strategy transparency (combined_strategy_ids_json,
 * combined_votes_json) into how each contributing strategy actually voted.
 */
async function generateCombinedSignal({
  symbol,
  exchange,
  timeframe = '1h',
  assetType,
  providerId,
  mode = 'demo',
  userId,
  strategyIds,
  market = 'spot',
}) {
  if (!Array.isArray(strategyIds) || strategyIds.length < 2) {
    throw new Error('generateCombinedSignal requires at least 2 strategyIds to combine.');
  }

  const { candles, indicators, fundamentals } = await fetchSignalInputs({ symbol, exchange, timeframe, assetType, providerId, market });
  const perStrategyResults = strategyIds.map((strategyId) => ({
    strategyId,
    result: scoreWithStrategy({ candles, indicators, fundamentals, strategyId }),
  }));

  const { status, representative, votes } = combineByMajorityVote(perStrategyResults);
  let result = { ...representative, status };
  result = suppressIfEmergencyStopped(result, mode, userId);

  const signal = buildSignalRecord({ symbol, exchange, timeframe, mode, result, combinedStrategyIds: strategyIds, combinedVotes: votes });
  signalsRepository.insertSignal(signal);
  logger.info(
    'signals',
    `Combined signal generated for ${symbol}@${exchange}/${timeframe}: ${signal.status} (votes: ${JSON.stringify(votes)})`,
    { finalScore: signal.finalScore, dataQuality: signal.dataQuality },
    mode
  );

  return toApiShape(signal, result);
}

module.exports = { generateSignal, generateCombinedSignal, combineByMajorityVote };
