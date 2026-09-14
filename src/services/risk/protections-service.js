'use strict';

const logger = require('../logging/logger');
const telegramNotifier = require('../notifications/telegram-notifier');

class ProtectionsService {
  constructor(options = {}) {
    // Configurable thresholds (Freqtrade-style StoplossGuard)
    this.stoplossGuardCount = options.stoplossGuardCount || 2; // 2 stop-outs
    this.stoplossGuardWindowMs = options.stoplossGuardWindowMs || 60 * 60 * 1000; // within 1 hour
    this.cooldownDurationMs = options.cooldownDurationMs || 2 * 60 * 60 * 1000; // 2 hour cooldown

    // State maps: key is `${mode}:${symbol}` (e.g. "demo:BTC/USDT")
    this.stopLossEvents = new Map();
    this.activeCooldowns = new Map();
  }

  _makeKey(symbol, mode = 'demo') {
    return `${mode.toLowerCase()}:${symbol.toUpperCase()}`;
  }

  /**
   * Records a stop-loss event for a symbol.
   * If the number of stop-losses in the lookback window hits or exceeds
   * `stoplossGuardCount`, a cooldown period is automatically activated.
   */
  recordStopLoss(symbol, mode = 'demo') {
    const key = this._makeKey(symbol, mode);
    const now = Date.now();

    // 1. Append timestamp and purge old events outside the window
    const windowStart = now - this.stoplossGuardWindowMs;
    const history = (this.stopLossEvents.get(key) || []).filter((ts) => ts >= windowStart);
    history.push(now);
    this.stopLossEvents.set(key, history);

    logger.info('protections', `Stop-loss recorded for ${symbol} (${mode}). Recent count: ${history.length}/${this.stoplossGuardCount}`);

    // 2. Check if threshold reached
    if (history.length >= this.stoplossGuardCount) {
      const untilTs = now + this.cooldownDurationMs;
      const untilUtc = new Date(untilTs).toISOString();
      const cooldownMinutes = Math.round(this.cooldownDurationMs / (60 * 1000));

      this.activeCooldowns.set(key, {
        symbol: symbol.toUpperCase(),
        mode: mode.toLowerCase(),
        untilTs,
        untilUtc,
        triggerCount: history.length,
        activatedAtUtc: new Date(now).toISOString(),
      });

      // Clear the event history so it starts fresh after cooldown
      this.stopLossEvents.delete(key);

      logger.warn(
        'protections',
        `🛑 COOLDOWN ACTIVATED for ${symbol} (${mode}): ${history.length} stop-outs in window. Trading paused until ${untilUtc}`
      );

      // Send Telegram notification if configured
      telegramNotifier.notifyCooldownProtection({
        symbol,
        mode,
        triggerCount: history.length,
        cooldownMinutes,
        untilUtc: untilUtc.replace('T', ' ').slice(0, 19),
      });

      return {
        cooldownActivated: true,
        untilUtc,
        cooldownMinutes,
        triggerCount: history.length,
      };
    }

    return { cooldownActivated: false, recentCount: history.length };
  }

  /**
   * Records an emergency structural reversal exit for an asset.
   * Activates a temporary cooldown (default: 15 minutes) to prevent auto-traders
   * from immediately re-entering a broken setup, and tracks against stoploss guard.
   */
  recordReversalExit(symbol, mode = 'demo', durationMinutes = 15) {
    const key = this._makeKey(symbol, mode);
    const now = Date.now();
    const untilTs = now + durationMinutes * 60 * 1000;
    const untilUtc = new Date(untilTs).toISOString();

    const existing = this.activeCooldowns.get(key);
    if (!existing || existing.untilTs < untilTs) {
      this.activeCooldowns.set(key, {
        symbol: symbol.toUpperCase(),
        mode: mode.toLowerCase(),
        untilTs,
        untilUtc,
        reason: 'reversal_break',
        triggerCount: (existing?.triggerCount || 0) + 1,
        activatedAtUtc: new Date(now).toISOString(),
      });

      logger.warn(
        'protections',
        `🛑 REVERSAL COOLDOWN ACTIVATED for ${symbol} (${mode}): trading paused for ${durationMinutes}m until ${untilUtc}`
      );
    }

    return this.recordStopLoss(symbol, mode);
  }

  /**
   * Checks if an asset is currently in a cooldown period.
   * Purges expired cooldowns lazily.
   */
  isCooldownActive(symbol, mode = 'demo') {
    const key = this._makeKey(symbol, mode);
    const cooldown = this.activeCooldowns.get(key);
    if (!cooldown) return { active: false };

    const now = Date.now();
    if (now >= cooldown.untilTs) {
      this.activeCooldowns.delete(key);
      logger.info('protections', `Cooldown expired for ${symbol} (${mode}). Trading resumed.`);
      return { active: false };
    }

    const remainingMinutes = Math.ceil((cooldown.untilTs - now) / (60 * 1000));
    return {
      active: true,
      untilUtc: cooldown.untilUtc,
      remainingMinutes,
      triggerCount: cooldown.triggerCount,
    };
  }

  /**
   * Resets cooldown manually for a symbol.
   */
  resetCooldown(symbol, mode = 'demo') {
    const key = this._makeKey(symbol, mode);
    const existed = this.activeCooldowns.delete(key);
    this.stopLossEvents.delete(key);
    if (existed) {
      logger.info('protections', `Cooldown manually reset for ${symbol} (${mode})`);
    }
    return { reset: existed };
  }

  /**
   * Resets all active cooldowns.
   */
  resetAllCooldowns() {
    this.activeCooldowns.clear();
    this.stopLossEvents.clear();
    logger.info('protections', 'All cooldowns and stop-loss counters reset.');
  }

  /**
   * Returns list of all currently active cooldowns.
   */
  getAllActiveCooldowns() {
    const now = Date.now();
    const list = [];
    for (const [key, cooldown] of this.activeCooldowns.entries()) {
      if (now >= cooldown.untilTs) {
        this.activeCooldowns.delete(key);
      } else {
        const remainingMinutes = Math.ceil((cooldown.untilTs - now) / (60 * 1000));
        list.push({ ...cooldown, remainingMinutes });
      }
    }
    return list;
  }
}

module.exports = new ProtectionsService();
