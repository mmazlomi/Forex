'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const { requireValidMode } = require('../middleware/validate-mode');
const controller = require('../controllers/portfolio-controller');

const router = express.Router();

router.get('/', requireValidMode, asyncHandler(controller.getPortfolio));
router.get('/history', requireValidMode, asyncHandler(controller.getTradeHistory));
router.post('/real/sync-balance', asyncHandler(controller.syncRealBalance));

module.exports = router;
