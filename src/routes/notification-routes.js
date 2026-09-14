'use strict';

const express = require('express');
const { sendSuccess, sendError } = require('../utils/http-response');
const telegramNotifier = require('../services/notifications/telegram-notifier');

const router = express.Router();

router.get('/telegram/status', (req, res) => {
  sendSuccess(res, {
    enabled: telegramNotifier.isEnabled(),
    hasToken: Boolean(telegramNotifier.botToken),
    hasChatId: Boolean(telegramNotifier.chatId),
  });
});

router.post('/telegram/test', async (req, res) => {
  const { botToken, chatId } = req.body || {};
  const tokenToUse = botToken || telegramNotifier.botToken;
  const chatIdToUse = chatId || telegramNotifier.chatId;

  if (!tokenToUse || !chatIdToUse) {
    return sendError(res, 'VALIDATION_ERROR', 'Telegram botToken and chatId are required to send a test message.');
  }

  const testMessage = [
    `🤖 <b>Trading Bot — Telegram Integration Test</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `• <b>Status:</b> Connected successfully!`,
    `• <b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    `• <i>You will receive real-time alerts for orders, Take-Profits, Stop-Losses, and emergency events.</i>`,
  ].join('\n');

  const result = await telegramNotifier.sendMessage(testMessage, {
    botToken: tokenToUse,
    chatId: chatIdToUse,
  });

  if (!result.success) {
    return sendError(res, 'EXCHANGE_UNAVAILABLE', result.error || 'Failed to send Telegram test message.');
  }

  sendSuccess(res, { sent: true }, 'Test message sent successfully to Telegram.');
});

module.exports = router;
