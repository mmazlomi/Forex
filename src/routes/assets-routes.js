'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/assets-controller');

const router = express.Router();

router.get('/', asyncHandler(controller.listAssets));
router.post('/', asyncHandler(controller.addAsset));
router.delete('/:symbol', asyncHandler(controller.removeAsset));
router.put('/:symbol/auto-trade', asyncHandler(controller.setAutoTrade));
router.put('/:symbol/real-auto-trade', asyncHandler(controller.setRealAutoTrade));
router.put('/:symbol/strategy', asyncHandler(controller.setStrategy));
router.put('/:symbol/timeframe', asyncHandler(controller.setTimeframe));
router.put('/:symbol/exchange', asyncHandler(controller.setExchange));
router.put('/:symbol/strategy-mode', asyncHandler(controller.setStrategyMode));
router.put('/:symbol/trailing', asyncHandler(controller.setTrailingPercent));

module.exports = router;
