'use strict';

const { timeframeToMs } = require('../../market-data/candle-validator');

// ccxt has no Nobitex support at all (checked ccxt 4.5.70 — no matching exchange id), so this
// is a hand-written adapter against Nobitex's own REST API, shaped to match the subset of the
// ccxt exchange interface this app actually calls (loadMarkets/markets, fetchTicker,
// fetchOHLCV, fetchBalance, createOrder — see exchange-client-factory.js). Endpoint shapes below
// are taken directly from Nobitex's official docs (https://github.com/nobitex/docs-api,
// apidocs.nobitex.ir) — see docs/architecture.md §16 for the full sourcing/design writeup and
// the real limitations this adapter has that a full ccxt exchange wouldn't.

const BASE_URL = 'https://apiv2.nobitex.ir';

// ccxt-style timeframe -> Nobitex's `resolution` param (source/includes/_market_data.md). There
// is no weekly resolution published by Nobitex at all (only 1/5/15/30 minutes, 60/180/240/360/720
// minutes, and D/2D/3D) — "1w" is deliberately left out of this map rather than approximated, so
// assertTimeframeSupported() (market-data-service.js) rejects it with a clear error instead of
// this adapter silently aggregating daily candles into something Nobitex never actually returned.
const TIMEFRAME_TO_RESOLUTION = {
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D',
};

// Nobitex's own accounting currency for "IRT" markets is actually Rial (currency code "rls"),
// not Toman — 1 Toman = 10 Rial (Nobitex's own docs; see nobitexCurrencyCode() below). Every
// rls-denominated price this adapter reads back (ticker, OHLCV, wallet balance) was being handed
// to the rest of the app unconverted, so everywhere the app labeled a number "IRT" it was
// actually showing Rial — 10x too large. Confirmed empirically, not just from docs: a real
// account's raw RLS wallet balance (17285.5083) matched exactly to that same account's real,
// user-verified Toman balance (1728.55083) once divided by 10. RIALS_PER_TOMAN converts prices
// and balances read from Nobitex (divide) and converts a price back before sending an order to
// Nobitex's own API (multiply) — never applied to volumes (base-asset units) or percentages
// (unitless ratios), which don't need it.
const RIALS_PER_TOMAN = 10;

function nobitexCurrencyCode(appCurrencyCode) {
  const upper = String(appCurrencyCode || '').toUpperCase();
  // Symbols use "IRT" (Toman) as the quote suffix, but Nobitex's actual currency code for every
  // Rial-quoted market's currency param is "rls" (Rial, 1 Toman = 10 Rial) — confirmed by their
  // own /market/stats and /market/orders/add examples both using dstCurrency=rls for IRT pairs.
  // Not a guess: this is Nobitex's own documented inconsistency between market-symbol naming and
  // currency-code naming, not something invented for this adapter.
  return upper === 'IRT' ? 'rls' : upper.toLowerCase();
}

