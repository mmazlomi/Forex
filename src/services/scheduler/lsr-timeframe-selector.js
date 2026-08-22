'use strict';

// Structural twin of strategy-selector.js (same start/stop/runCycle/getStatus shape, same
// .unref()'d setInterval, same per-asset try/catch, same "leave previous selection in place if
// nothing qualifies" convention) — but picks the best htfTimeframe/signalTimeframe/entryTimeframe
// combo for an 'auto'-mode LSR asset instead of the best strategy. Orthogonal to strategy
// selection entirely: an LSR asset never uses strategy_mode/selected_strategy_ids_json, and this
// scheduler never touches those columns. Like strategy-selector.js, this never places an order and
// carries zero trading risk on its own — it only decides which timeframe triple a LATER live LSR
// cycle (live-engine.js#processLiveCycle, called from reversal-auto-trader.js/
// reversal-spot-auto-trader.js) gets configured with.

const assetsRepository = require('../../database/repositories/assets-repository');
const futuresAssetsRepository = require('../../database/repositories/futures-assets-repository');
// Accessed via the namespace object (reversalBacktestEngine.fetchReversalCandles(...) below), not
// destructured — this project's tests mock module functions via t.mock.method(moduleObject, 'fn',
// ...), which only intercepts property access, not a destructured local reference captured at
// require-time (same convention/reasoning as strategy-selector.js's identical comment on optimizer).
const reversalBacktestEngine = require('../backtesting/reversal-backtest-engine');
const { computeExtendedMetrics } = require('../backtesting/reversal-metrics');
const { rankByCompositeScore } = require('../backtesting/composite-score');
const { mergeConfig, validateConfig } = require('../reversal-strategy/config');
const logger = require('../logging/logger');
const config = require('../../../config/config');

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// Candidate htf/signal/entry timeframe triples to evaluate — respects the documented (though not
// code-enforced) htf >= signal >= entry ordering (STRATEGY_SPEC.md §0). Deliberately a small,
// fixed set rather than a full cross-product of every supported timeframe: each candidate costs a
// full 3-timeframe candle fetch + simulation, and an unbounded grid here would be both expensive
// and a genuine overfitting risk — same bounded-grid philosophy as optimizer.js's MAX_COMBINATIONS.
const CANDIDATE_TIMEFRAMES = [
  { htfTimeframe: '4h', signalTimeframe: '15m', entryTimeframe: '5m' }, // current global default
  { htfTimeframe: '1h', signalTimeframe: '15m', entryTimeframe: '5m' },
  { htfTimeframe: '4h', signalTimeframe: '1h', entryTimeframe: '15m' },
  { htfTimeframe: '1d', signalTimeframe: '4h', entryTimeframe: '1h' },
  { htfTimeframe: '1d', signalTimeframe: '4h', entryTimeframe: '15m' },
];

let intervalHandle = null;
let isRunning = false;

/**
 * Backtests every candidate timeframe triple for one asset over the configured rolling lookback,
 * ranks them by composite score (expectancy/profit-factor/drawdown/Sharpe/win-rate/net-P&L — never
 * win rate or net profit alone, see composite-score.js), and returns the winning triple, or null
 * if nothing cleared the minimum-trade-count quality gate. LSR's sweep->divergence->CHOCH->retest
 * sequence is a genuinely rare signal (see docs/reversal-strategy/STRATEGY_SPEC.md), hence the
 * long lookback / low trade-count gate (config.lsrTimeframeSelectionLookbackDays/MinTrades)
 * compared to strategy-selector.js's equivalents for the much higher-frequency weighted strategies.
 */
async function rankTimeframesForAsset({ symbol, exchange, market }) {
  const endMs = Date.now();
  const startMs = endMs - config.lsrTimeframeSelectionLookbackDays * 24 * 60 * 60 * 1000;

  const results = [];
  for (const candidate of CANDIDATE_TIMEFRAMES) {
    const mergedConfig = mergeConfig(candidate);
    const configErrors = validateConfig(mergedConfig);
    if (configErrors.length > 0) continue; // a candidate triple should always be valid; skip defensively rather than crash the cycle

    try {
      const fetched = await reversalBacktestEngine.fetchReversalCandles({ symbol, exchange, startMs, endMs, market, config: mergedConfig });
      const { trades, equityCurve } = reversalBacktestEngine.simulateReversalStrategy({
        ...fetched, symbol, initialCapital: 10000, feePercent: 0.1, slippagePercent: 0.05, config: mergedConfig,
      });
      const periodsPerYear = MS_PER_YEAR / fetched.entryStepMs;
      const metrics = computeExtendedMetrics({ trades, equityCurve, initialCapital: 10000, periodsPerYear });
      results.push({ candidate, metrics });
    } catch (err) {
      logger.debug(
        'lsr-timeframe-selector',
        `Candidate ${candidate.htfTimeframe}/${candidate.signalTimeframe}/${candidate.entryTimeframe} failed for ${symbol}@${exchange}: ${err.message}`
      );
    }
  }

  const ranked = rankByCompositeScore(results, { minTradeCount: config.lsrTimeframeSelectionMinTrades });
  const best = ranked[0];
  if (!best || best.compositeScore === -Infinity) return null;
  return best.candidate;
}

