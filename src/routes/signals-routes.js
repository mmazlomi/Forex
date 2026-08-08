'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/signals-controller');

const router = express.Router();

router.get('/', asyncHandler(controller.listSignals));
router.post('/analyze', asyncHandler(controller.analyzeSignal));

const strategiesRouter = express.Router();
strategiesRouter.get('/', asyncHandler(controller.getStrategies));

module.exports = { signalsRouter: router, strategiesRouter };
