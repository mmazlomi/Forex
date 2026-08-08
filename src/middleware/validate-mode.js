'use strict';

const { sendError } = require('../utils/http-response');

/** Requires ?mode=demo|real (or req.body.mode), rejecting anything else before it reaches a controller. */
function requireValidMode(req, res, next) {
  const mode = req.query.mode || req.body?.mode;
  if (mode !== 'demo' && mode !== 'real') {
    return sendError(res, 'INVALID_MODE', 'A "mode" of "demo" or "real" is required.', 400);
  }
  req.tradingMode = mode;
  next();
}

module.exports = { requireValidMode };
