'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async-handler');
const { createRateLimiter } = require('../middleware/rate-limiter');
const controller = require('../controllers/auth-controller');

const router = express.Router();

// Stricter than the general API limiter — deters password-guessing/account-creation spam
// without needing an external dependency (see rate-limiter.js).
const loginLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
const signupLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 });

router.post('/signup', signupLimiter, asyncHandler(controller.signup));
router.post('/login', loginLimiter, asyncHandler(controller.login));
router.post('/logout', asyncHandler(controller.logout));
router.get('/me', asyncHandler(controller.me));

module.exports = router;
