'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const telegramNotifier = require('../../src/services/notifications/telegram-notifier');

test('telegramNotifier: isEnabled returns boolean and does not crash when unconfigured', () => {
  assert.equal(typeof telegramNotifier.isEnabled(), 'boolean');
});

test('telegramNotifier: sendMessage fails gracefully without token or chatId', async () => {
  const result = await telegramNotifier.sendMessage('Test message', { botToken: '', chatId: '' });
  assert.equal(result.success, false);
  assert.match(result.error, /not configured/i);
});

test('telegramNotifier: helper methods do not throw even when disabled', async () => {
  await assert.doesNotReject(async () => {
    await telegramNotifier.notifyOrderPlaced({
      mode: 'demo',
      market: 'spot',
      symbol: 'BTC/USDT',
      side: 'buy',
      orderType: 'market',
      price: 50000,
      qty: 0.1,
    });

    await telegramNotifier.notifyPositionClosed({
      mode: 'demo',
      market: 'spot',
      symbol: 'BTC/USDT',
      side: 'sell',
      entryPrice: 50000,
      exitPrice: 52000,
      realizedPnl: 200,
      exitReason: 'Take-Profit',
    });

    await telegramNotifier.notifyTakeProfit({
      mode: 'demo',
      symbol: 'BTC/USDT',
      stage: 'TP1',
      price: 52000,
      realizedPnl: 100,
    });

    await telegramNotifier.notifyStopLoss({
      mode: 'demo',
      symbol: 'BTC/USDT',
      price: 48000,
      realizedPnl: -200,
    });

    await telegramNotifier.notifyEmergencyStop({
      scope: 'global',
      action: 'stop',
      username: 'admin',
    });

    await telegramNotifier.notifyCooldownProtection({
      symbol: 'BTC/USDT',
      mode: 'demo',
      triggerCount: 2,
      cooldownMinutes: 120,
      untilUtc: '2026-09-13 12:00:00',
    });
  });
});
