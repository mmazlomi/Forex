'use strict';

const STATUS_BY_ERROR_CODE = {
  VALIDATION_ERROR: 400,
  INVALID_MODE: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  DUPLICATE_ORDER: 409,
  USERNAME_TAKEN: 409,
  ORDER_NOT_CANCELLABLE: 409,
  LIVE_TRADING_DISABLED: 403,
  MISSING_REAL_CREDENTIALS: 403,
  REAL_TRADING_NOT_UNLOCKED: 403,
  EMERGENCY_STOP_ACTIVE: 403,
  NO_OPEN_POSITION_FOR_OCO: 404,
  RISK_CHECK_FAILED: 422,
  STALE_DATA: 422,
  INSUFFICIENT_DATA: 422,
  MISSING_LIMIT_PRICE: 400,
  MISSING_TRIGGER_PRICE: 400,
  INVALID_TRIGGER_LIMIT_RELATIONSHIP: 400,
  INVALID_ORDER_TYPE: 400,
  ORDER_TYPE_UNSUPPORTED_ON_EXCHANGE: 422,
  ORDER_TYPE_UNIMPLEMENTED_FOR_EXCHANGE: 422,
  RATE_LIMITED: 429,
  // Phase 2 (Futures)
  POSITION_ALREADY_OPEN: 409,
  NO_OPEN_POSITION_TO_CLOSE: 404,
  INVALID_LEVERAGE: 400,
  LEVERAGE_TOO_HIGH: 400,
  STOP_LOSS_BEYOND_LIQUIDATION: 400,
  INVALID_ACTION: 400,
  FUTURES_EXCHANGE_UNSUPPORTED: 400,
  EXCHANGE_UNAVAILABLE: 422,
  EXCHANGE_ORDER_FAILED: 422,
  INVALID_PRICE: 422,
};

function sendSuccess(res, data, message, statusCode = 200) {
  res.status(statusCode).json({
    success: true,
    data: data === undefined ? null : data,
    message: message || undefined,
    timestamp: new Date().toISOString(),
  });
}

function sendError(res, errorCode, message, statusCode) {
  res.status(statusCode || STATUS_BY_ERROR_CODE[errorCode] || 400).json({
    success: false,
    data: null,
    message,
    errorCode,
    timestamp: new Date().toISOString(),
  });
}

/** Maps a risk/order rejection reasonCode (from validate-trade.js / order services) to an HTTP error. */
function sendRejection(res, order) {
  const statusCode = STATUS_BY_ERROR_CODE[extractReasonCode(order.reject_reason)] || 422;
  res.status(statusCode).json({
    success: false,
    data: order,
    message: order.reject_reason,
    errorCode: extractReasonCode(order.reject_reason),
    timestamp: new Date().toISOString(),
  });
}

function extractReasonCode(rejectReason) {
  if (!rejectReason) return 'REJECTED';
  return rejectReason.split(':')[0];
}

module.exports = { sendSuccess, sendError, sendRejection };
