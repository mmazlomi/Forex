'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/watchlist-controller');

const router = express.Router();

router.get('/', asyncHandler(controller.listWatchlist));
router.post('/', asyncHandler(controller.addToWatchlist));
router.delete('/:symbol', asyncHandler(controller.removeFromWatchlist));
router.post('/:symbol/promote', asyncHandler(controller.promoteToSignalsSetting));

module.exports = router;
