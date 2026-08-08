'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const controller = require('../controllers/system-controller');

const logsRouter = express.Router();
logsRouter.get('/', asyncHandler(controller.getLogs));

const systemStatusRouter = express.Router();
systemStatusRouter.get('/', asyncHandler(controller.getSystemStatus));

module.exports = { logsRouter, systemStatusRouter };
