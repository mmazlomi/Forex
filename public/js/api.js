'use strict';

/**
 * Thin fetch wrapper for the backend's standardized { success, data, message, errorCode }
 * envelope. Every function returns `data` on success and throws an Error (with the server's
 * message) on failure, so callers can just try/catch instead of checking `success` everywhere.
 */
const Api = (() => {
  async function request(method, path, { query, body } = {}) {
    // Resolved against the current document URL (not window.location.origin), and every
    // `path` below is relative (no leading slash) — this makes the app work unmodified
    // whether it's served at the domain root or reverse-proxied under a subpath (e.g.
    // nginx `location /forex/` with the prefix stripped before it reaches this app).
    // Requires the page itself to be loaded with a trailing slash (e.g. `/forex/`, not
    // `/forex`) so relative resolution lands in the right directory.
    const url = new URL(path, window.location.href);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
      }
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: 'same-origin', // sends/receives the session cookie
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`Network error calling ${method} ${path}: ${err.message}`);
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(`Invalid response from ${method} ${path} (HTTP ${response.status})`);
    }

    if (!json.success) {
      const err = new Error(json.message || `Request failed (HTTP ${response.status})`);
      err.errorCode = json.errorCode;
      err.data = json.data;
      err.statusCode = response.status;
      throw err;
    }
    return json.data;
  }

  return {
    health: () => request('GET', 'api/health'),
    signup: (username, password) => request('POST', 'api/auth/signup', { body: { username, password } }),
    login: (username, password) => request('POST', 'api/auth/login', { body: { username, password } }),
    logout: () => request('POST', 'api/auth/logout'),
    me: () => request('GET', 'api/auth/me'),
    listAssets: () => request('GET', 'api/assets'),
    addAsset: (body) => request('POST', 'api/assets', { body }),
    removeAsset: (symbol, exchange) => request('DELETE', `api/assets/${encodeURIComponent(symbol)}`, { query: { exchange } }),
    setAutoTrade: (symbol, exchange, enabled) => request('PUT', `api/assets/${encodeURIComponent(symbol)}/auto-trade`, { query: { exchange }, body: { enabled } }),
    // Currently only acted on for Liquidity Sweep Reversal-strategy assets (real-money spot
    // auto-trading, gated by ENABLE_SPOT_AUTO_TRADING + real credentials) — see reversal-spot-auto-trader.js.
    setRealAutoTrade: (symbol, exchange, enabled) => request('PUT', `api/assets/${encodeURIComponent(symbol)}/real-auto-trade`, { query: { exchange }, body: { enabled } }),
    listExchanges: () => request('GET', 'api/exchanges'),
    listSymbolsForExchange: (exchange) => request('GET', 'api/exchanges/symbols', { query: { exchange } }),
    setAssetStrategy: (symbol, exchange, strategyId) => request('PUT', `api/assets/${encodeURIComponent(symbol)}/strategy`, { query: { exchange }, body: { strategyId } }),
    setAssetTimeframe: (symbol, exchange, defaultTimeframe) => request('PUT', `api/assets/${encodeURIComponent(symbol)}/timeframe`, { query: { exchange }, body: { defaultTimeframe } }),
    setAssetExchange: (symbol, exchange, newExchange) => request('PUT', `api/assets/${encodeURIComponent(symbol)}/exchange`, { query: { exchange }, body: { newExchange } }),
    setAssetStrategyMode: (symbol, exchange, mode) => request('PUT', `api/assets/${encodeURIComponent(symbol)}/strategy-mode`, { query: { exchange }, body: { mode } }),
    // trailingPercent: number to set, or null to disable — the default a position opened from
    // this asset (manually or by AI Auto-Trade) inherits unless the order itself overrides it.
    // trailingMode: 'fixed' (default, use trailingPercent as-is) or 'atr' (auto-computed from
    // volatility each time a position opens — pass trailingPercent as null in that case).
    setAssetTrailingPercent: (symbol, exchange, trailingPercent, trailingMode = 'fixed') => request('PUT', `api/assets/${encodeURIComponent(symbol)}/trailing`, { query: { exchange }, body: { trailingPercent, trailingMode } }),
    // 'auto' opts this LSR asset into lsr-timeframe-selector.js's periodic best-timeframe backtest.
    setAssetLsrTimeframeMode: (symbol, exchange, mode) => request('PUT', `api/assets/${encodeURIComponent(symbol)}/lsr-timeframe-mode`, { query: { exchange }, body: { mode } }),
    // Opts this asset into the Adaptive Take-Profit engine (staged partial exits + trailing that
    // starts after TP1 fires) instead of the fixed-formula single take-profit.
    setAssetAdaptiveTp: (symbol, exchange, enabled) => request('PUT', `api/assets/${encodeURIComponent(symbol)}/adaptive-tp`, { query: { exchange }, body: { enabled } }),

    // The lightweight WatchList — separate from the assets/futures-assets Signals Setting lists
    // above. "Promote" is the one-click "Add to Signals Setting" action: it adds the symbol to
    // Spot Signals Setting plus both Demo and Real Futures Signals Setting in one call.
    listWatchlist: () => request('GET', 'api/watchlist'),
    addToWatchlist: (body) => request('POST', 'api/watchlist', { body }),
    removeFromWatchlist: (symbol, exchange) => request('DELETE', `api/watchlist/${encodeURIComponent(symbol)}`, { query: { exchange } }),
    promoteWatchlistItem: (symbol, exchange) => request('POST', `api/watchlist/${encodeURIComponent(symbol)}/promote`, { query: { exchange } }),

    // market: omit for the spot-only list (unchanged); pass 'futures' to also include Liquidity
    // Sweep Reversal — see signals-controller.js#getStrategies (LSR needs a short-capable market,
    // which spot isn't).
    listStrategies: (market) => request('GET', 'api/strategies', { query: { market } }),

    // Read-only live status of a Liquidity Sweep Reversal asset's state machine (which step of
    // Sweep -> Divergence -> CHOCH -> Retest -> Entry it's currently on) — see reversal-controller.js.
    getReversalStatus: (symbol, exchange, market, mode) => request('GET', 'api/reversal/status', { query: { symbol, exchange, market, mode } }),

    getMarketData: (symbol, exchange, market) => request('GET', 'api/market-data', { query: { symbol, exchange, market } }),
    getCandles: (symbol, exchange, timeframe, limit) => request('GET', 'api/candles', { query: { symbol, exchange, timeframe, limit } }),
    getIndicators: (symbol, exchange, timeframe) => request('GET', 'api/indicators', { query: { symbol, exchange, timeframe } }),
    getIndicatorSeries: (symbol, exchange, timeframe) => request('GET', 'api/indicator-series', { query: { symbol, exchange, timeframe } }),
    getFundamentals: (symbol, assetType, providerId) => request('GET', 'api/fundamentals', { query: { symbol, assetType, providerId } }),

    listSignals: (symbol, mode, limit) => request('GET', 'api/signals', { query: { symbol, mode, limit } }),
    analyzeSignal: (body) => request('POST', 'api/signals/analyze', { body }),

    getPortfolio: (mode) => request('GET', 'api/portfolio', { query: { mode } }),
    getTradeHistory: (mode, limit) => request('GET', 'api/portfolio/history', { query: { mode, limit } }),
    getTradingStatistics: () => request('GET', 'api/portfolio/statistics', {}),
    syncRealBalance: (symbol, exchange) => request('POST', 'api/portfolio/real/sync-balance', { body: { symbol, exchange } }),
    listOrders: (mode, limit, status) => request('GET', 'api/orders', { query: { mode, limit, status } }),
    placeDemoOrder: (body) => request('POST', 'api/orders/demo', { body }),
    placeRealOrder: (body) => request('POST', 'api/orders/real', { body }),
    cancelOrder: (mode, id) => request('POST', `api/orders/${mode}/${encodeURIComponent(id)}/cancel`, {}),

    getRealCredentialsStatus: () => request('GET', 'api/real-exchange-credentials'),
    setRealCredentials: (exchangeName, apiKey, apiSecret) => request('PUT', 'api/real-exchange-credentials', { body: { exchangeName, apiKey, apiSecret } }),
    clearRealCredentials: () => request('DELETE', 'api/real-exchange-credentials'),

    runBacktest: (body) => request('POST', 'api/backtest', { body }),
    runOptimizer: (body) => request('POST', 'api/backtest/optimize', { body }),

    getRiskSettings: (mode) => request('GET', 'api/risk-settings', { query: { mode } }),
    updateRiskSettings: (mode, body) => request('PUT', 'api/risk-settings', { query: { mode }, body }),

    triggerEmergencyStop: (scope, reason) => request('POST', 'api/emergency-stop', { body: { scope, reason } }),
    resetEmergencyStop: (scope) => request('POST', 'api/emergency-stop/reset', { body: { scope, confirm: true } }),

    getLogs: (limit) => request('GET', 'api/logs', { query: { limit } }),
    getSystemStatus: () => request('GET', 'api/system-status'),

    // Phase 2 (Futures) — a fully separate set of endpoints from Spot's above, matching the
    // backend's "separate everything" design (own tables, own services, own routes). Multiple
    // exchanges (KuCoin, CoinEx) supported — see listFuturesExchanges.
    listFuturesExchanges: () => request('GET', 'api/futures/exchanges'),
    listFuturesSymbols: (exchange = 'kucoin') => request('GET', 'api/futures/symbols', { query: { exchange } }),
    getFuturesPortfolio: (mode) => request('GET', 'api/futures/portfolio', { query: { mode } }),
    getFuturesTradeHistory: (mode, limit) => request('GET', 'api/futures/history', { query: { mode, limit } }),
    listFuturesOrders: (mode, limit, status) => request('GET', 'api/futures/orders', { query: { mode, limit, status } }),
    placeDemoFuturesOrder: (body) => request('POST', 'api/futures/orders/demo', { body }),
    placeRealFuturesOrder: (body) => request('POST', 'api/futures/orders/real', { body }),

    // Fully independent Demo/Real watchlists — every call takes `mode` and hits the
    // corresponding demo_futures_assets/real_futures_assets table exclusively (see
    // futures-controller.js). No shared/"both" concept: adding, removing, or toggling on one
    // mode never touches the other, even for the "same" symbol.
    listFuturesAssets: (mode) => request('GET', 'api/futures/assets', { query: { mode } }),
    addFuturesAsset: (mode, body) => request('POST', 'api/futures/assets', { query: { mode }, body }),
    removeFuturesAsset: (mode, symbol, exchange = 'kucoin') => request('DELETE', `api/futures/assets/${encodeURIComponent(symbol)}`, { query: { mode, exchange } }),
    setFuturesAutoTrade: (mode, symbol, exchange, enabled) => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/auto-trade`, { query: { mode, exchange }, body: { enabled } }),
    setFuturesLeverage: (mode, symbol, exchange, leverage) => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/leverage`, { query: { mode, exchange }, body: { leverage } }),
    setFuturesExchange: (mode, symbol, exchange, newExchange) => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/exchange`, { query: { mode, exchange }, body: { newExchange } }),
    setFuturesStrategy: (mode, symbol, exchange, strategyId) => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/strategy`, { query: { mode, exchange }, body: { strategyId } }),
    setFuturesTimeframe: (mode, symbol, exchange, defaultTimeframe) => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/timeframe`, { query: { mode, exchange }, body: { defaultTimeframe } }),
    setFuturesStrategyMode: (mode, symbol, exchange, strategyMode) => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/strategy-mode`, { query: { mode, exchange }, body: { mode: strategyMode } }),
    setFuturesTrailingPercent: (mode, symbol, exchange, trailingPercent, trailingMode = 'fixed') => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/trailing`, { query: { mode, exchange }, body: { trailingPercent, trailingMode } }),
    setFuturesLsrTimeframeMode: (mode, symbol, exchange, timeframeMode) => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/lsr-timeframe-mode`, { query: { mode, exchange }, body: { mode: timeframeMode } }),
    setFuturesAdaptiveTp: (mode, symbol, exchange, enabled) => request('PUT', `api/futures/assets/${encodeURIComponent(symbol)}/adaptive-tp`, { query: { mode, exchange }, body: { enabled } }),

    getFuturesRiskSettings: (mode) => request('GET', 'api/futures/risk-settings', { query: { mode } }),
    updateFuturesRiskSettings: (mode, body) => request('PUT', 'api/futures/risk-settings', { query: { mode }, body }),
  };
})();
