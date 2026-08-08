'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/real-credentials-controller');

const router = express.Router();

router.get('/', asyncHandler(controller.getStatus));
router.put('/', asyncHandler(controller.setCredentials));
router.delete('/', asyncHandler(controller.clearCredentials));

module.exports = router;
