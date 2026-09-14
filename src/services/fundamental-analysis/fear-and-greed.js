'use strict';

const logger = require('../logging/logger');

class FearAndGreedService {
  constructor() {
    this.cacheTtlMs = 30 * 60 * 1000; // 30 minutes
    this.cachedData = null;
    this.cachedAt = 0;
  }

  /**
   * Fetches the current Crypto Fear & Greed Index from Alternative.me.
   * Caches results in memory for 30 minutes.
   *
   * @returns {Promise<{
   *   value: number,
   *   classification: string,
   *   timestamp: string,
   *   isCached: boolean
   * }>}
   */
  async getFearAndGreed() {
    const now = Date.now();
    if (this.cachedData && now - this.cachedAt < this.cacheTtlMs) {
      return { ...this.cachedData, isCached: true };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const response = await fetch('https://api.alternative.me/fng/?limit=1', {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      const item = json?.data?.[0];

      if (!item) {
        throw new Error('Empty response payload from Fear & Greed API');
      }

      const value = Number(item.value);
      const classification = item.value_classification; // e.g. "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"
      const timestamp = new Date(Number(item.timestamp) * 1000).toISOString();

      this.cachedData = {
        value,
        classification,
        timestamp,
      };
      this.cachedAt = now;

      logger.info('fundamentals', `Fetched Fear & Greed Index: ${value} (${classification})`);
      return { ...this.cachedData, isCached: false };
    } catch (err) {
      logger.warn('fundamentals', `Failed to fetch Fear & Greed Index: ${err.message}. Using fallback.`);
      if (this.cachedData) {
        return { ...this.cachedData, isCached: true, isStale: true };
      }
      // Safe neutral fallback
      return {
        value: 50,
        classification: 'Neutral',
        timestamp: new Date().toISOString(),
        isCached: false,
        isFallback: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Calculates a sentiment score multiplier from -1 (Extreme Fear) to +1 (Extreme Greed).
   * Useful for scoring or risk adjustments.
   * Value 50 -> 0.
   * Value 10 -> -0.8.
   * Value 90 -> +0.8.
   */
  getSentimentScore(value) {
    const num = typeof value === 'number' ? value : Number(value);
    const valid = Number.isFinite(num) ? num : 50;
    const clamped = Math.max(0, Math.min(100, valid));
    return (clamped - 50) / 50;
  }
}

module.exports = new FearAndGreedService();
