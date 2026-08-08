'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/exchanges-controller');

const router = express.Router();

router.get('/', asyncHandler(controller.listExchanges));
router.get('/symbols', asyncHandler(controller.listSymbols));

module.exports = router;
