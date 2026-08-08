'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const { requireValidMode } = require('../middleware/validate-mode');
const { createRateLimiter } = require('../middleware/rate-limiter');
const controller = require('../controllers/orders-controller');

const router = express.Router();

// Stricter than the general API rate limit — order placement is the highest-stakes endpoint.
const orderPlacementLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20 });

router.get('/', requireValidMode, asyncHandler(controller.listOrders));
router.post('/demo', orderPlacementLimiter, asyncHandler(controller.postDemoOrder));
router.post('/real', orderPlacementLimiter, asyncHandler(controller.postRealOrder));
// Cancelling a pending order is also a mutating, exchange-touching (real mode) action —
// shares the placement rate limiter rather than the general API one.
router.post('/:mode(demo|real)/:id/cancel', orderPlacementLimiter, asyncHandler(controller.postCancelOrder));

module.exports = router;
