'use strict';

const config = require('../../../config/config');
const logger = require('../logging/logger');

class TelegramNotifier {
  constructor() {
    this.botToken = config.telegramBotToken;
    this.chatId = config.telegramChatId;
    this.enabled = config.telegramNotificationsEnabled;
  }

  isEnabled() {
    return Boolean(this.enabled && this.botToken && this.chatId);
  }

  /**
   * Sends a message to the configured Telegram chat.
   * Never throws — errors are caught and logged so notification failures
   * never interrupt order execution or trading pipelines.
   *
   * @param {string} text - HTML-formatted message text
   * @param {object} [options] - Overrides for token, chatId, or parseMode
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async sendMessage(text, options = {}) {
    const token = options.botToken || this.botToken;
    const chatId = options.chatId || this.chatId;

    if (!token || !chatId) {
      return { success: false, error: 'Telegram botToken or chatId is not configured.' };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || 'HTML',
      disable_web_page_preview: true,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        const errorMsg = data?.description || `HTTP ${response.status}`;
        logger.warn('telegram', `Failed to send Telegram notification: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      return { success: true };
    } catch (err) {
      const isAbort = err.name === 'AbortError';
      const msg = isAbort ? 'Request timed out after 8000ms' : err.message;
      logger.warn('telegram', `Telegram notification error: ${msg}`);
      return { success: false, error: msg };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Helper to format numbers cleanly.
   */
  _fmt(num, digits = 2) {
    if (num === null || num === undefined || Number.isNaN(Number(num))) return '-';
    return Number(num).toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    });
  }

  /**
   * Notify when an order is placed.
   */
  async notifyOrderPlaced({ mode = 'demo', market = 'spot', symbol, side, orderType, price, qty, leverage = 1 }) {
    if (!this.isEnabled()) return;
    const isReal = mode.toLowerCase() === 'real';
    const modeBadge = isReal ? '🚨 <b>REAL MONEY</b>' : '🧪 <b>DEMO</b>';
    const sideEmoji = side.toLowerCase() === 'buy' || side.toLowerCase() === 'long' ? '🟢' : '🔴';
    const levText = market === 'futures' && leverage > 1 ? ` (${leverage}x)` : '';

    const text = [
      `${sideEmoji} <b>Order Placed: ${side.toUpperCase()} ${symbol}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `• <b>Mode:</b> ${modeBadge}`,
      `• <b>Market:</b> ${market.toUpperCase()}${levText}`,
      `• <b>Type:</b> ${orderType.toUpperCase()}`,
      `• <b>Price:</b> $${this._fmt(price, 4)}`,
      `• <b>Amount:</b> ${qty} ${symbol.split('/')[0]}`,
      `• <b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    ].join('\n');

    return this.sendMessage(text);
  }

  /**
   * Notify when a position is closed.
   */
  async notifyPositionClosed({ mode = 'demo', market = 'spot', symbol, side, entryPrice, exitPrice, realizedPnl, exitReason }) {
    if (!this.isEnabled()) return;
    const pnlNum = Number(realizedPnl || 0);
    const isProfit = pnlNum >= 0;
    const emoji = isProfit ? '🎉 ✅' : '🛑 ⚠️';
    const isReal = mode.toLowerCase() === 'real';
    const modeBadge = isReal ? '<b>REAL</b>' : '<b>DEMO</b>';
    const sign = isProfit ? '+' : '';

    const text = [
      `${emoji} <b>Position Closed: ${symbol}</b> [${modeBadge}]`,
      `━━━━━━━━━━━━━━━━━━`,
      `• <b>Side:</b> ${side.toUpperCase()} (${market.toUpperCase()})`,
      `• <b>Entry:</b> $${this._fmt(entryPrice, 4)}`,
      `• <b>Exit:</b> $${this._fmt(exitPrice, 4)}`,
      `• <b>Realized P&L:</b> <b>${sign}$${this._fmt(pnlNum, 2)}</b>`,
      `• <b>Reason:</b> ${exitReason || 'Manual / Exit signal'}`,
      `• <b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    ].join('\n');

    return this.sendMessage(text);
  }

  /**
   * Notify when Take-Profit is hit.
   */
  async notifyTakeProfit({ mode = 'demo', market = 'spot', symbol, stage = 'Full', price, realizedPnl }) {
    if (!this.isEnabled()) return;
    const pnlNum = Number(realizedPnl || 0);
    const text = [
      `🎯 <b>Take-Profit Hit: ${symbol}</b> [${stage}]`,
      `━━━━━━━━━━━━━━━━━━`,
      `• <b>Mode:</b> ${mode.toUpperCase()} (${market.toUpperCase()})`,
      `• <b>Trigger Price:</b> $${this._fmt(price, 4)}`,
      `• <b>P&L Secured:</b> +$${this._fmt(pnlNum, 2)}`,
      `• <b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    ].join('\n');

    return this.sendMessage(text);
  }

  /**
   * Notify when Stop-Loss is hit.
   */
  async notifyStopLoss({ mode = 'demo', market = 'spot', symbol, price, realizedPnl }) {
    if (!this.isEnabled()) return;
    const pnlNum = Number(realizedPnl || 0);
    const text = [
      `🛑 <b>Stop-Loss Triggered: ${symbol}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `• <b>Mode:</b> ${mode.toUpperCase()} (${market.toUpperCase()})`,
      `• <b>Exit Price:</b> $${this._fmt(price, 4)}`,
      `• <b>Loss:</b> -$${this._fmt(Math.abs(pnlNum), 2)}`,
      `• <b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    ].join('\n');

    return this.sendMessage(text);
  }

  /**
   * Notify when Emergency Stop is tripped.
   */
  async notifyEmergencyStop({ scope, action, username }) {
    if (!this.isEnabled()) return;
    const isStop = action === 'stop';
    const icon = isStop ? '🚨 🔴' : '🔄 🟢';
    const actionText = isStop ? 'TRADING HALTED (EMERGENCY STOP)' : 'EMERGENCY STOP RESET';

    const text = [
      `${icon} <b>${actionText}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `• <b>Scope:</b> ${scope.toUpperCase()}`,
      `• <b>Triggered By:</b> ${username || 'System / Admin'}`,
      `• <b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    ].join('\n');

    return this.sendMessage(text);
  }

  /**
   * Notify when Stoploss Guard / Cooldown Protection triggers.
   */
  async notifyCooldownProtection({ symbol, mode, triggerCount, cooldownMinutes, untilUtc }) {
    if (!this.isEnabled()) return;
    const text = [
      `🛡️ <b>Protection Triggered: COOLDOWN ACTIVE</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `• <b>Symbol:</b> ${symbol} [${mode.toUpperCase()}]`,
      `• <b>Reason:</b> ${triggerCount} consecutive stop-losses hit in lookback window`,
      `• <b>Cooldown Duration:</b> ${cooldownMinutes} minutes`,
      `• <b>Resume Trading At:</b> ${untilUtc} UTC`,
      `• <i>New trades for this asset are temporarily halted to protect capital.</i>`,
    ].join('\n');

    return this.sendMessage(text);
  }
}

module.exports = new TelegramNotifier();
