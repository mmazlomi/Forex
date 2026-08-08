'use strict';

const config = require('../../../../config/config');

const BASE_URL = 'https://finnhub.io/api/v1';

function unavailable(reason) {
  return { value: 'unavailable', source: 'finnhub', unavailableReason: reason };
}

function unavailableAllFields(reason) {
  return {
    revenue: unavailable(reason),
    netIncome: unavailable(reason),
    eps: unavailable(reason),
    peRatio: unavailable(reason),
    debtRatio: unavailable(reason),
    cashFlow: unavailable(reason),
    marketCap: unavailable(reason),
    revenueGrowth: unavailable(reason),
    news: unavailable(reason),
    overallStatus: unavailable(reason),
  };
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Finnhub request failed: HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stock fundamentals via Finnhub. Requires FUNDAMENTAL_API_KEY (a Finnhub API token) — if it's
 * not configured, every field is returned as "unavailable" rather than making a doomed request.
 */
async function fetchStockFundamentals(symbol, { timeoutMs = config.requestTimeoutMs } = {}) {
  const fetchedAtUtc = new Date().toISOString();

  if (!config.fundamentalApiKey) {
    return {
      assetType: 'stock',
      fetchedAtUtc,
      fields: unavailableAllFields('FUNDAMENTAL_API_KEY_not_configured'),
    };
  }

  const token = config.fundamentalApiKey;
  try {
    const [profile, metrics, news] = await Promise.all([
      fetchJson(`${BASE_URL}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${token}`, timeoutMs),
      fetchJson(`${BASE_URL}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${token}`, timeoutMs),
      fetchJson(`${BASE_URL}/company-news?symbol=${encodeURIComponent(symbol)}&from=${daysAgo(7)}&to=${today()}&token=${token}`, timeoutMs),
    ]);

    const m = metrics?.metric || {};
    const withSource = (value) =>
      value === undefined || value === null
        ? unavailable('not_provided_by_source')
        : { value, source: 'finnhub', fetchedAtUtc };

    return {
      assetType: 'stock',
      fetchedAtUtc,
      fields: {
        revenue: unavailable('requires_paid_financials_as_reported_endpoint'),
        netIncome: unavailable('requires_paid_financials_as_reported_endpoint'),
        eps: withSource(m.epsTTM),
        peRatio: withSource(m.peTTM),
        debtRatio: withSource(m['totalDebt/totalEquityAnnual']),
        cashFlow: unavailable('requires_paid_financials_as_reported_endpoint'),
        marketCap: withSource(profile?.marketCapitalization),
        revenueGrowth: withSource(m.revenueGrowthTTMYoy),
        news: Array.isArray(news) && news.length > 0
          ? { value: news.slice(0, 5).map((n) => ({ headline: n.headline, url: n.url, datetimeUtc: new Date(n.datetime * 1000).toISOString() })), source: 'finnhub', fetchedAtUtc }
          : unavailable('no_recent_news'),
        overallStatus: computeHealthStatus(m),
      },
    };
  } catch (err) {
    return {
      assetType: 'stock',
      fetchedAtUtc,
      error: err.message,
      fields: unavailableAllFields('fetch_failed'),
    };
  }
}

function computeHealthStatus(metric) {
  const growth = metric.revenueGrowthTTMYoy;
  if (growth === undefined || growth === null) {
    return unavailable('insufficient_data_for_health_status');
  }
  // Documented rule: >5% YoY revenue growth => healthy, <0% => weak, else neutral.
  let status = 'neutral';
  if (growth > 5) status = 'healthy';
  else if (growth < 0) status = 'weak';
  return { value: status, source: 'finnhub', basis: 'revenue_growth_ttm_yoy', revenueGrowthTTMYoy: growth };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

module.exports = { fetchStockFundamentals };