async function processSpotAsset(asset) {
  const label = `${asset.symbol}@${asset.exchange} (spot, user ${asset.user_id})`;
  try {
    const selected = await rankTimeframesForAsset({ symbol: asset.symbol, exchange: asset.exchange, market: 'spot' });
    if (!selected) {
      logger.debug('lsr-timeframe-selector', `Skipped timeframe-selection update for ${label}: no candidate cleared the minimum trade-count gate — leaving previous selection in place.`);
      return;
    }
    assetsRepository.setLsrSelectedTimeframes(asset.user_id, asset.symbol, asset.exchange, selected);
    logger.info('lsr-timeframe-selector', `Selected ${selected.htfTimeframe}/${selected.signalTimeframe}/${selected.entryTimeframe} for ${label}`);
  } catch (err) {
    logger.error('lsr-timeframe-selector', `Selection cycle failed for ${label}: ${err.message}`);
  }
}

async function processFuturesAsset(mode, asset) {
  const label = `${asset.symbol}@${asset.exchange} (futures ${mode}, user ${asset.user_id})`;
  try {
    const selected = await rankTimeframesForAsset({ symbol: asset.symbol, exchange: asset.exchange, market: 'futures' });
    if (!selected) {
      logger.debug('lsr-timeframe-selector', `Skipped timeframe-selection update for ${label}: no candidate cleared the minimum trade-count gate — leaving previous selection in place.`, {}, mode);
      return;
    }
    futuresAssetsRepository.setLsrSelectedTimeframes(mode, asset.user_id, asset.symbol, asset.exchange, selected);
    logger.info('lsr-timeframe-selector', `Selected ${selected.htfTimeframe}/${selected.signalTimeframe}/${selected.entryTimeframe} for ${label}`, {}, mode);
  } catch (err) {
    // KuCoin/CoinEx futures APIs are confirmed flaky/unreachable from some deployment hosts — a
    // failure here (including a timeout) is an accepted, expected outcome, not a bug; the previous
    // selection (or none) simply stays in place until a later cycle succeeds.
    logger.error('lsr-timeframe-selector', `Selection cycle failed for ${label}: ${err.message}`, {}, mode);
  }
}

/** Exported directly so it can be triggered on-demand (e.g. from a test or a manual "run now"). */
async function runCycle() {
  const spotAssets = assetsRepository.listLsrAutoTimeframeModeAssets();
  const demoFuturesAssets = futuresAssetsRepository.listLsrAutoTimeframeModeAssets('demo');
  const realFuturesAssets = futuresAssetsRepository.listLsrAutoTimeframeModeAssets('real');

  const total = spotAssets.length + demoFuturesAssets.length + realFuturesAssets.length;
  if (total > 0) {
    logger.debug('lsr-timeframe-selector', `Running LSR timeframe-selection cycle: ${spotAssets.length} spot, ${demoFuturesAssets.length} demo futures, ${realFuturesAssets.length} real futures asset(s)`);
  }

  for (const asset of spotAssets) await processSpotAsset(asset);
  for (const asset of demoFuturesAssets) await processFuturesAsset('demo', asset);
  for (const asset of realFuturesAssets) await processFuturesAsset('real', asset);

  return { spotEvaluated: spotAssets.length, demoFuturesEvaluated: demoFuturesAssets.length, realFuturesEvaluated: realFuturesAssets.length };
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    // See strategy-selector.js's identical guard: prevents overlapping cycles from piling up when
    // a cycle takes longer than the interval (each asset runs up to 5 real backtests).
    if (isRunning) {
      logger.warn('lsr-timeframe-selector', 'Skipped LSR timeframe-selection cycle: previous cycle is still running');
      return;
    }
    isRunning = true;
    runCycle()
      .catch((err) => logger.error('lsr-timeframe-selector', `LSR timeframe-selection cycle crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  }, config.lsrTimeframeSelectionIntervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  logger.info('lsr-timeframe-selector', `LSR timeframe selector started (interval ${config.lsrTimeframeSelectionIntervalMs}ms, best of ${CANDIDATE_TIMEFRAMES.length} candidates over a ${config.lsrTimeframeSelectionLookbackDays}d rolling lookback)`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function getStatus() {
  return {
    running: intervalHandle !== null,
    intervalMs: config.lsrTimeframeSelectionIntervalMs,
    lookbackDays: config.lsrTimeframeSelectionLookbackDays,
    minTrades: config.lsrTimeframeSelectionMinTrades,
    candidateCount: CANDIDATE_TIMEFRAMES.length,
    spotAutoModeCount: assetsRepository.listLsrAutoTimeframeModeAssets().length,
    demoFuturesAutoModeCount: futuresAssetsRepository.listLsrAutoTimeframeModeAssets('demo').length,
    realFuturesAutoModeCount: futuresAssetsRepository.listLsrAutoTimeframeModeAssets('real').length,
  };
}

module.exports = { start, stop, runCycle, getStatus, rankTimeframesForAsset, CANDIDATE_TIMEFRAMES };
