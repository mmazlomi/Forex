'use strict';

const ordersRepository = require('../database/repositories/orders-repository');
const { placeDemoOrder, cancelDemoOrder } = require('../services/orders/demo-orders');
const { placeRealOrder, cancelRealOrder } = require('../services/orders/real-orders');
const { sendSuccess, sendError, sendRejection } = require('../utils/http-response');

const REQUIRED_CONFIRMATION_TEXT = 'CONFIRM';

async function listOrders(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const { status } = req.query;
  sendSuccess(res, ordersRepository.listOrders(req.tradingMode, req.user.id, { limit, offset, status }));
}

function validateOrderBody(body) {
  const { symbol, exchange, side } = body || {};
  if (!symbol || !exchange || !side || !['buy', 'sell'].includes(side.toLowerCase())) {
    return 'symbol, exchange, and side ("buy" or "sell") are required.';
  }
  return null;
}

// OCO returns {takeProfitOrder, stopLossOrder} instead of a single order — a deliberate,
// documented shape difference (see placeDemoOcoExit/placeRealOcoExit) since it genuinely creates
// two linked orders. Treated as "rejected" for the HTTP status/response-shape only if the first
// (take-profit) leg was rejected — if that leg succeeded, the whole thing is a success even if a
// caller wants to inspect both legs' individual status in the response body. The success message
// is derived from the actual result shape/status here (not precomputed by the caller from a
// `.status` field that doesn't exist on the two-order OCO shape) so it can't say "filled" for an
// OCO placement, which only ever creates two *pending* orders.
function sendOrderOrOcoResult(res, result, label) {
  if (result.takeProfitOrder !== undefined) {
    if (result.takeProfitOrder.status === 'rejected') return sendRejection(res, result.takeProfitOrder);
    return sendSuccess(res, result, `${label} OCO placed (both legs pending).`, 201);
  }
  if (result.status === 'rejected') return sendRejection(res, result);
  sendSuccess(res, result, result.status === 'pending' ? `${label} order placed (pending).` : `${label} order filled.`, 201);
}

async function postDemoOrder(req, res) {
  const validationError = validateOrderBody(req.body);
  if (validationError) return sendError(res, 'VALIDATION_ERROR', validationError);

  const { symbol, exchange, side, stopLoss, takeProfit, qty, idempotencyKey, signalId, orderType, limitPrice, triggerPrice } = req.body;
  const order = await placeDemoOrder({ userId: req.user.id, symbol, exchange, side, stopLoss, takeProfit, qty, idempotencyKey, signalId, orderType, limitPrice, triggerPrice });
  sendOrderOrOcoResult(res, order, 'Demo');
}

async function postRealOrder(req, res) {
  const validationError = validateOrderBody(req.body);
  if (validationError) return sendError(res, 'VALIDATION_ERROR', validationError);

  const { symbol, exchange, side, stopLoss, takeProfit, qty, idempotencyKey, signalId, confirmationText, orderType, limitPrice, triggerPrice } = req.body;
  const unlockConfirmed = confirmationText === REQUIRED_CONFIRMATION_TEXT;

  const order = await placeRealOrder({ userId: req.user.id, symbol, exchange, side, stopLoss, takeProfit, qty, idempotencyKey, signalId, unlockConfirmed, orderType, limitPrice, triggerPrice });
  sendOrderOrOcoResult(res, order, 'Real');
}

async function postCancelOrder(req, res) {
  const { mode, id } = req.params;
  const order = ordersRepository.getOrder(mode, req.user.id, id);
  if (!order) return sendError(res, 'ORDER_NOT_FOUND', `No ${mode} order with id ${id}.`);
  if (order.status !== 'pending') return sendError(res, 'ORDER_NOT_CANCELLABLE', `Order ${id} is "${order.status}", not pending — only a pending order can be cancelled.`);

  const cancelled = mode === 'real' ? await cancelRealOrder(order) : cancelDemoOrder(order);
  sendSuccess(res, cancelled, 'Order cancelled.');
}

module.exports = { listOrders, postDemoOrder, postRealOrder, postCancelOrder };
