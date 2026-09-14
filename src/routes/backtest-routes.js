'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/backtest-controller');

const router = express.Router();

router.post('/', asyncHandler(controller.postBacktest));
router.post('/optimize', asyncHandler(controller.postOptimize));
router.get('/autopilot/matrix', asyncHandler(controller.getAutoPilotMatrix));
router.post('/autopilot/evaluate', asyncHandler(controller.postAutoPilotEvaluate));
router.post('/autopilot/evaluate-asset', asyncHandler(controller.postEvaluateAsset));
router.get('/', asyncHandler(controller.listBacktests));
router.get('/:runId', asyncHandler(controller.getBacktest));

module.exports = router;
