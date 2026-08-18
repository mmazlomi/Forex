'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const { requireValidMode } = require('../middleware/validate-mode');
const { createRateLimiter } = require('../middleware/rate-limiter');
const controller = require('../controllers/futures-controller');

const router = express.Router();

// Same stricter limiter as spot order placement — the highest-stakes endpoints in the app.
const orderPlacementLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20 });

router.get('/symbols', asyncHandler(controller.listSymbols));
router.get('/exchanges', asyncHandler(controller.listFuturesExchanges));

router.get('/portfolio', requireValidMode, asyncHandler(controller.getPortfolio));
router.get('/history', requireValidMode, asyncHandler(controller.getTradeHistory));
router.get('/orders', requireValidMode, asyncHandler(controller.listOrders));
router.post('/orders/demo', orderPlacementLimiter, asyncHandler(controller.postDemoOrder));
router.post('/orders/real', orderPlacementLimiter, asyncHandler(controller.postRealOrder));

// Fully independent Demo/Real watchlists — every asset route requires ?mode=demo|real (same
// requireValidMode gate portfolio/orders/risk-settings already use) and reads/writes the
// corresponding demo_futures_assets/real_futures_assets table exclusively.
router.get('/assets', requireValidMode, asyncHandler(controller.listAssets));
router.post('/assets', requireValidMode, asyncHandler(controller.addAsset));
router.delete('/assets/:symbol', requireValidMode, asyncHandler(controller.removeAsset));
router.put('/assets/:symbol/auto-trade', requireValidMode, asyncHandler(controller.setAutoTrade));
router.put('/assets/:symbol/leverage', requireValidMode, asyncHandler(controller.setLeverage));
router.put('/assets/:symbol/exchange', requireValidMode, asyncHandler(controller.setExchange));
router.put('/assets/:symbol/strategy', requireValidMode, asyncHandler(controller.setStrategy));
router.put('/assets/:symbol/timeframe', requireValidMode, asyncHandler(controller.setTimeframe));
router.put('/assets/:symbol/strategy-mode', requireValidMode, asyncHandler(controller.setStrategyMode));
router.put('/assets/:symbol/trailing', requireValidMode, asyncHandler(controller.setTrailingPercent));

router.get('/risk-settings', requireValidMode, asyncHandler(controller.getRiskSettings));
router.put('/risk-settings', requireValidMode, asyncHandler(controller.putRiskSettings));

module.exports = router;
