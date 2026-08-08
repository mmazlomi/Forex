'use strict';

const marketDataService = require('../services/market-data/market-data-service');
const { computeAllIndicators, computeIndicatorSeries } = require('../services/technical-analysis');
const fundamentalAnalysis = require('../services/fundamental-analysis');
const { sendSuccess, sendError } = require('../utils/http-response');

function requireSymbolExchange(req, res) {
  const { symbol, exchange } = req.query;
  if (!symbol || !exchange) {
    sendError(res, 'VALIDATION_ERROR', 'symbol and exchange query parameters are required.');
    return null;
  }
  return { symbol, exchange };
}

async function getMarketData(req, res) {
  const params = requireSymbolExchange(req, res);
  if (!params) return;
  const snapshot = await marketDataService.getSnapshot(params);
  sendSuccess(res, snapshot);
}

// Not in the original 20-endpoint spec list, but the UI spec (§8) requires a price chart, and
// charting needs raw OHLCV series that no other endpoint exposes — added as a minimal addition.
async function getCandles(req, res) {
  const params = requireSymbolExchange(req, res);
  if (!params) return;
  const timeframe = req.query.timeframe || '1h';
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const candles = await marketDataService.getCandles({ ...params, timeframe, limit });
  sendSuccess(res, candles);
}

async function getIndicators(req, res) {
  const params = requireSymbolExchange(req, res);
  if (!params) return;
  const timeframe = req.query.timeframe || '1h';
  const candles = await marketDataService.getCandles({ ...params, timeframe, limit: 200 });
  if (candles.length === 0) {
    return sendSuccess(res, { symbol: params.symbol, exchange: params.exchange, timeframe, indicators: null, dataQuality: 'insufficient' });
  }
  const camelCandles = candles.map((c) => ({ tsUtc: c.ts_utc, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  sendSuccess(res, { symbol: params.symbol, exchange: params.exchange, timeframe, indicators: computeAllIndicators(camelCandles) });
}

// Addition beyond the original spec, alongside /api/candles — the "full trading chart" needs
// historical indicator series to draw as overlays, not just the latest value /api/indicators
// returns for the TA panel.
async function getIndicatorSeries(req, res) {
  const params = requireSymbolExchange(req, res);
  if (!params) return;
  const timeframe = req.query.timeframe || '1h';
  const candles = await marketDataService.getCandles({ ...params, timeframe, limit: 200 });
  if (candles.length === 0) {
    return sendSuccess(res, { symbol: params.symbol, exchange: params.exchange, timeframe, series: null });
  }
  const camelCandles = candles.map((c) => ({ tsUtc: c.ts_utc, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  sendSuccess(res, { symbol: params.symbol, exchange: params.exchange, timeframe, series: computeIndicatorSeries(camelCandles) });
}

async function getFundamentals(req, res) {
  const { symbol, assetType, providerId } = req.query;
  if (!symbol || !assetType) {
    return sendError(res, 'VALIDATION_ERROR', 'symbol and assetType query parameters are required.');
  }
  if (!['crypto', 'stock'].includes(assetType)) {
    return sendError(res, 'VALIDATION_ERROR', 'assetType must be "crypto" or "stock".');
  }
  const fundamentals = await fundamentalAnalysis.getFundamentals({ symbol, assetType, providerId });
  sendSuccess(res, fundamentals);
}

module.exports = { getMarketData, getCandles, getIndicators, getIndicatorSeries, getFundamentals };
