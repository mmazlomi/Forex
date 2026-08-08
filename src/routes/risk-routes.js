'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const { requireValidMode } = require('../middleware/validate-mode');
const controller = require('../controllers/risk-controller');

const riskSettingsRouter = express.Router();
riskSettingsRouter.get('/', requireValidMode, asyncHandler(controller.getRiskSettings));
riskSettingsRouter.put('/', requireValidMode, asyncHandler(controller.putRiskSettings));

const emergencyStopRouter = express.Router();
emergencyStopRouter.post('/', asyncHandler(controller.postEmergencyStop));
emergencyStopRouter.post('/reset', asyncHandler(controller.postEmergencyStopReset));

module.exports = { riskSettingsRouter, emergencyStopRouter };
