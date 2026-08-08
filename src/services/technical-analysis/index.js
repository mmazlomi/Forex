'use strict';

const sma = require('./sma');
const ema = require('./ema');
const rsi = require('./rsi');
const macd = require('./macd');
const bollingerBands = require('./bollinger-bands');
const atr = require('./atr');
const stochastic = require('./stochastic');
const adx = require('./adx');
const ichimoku = require('./ichimoku');
const supportResistance = require('./support-resistance');
const volumeAnalysis = require('./volume-analysis');
const { computeIndicatorSeries } = require('./series');

/**
 * Computes every indicator against the given candle series (oldest-first). Each indicator
 * independently validates it has enough history and reports its own status — a missing
 * MACD (needs 35 candles) never blocks RSI (needs 15) from returning a value.
 */
function computeAllIndicators(candles, params = {}) {
  return {
    sma: sma.compute(candles, params.sma),
    ema: ema.compute(candles, params.ema),
    rsi: rsi.compute(candles, params.rsi),
    macd: macd.compute(candles, params.macd),
    bollingerBands: bollingerBands.compute(candles, params.bollingerBands),
    atr: atr.compute(candles, params.atr),
    stochastic: stochastic.compute(candles, params.stochastic),
    adx: adx.compute(candles, params.adx),
    ichimoku: ichimoku.compute(candles, params.ichimoku),
    supportResistance: supportResistance.compute(candles, params.supportResistance),
    volumeAnalysis: volumeAnalysis.compute(candles, params.volumeAnalysis),
  };
}

module.exports = {
  computeAllIndicators,
  computeIndicatorSeries,
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  stochastic,
  adx,
  ichimoku,
  supportResistance,
  volumeAnalysis,
};