async function nobitexRequest(url, { method = 'GET', body, timeoutMs = 10000, token } = {}) {
  const headers = { 'User-Agent': 'TraderBot/trading-bot-app' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Token ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Nobitex returned a non-JSON response (HTTP ${res.status}).`);
  // Nobitex's own convention (source/includes/_general_notes.md): logical failures come back as
  // HTTP 200 with {status:"failed", code, message}; request-level failures use real HTTP codes.
  if (json.status === 'failed') {
    throw new Error(`Nobitex: ${json.code || 'error'} — ${json.message || 'unknown error'}`);
  }
  if (!res.ok) {
    throw new Error(`Nobitex HTTP ${res.status}: ${json.message || res.statusText}`);
  }
  return json;
}

class NobitexExchange {
  // Checked by real-credentials-controller.js's validation — Nobitex authenticates with a
  // single Token (carried in the apiKey field), not an apiKey/apiSecret pair, so requiring a
  // non-empty apiSecret for it would just force users to type a meaningless placeholder.
  static NO_SECRET_NEEDED = true;

  constructor({ apiKey, timeout } = {}) {
    this.id = 'nobitex';
    this.name = 'Nobitex';
    // Nobitex authenticates with a single bearer-style Token (from the user's account, or the
    // rarely-recommended username/password login flow, which this adapter deliberately does NOT
    // implement — see docs/architecture.md §16 for why). The app's "API Key" field carries this
    // token; "API Secret" isn't used by Nobitex at all.
    this.token = apiKey || null;
    this.timeout = timeout || 10000;
    this.markets = {};
    this.timeframes = { ...TIMEFRAME_TO_RESOLUTION };
    this.urls = { test: null }; // no sandbox/testnet exists
  }

  async loadMarkets() {
    if (Object.keys(this.markets).length > 0) return this.markets;
    // Nobitex has no dedicated "list markets" endpoint, but /market/stats called with no
    // srcCurrency/dstCurrency filter returns live stats for every market Nobitex currently
    // offers, keyed by "base-quote" — used here as the live market list instead of a
    // hand-maintained static one. A hardcoded list drifts out of sync with Nobitex's actual
    // delistings/renames (this app shipped with one that still listed EOS and TON, both fully
    // delisted from Nobitex, and MATIC/RNDR/SHIB under their old pre-rebrand names — all of
    // which made fetchTicker() fail with "InvalidCurrency" for real users).
    const json = await nobitexRequest(`${BASE_URL}/market/stats`, { timeoutMs: this.timeout });
    for (const [key, stats] of Object.entries(json.stats || {})) {
      const [rawBase, rawQuote] = key.split('-');
      if (!rawBase || !rawQuote) continue;
      const quote = rawQuote === 'rls' ? 'IRT' : rawQuote.toUpperCase();
      const base = rawBase.toUpperCase();
      const appSymbol = `${base}/${quote}`;
      // isClosed is Nobitex's own live signal that a market currently has no active order book
      // (same field the mark-price fallback in fetchTicker() below reacts to) — surfaced as
      // active:false so the symbol picker doesn't suggest markets with no tradable price, not a
      // fabricated status.
      this.markets[appSymbol] = { id: `${base}${quote}`, symbol: appSymbol, base, quote, active: stats.isClosed !== true, spot: true };
    }
    return this.markets;
  }

  _market(symbol) {
    const market = this.markets[symbol];
    if (!market) throw new Error(`Symbol "${symbol}" is not a recognized Nobitex market (call loadMarkets() first).`);
    return market;
  }

  async fetchTicker(symbol) {
    const market = this._market(symbol);
    const src = nobitexCurrencyCode(market.base);
    const dst = nobitexCurrencyCode(market.quote);
    const json = await nobitexRequest(`${BASE_URL}/market/stats?srcCurrency=${src}&dstCurrency=${dst}`, { timeoutMs: this.timeout });
    const stats = json.stats && json.stats[`${src}-${dst}`];
    if (!stats) throw new Error(`Nobitex returned no stats for ${symbol} (${src}-${dst}).`);
    // Closed/illiquid markets report latest:"0" (no recent trade), but Nobitex still maintains a
    // non-zero `mark` reference price for them — falling back to it avoids showing a misleading
    // price of 0 for a market that does have a real (if stale) valuation, without fabricating a
    // number Nobitex itself doesn't provide. Only mark is used as a fallback, never invented.
    const latest = stats.latest !== undefined ? Number(stats.latest) : 0;
    const mark = stats.mark !== undefined ? Number(stats.mark) : 0;
    let last = latest > 0 ? latest : (mark > 0 ? mark : null);
    if (last !== null && market.quote === 'IRT') last /= RIALS_PER_TOMAN; // Rial -> Toman
    return {
      symbol,
      last,
      percentage: stats.dayChange !== undefined ? Number(stats.dayChange) : null,
      baseVolume: stats.volumeSrc !== undefined ? Number(stats.volumeSrc) : null,
      // /market/stats carries no timestamp field at all — left undefined rather than fabricated;
      // market-data-service.js already falls back to its own fetch time when this is falsy.
      timestamp: undefined,
    };
  }

  async fetchOHLCV(symbol, timeframe, since, limit = 200) {
    const market = this._market(symbol);
    const resolution = TIMEFRAME_TO_RESOLUTION[timeframe];
    if (!resolution) {
      throw new Error(`Nobitex does not publish a "${timeframe}" candle resolution (no weekly candles exist on Nobitex).`);
    }

    const stepSec = timeframeToMs(timeframe) / 1000;
    const nowSec = Math.floor(Date.now() / 1000);
    // Nobitex's history endpoint is backward-looking (countback from `to`), the opposite
    // direction of ccxt's forward-from-`since` convention this app's pagination expects
    // (historical-data.js advances `since` forward each page) — from/to bounds the window
    // explicitly instead of using `countback`, so the direction matches what callers expect.
    const fromSec = since !== undefined ? Math.floor(since / 1000) : Math.max(0, nowSec - Math.ceil(stepSec * limit));
    const toSec = since !== undefined ? Math.min(fromSec + Math.ceil(stepSec * limit), nowSec) : nowSec;

    const url = `${BASE_URL}/market/udf/history?symbol=${market.id}&resolution=${resolution}&from=${fromSec}&to=${toSec}`;
    const json = await nobitexRequest(url, { timeoutMs: this.timeout });
    if (json.s === 'no_data') return [];
    if (json.s !== 'ok') throw new Error(`Nobitex OHLC history error: ${json.errmsg || json.s}`);

    const priceScale = market.quote === 'IRT' ? RIALS_PER_TOMAN : 1; // Rial -> Toman for IRT markets; volume (v) is base-asset units, never scaled
    const rows = (json.t || []).map((tSec, i) => [tSec * 1000, json.o[i] / priceScale, json.h[i] / priceScale, json.l[i] / priceScale, json.c[i] / priceScale, json.v[i]]);
    return rows.slice(0, limit);
  }

  async fetchBalance() {
    this._requireToken();
    const json = await nobitexRequest(`${BASE_URL}/v2/wallets`, { timeoutMs: this.timeout, token: this.token });
    const free = {};
    for (const [currency, wallet] of Object.entries(json.wallets || {})) {
      const available = (Number(wallet.balance) || 0) - (Number(wallet.blocked) || 0);
      const code = currency.toUpperCase();
      free[code] = available;
      if (code === 'RLS') free.IRT = available / RIALS_PER_TOMAN; // app-facing quote naming is IRT (Toman), wallet is Rial
    }
    return { free };
  }

  // Order type support beyond 'market': 'limit' only. Nobitex's own /market/orders/add also
  // documents execution:"stop_market"/"stop_limit" (with a stopPrice param) and OCO linkage via
  // /market/orders/update-status's own notes — confirmed real and documented (sourced directly
  // from github.com/nobitex/docs-api's _market_trade.md), not unknown — but deliberately still
  // not implemented here; Phase 1's order-types design scoped Nobitex to limit-only. Rejected
  // clearly (ORDER_TYPE_UNIMPLEMENTED_FOR_EXCHANGE in real-orders.js), never guessed at.
  async createOrder(symbol, type, side, amount, price) {
    this._requireToken();
    const market = this._market(symbol);
    if (type !== 'market' && type !== 'limit') {
      throw new Error(`NobitexExchange only implements market and limit orders (requested "${type}").`);
    }

    const src = nobitexCurrencyCode(market.base);
    const dst = nobitexCurrencyCode(market.quote);

    let boundPrice = price;
    if (type === 'market') {
      // Nobitex's own docs strongly recommend always sending `price` even on a market order — it
      // bounds the fill to within ~1% of that price, protecting against an unexpectedly bad fill
      // during a volatility spike. Fetched fresh here if the caller didn't supply one.
      if (boundPrice === undefined || boundPrice === null) {
        const ticker = await this.fetchTicker(symbol);
        boundPrice = ticker.last;
      }
    } else if (boundPrice === undefined || boundPrice === null) {
      // A limit order's price is never optional — unlike market, there's no live-ticker fallback
      // that would make sense here (a limit order with a fabricated price defeats the purpose).
      throw new Error('NobitexExchange: a limit order requires an explicit price.');
    }

    const body = { type: side, execution: type, srcCurrency: src, dstCurrency: dst, amount: String(amount) };
    if (boundPrice !== null && boundPrice !== undefined) {
      // boundPrice is Toman (the app's own IRT unit, whether supplied by the caller or fetched
      // fresh above) — Nobitex's own order API expects a Rial-denominated price for rls-quoted
      // markets, so convert back before sending. See RIALS_PER_TOMAN.
      const nobitexPrice = market.quote === 'IRT' ? boundPrice * RIALS_PER_TOMAN : boundPrice;
      body.price = String(nobitexPrice);
    }

    const addJson = await nobitexRequest(`${BASE_URL}/market/orders/add`, { method: 'POST', body, timeoutMs: this.timeout, token: this.token });
    const orderId = addJson.order?.id;
    if (!orderId) throw new Error('Nobitex accepted the order but returned no order id.');

    if (type === 'limit') {
      // Unlike a market order, a limit order legitimately stays "Active" (Nobitex's term) until
      // price crosses it — there's nothing to confirm synchronously here. The caller (real-
      // orders.js) stores this as a pending order and pending-orders-watcher.js polls fetchOrder()
      // below to learn when/if it fills, exactly like every ccxt exchange's pending orders.
      return { id: String(orderId), symbol, type, side, amount: Number(amount), status: 'open' };
    }

    // Market orders: the "add" response isn't a reliable fill confirmation on its own (Nobitex's
    // own docs show Active/Inactive status immediately after submission even for orders that do
    // fill quickly) — this app has no partial-fill handling anywhere (real-orders.js assumes
    // createOrder() resolving means fully filled), so confirm via a follow-up status check
    // rather than risk silently recording a partial fill as a complete one.
    const statusJson = await nobitexRequest(`${BASE_URL}/market/orders/status`, { method: 'POST', body: { id: orderId }, timeoutMs: this.timeout, token: this.token });
    const finalOrder = statusJson.order;
    if (!finalOrder || finalOrder.status !== 'Done') {
      throw new Error(`Nobitex order #${orderId} did not fully fill (status: ${finalOrder?.status ?? 'unknown'}) — partially-filled orders aren't supported by this app.`);
    }

    return { id: String(orderId), symbol, type, side, amount: Number(finalOrder.amount) };
  }

  // Nobitex status values (sourced from /market/orders/status's docs): Active = unfilled
  // remainder still live in the market; Inactive = a stop order not yet triggered (n/a for the
  // limit-only support this adapter has); Done = fully filled; Canceled = canceled before full
  // fill (matches ccxt's unified vocabulary: open/open/closed/canceled respectively).
  async fetchOrder(id, symbol) {
    this._requireToken();
    const market = this._market(symbol);
    const json = await nobitexRequest(`${BASE_URL}/market/orders/status`, { method: 'POST', body: { id: Number(id) }, timeoutMs: this.timeout, token: this.token });
    const order = json.order;
    if (!order) throw new Error(`Nobitex returned no order for id ${id}.`);
    return this._mapOrderStatus(order, symbol, market);
  }

  // /market/orders/update-status with status:"canceled" (their docs' own casing for the request
  // — the response echoes back "Canceled", matching fetchOrder's status vocabulary).
  async cancelOrder(id, symbol) {
    this._requireToken();
    const market = this._market(symbol);
    const json = await nobitexRequest(`${BASE_URL}/market/orders/update-status`, {
      method: 'POST', body: { order: Number(id), status: 'canceled' }, timeoutMs: this.timeout, token: this.token,
    });
    const order = json.order;
    if (!order) throw new Error(`Nobitex returned no order for id ${id} after cancel.`);
    return this._mapOrderStatus(order, symbol, market);
  }

  _mapOrderStatus(order, symbol, market) {
    const statusMap = { Active: 'open', Inactive: 'open', Done: 'closed', Canceled: 'canceled' };
    const priceScale = market.quote === 'IRT' ? RIALS_PER_TOMAN : 1;
    const rawPrice = order.price !== undefined ? Number(order.price) : NaN;
    return {
      id: String(order.id),
      symbol,
      status: statusMap[order.status] || 'open',
      amount: order.amount !== undefined ? Number(order.amount) : undefined,
      // Nobitex's status response gives the order's own submitted price, not a separate
      // "average fill price" field — used as-is (converted to Toman for IRT markets), not
      // fabricated; the watcher falls back to its own locally-stored reference price if this
      // isn't a finite number (e.g. a market order's price is literally the string "market").
      price: Number.isFinite(rawPrice) ? rawPrice / priceScale : undefined,
      average: undefined,
    };
  }

  _requireToken() {
    if (!this.token) {
      throw new Error('Nobitex requires a Token — paste one from your Nobitex account (Profile → API settings) into the API Key field.');
    }
  }
}

module.exports = NobitexExchange;
