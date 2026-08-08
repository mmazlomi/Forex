'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/market-controller');

const router = express.Router();

router.get('/market-data', asyncHandler(controller.getMarketData));
router.get('/candles', asyncHandler(controller.getCandles));
router.get('/indicators', asyncHandler(controller.getIndicators));
router.get('/indicator-series', asyncHandler(controller.getIndicatorSeries));
router.get('/fundamentals', asyncHandler(controller.getFundamentals));

module.exports = router;
