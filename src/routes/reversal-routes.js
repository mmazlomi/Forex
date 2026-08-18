'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/reversal-controller');

const router = express.Router();

router.get('/status', asyncHandler(controller.getStatus));

module.exports = router;
