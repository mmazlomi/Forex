'use strict';

/**
 * Charting: the main price chart is the real embedded TradingView Advanced Chart widget
 * (`tv.js`, see index.html) for full drawing tools/indicators/replay; the backtest equity curve
 * uses the separate, lightweight TradingView Lightweight Charts library (also loaded via CDN
 * script tag) since it's an internal metric, not a market symbol TradingView can chart.
 */
const Charts = (() => {
  function chartOptions() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return {
      layout: {
        background: { color: 'transparent' },
        textColor: dark ? '#e6e6e6' : '#16181d',
      },
      grid: {
        vertLines: { color: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' },
        horzLines: { color: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
    };
  }

  // ---------- TradingView Advanced Chart widget (the real thing, not Lightweight Charts) ----------
  // Best-effort ccxt-exchange-id → TradingView exchange prefix mapping, covering the app's
  // curated exchange list (src/controllers/exchanges-controller.js CURATED_EXCHANGE_IDS). Not
  // independently verifiable against TradingView's own listings from this codebase — if a
  // mapping is stale/wrong for a given symbol, the widget's own "invalid symbol" search box
  // (allow_symbol_change: true) lets the user pick the right listing manually.
  // No 'nobitex' entry, deliberately, after a real back-and-forth: TradingView-hosted chart
  // snapshots do exist for "NOBITEX:USDTIRT" specifically (a USD/Rial reference rate — likely
  // tracked for macro/FX purposes, not full market coverage), which briefly looked like evidence
  // Nobitex was fully listed and this entry was added — but a real user then reported Nobitex
  // symbols not showing in the actual widget. The basic embed widget is an opaque cross-origin
  // iframe with no callback for "this symbol failed to resolve," so a per-exchange mapping can't
  // safely gamble on partial/unverified coverage: better a chart that's always real data (the
  // fallback below) than one that's sometimes a blank "invalid symbol" widget.
  const EXCHANGE_TV_PREFIX = {
    binance: 'BINANCE', bybit: 'BYBIT', okx: 'OKX', kucoin: 'KUCOIN', kraken: 'KRAKEN',
    coinbase: 'COINBASE', bitget: 'BITGET', gate: 'GATEIO', mexc: 'MEXC', htx: 'HTX',
    bitfinex: 'BITFINEX', bitstamp: 'BITSTAMP', gemini: 'GEMINI', cryptocom: 'CRYPTOCOM',
    coinex: 'COINEX',
  };

  const TIMEFRAME_TV_INTERVAL = {
    '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W',
  };

  function mapToTradingViewSymbol(symbol, exchange, assetType) {
    const cleanSymbol = String(symbol || '').replace('/', '').toUpperCase();
    if (assetType === 'stock') return cleanSymbol;
    const prefix = EXCHANGE_TV_PREFIX[String(exchange || '').toLowerCase()] || String(exchange || '').toUpperCase();
    return `${prefix}:${cleanSymbol}`;
  }

  function mapTimeframeToTvInterval(timeframe) {
    return TIMEFRAME_TV_INTERVAL[timeframe] || '60';
  }

  // Stocks map straight to a bare TradingView ticker regardless of exchange (see
  // mapToTradingViewSymbol). For crypto, TradingView only has data for exchanges in
  // EXCHANGE_TV_PREFIX — notably not Nobitex, a regional exchange TradingView doesn't index at
  // all. Guessing a prefix for an unmapped exchange (e.g. "NOBITEX:BTCUSDT") just gets TradingView's
  // widget to report "invalid symbol", which looks to a user exactly like the chart being broken.
  function hasTradingViewMapping(exchange, assetType) {
    if (assetType === 'stock') return true;
    return Boolean(EXCHANGE_TV_PREFIX[String(exchange || '').toLowerCase()]);
  }

  /**
   * Embeds TradingView's actual Advanced Chart widget (loaded via the `tv.js` embed script in
   * index.html) — real drawing tools, full indicator/study library, chart type switcher
   * (Heikin Ashi, Renko, etc.), replay mode, alerts, all provided by TradingView itself. This
   * pulls TradingView's own market data for the mapped symbol, not this app's own exchange
   * feed/candles — the Technical Analysis panel and Signal card remain backed by this app's own
   * `/api/indicators` and `/api/signals/analyze`, independent of what this widget shows.
   */
  function createTradingViewWidget(containerId, { symbol, exchange, assetType, timeframe }) {
    const container = document.getElementById(containerId);
    if (!container || typeof TradingView === 'undefined') return null;
    container.innerHTML = '';

    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // eslint-disable-next-line no-undef -- TradingView is defined by the externally-loaded tv.js
    new TradingView.widget({
      autosize: true,
      symbol: mapToTradingViewSymbol(symbol, exchange, assetType),
      interval: mapTimeframeToTvInterval(timeframe),
      timezone: 'Etc/UTC',
      theme: dark ? 'dark' : 'light',
      style: '1',
      locale: 'en',
      enable_publishing: false,
      allow_symbol_change: true,
      hide_side_toolbar: false,
      withdateranges: true,
      details: true,
      container_id: containerId,
    });

    return {
      destroy() {
        container.innerHTML = '';
      },
    };
  }

  function createLineChart(containerId) {
    const container = document.getElementById(containerId);
    if (!container || typeof LightweightCharts === 'undefined') return null;
    container.innerHTML = '';

    const chart = LightweightCharts.createChart(container, {
      ...chartOptions(),
      width: container.clientWidth,
      height: container.clientHeight,
    });
    const lineSeries = chart.addLineSeries({ color: '#2563eb' });

    return {
      setPoints(points) {
        lineSeries.setData(points.map((p) => ({ time: Math.floor(new Date(p.ts_utc).getTime() / 1000), value: p.equity })));
        chart.timeScale().fitContent();
      },
      destroy() {
        chart.remove();
      },
    };
  }

  // Fallback for exchanges TradingView has no data for (e.g. Nobitex): renders this app's own
  // real OHLCV candles (from /api/candles, the same data the Technical Analysis panel uses) via
  // the Lightweight Charts library already loaded for the backtest equity curve, rather than
  // showing a broken TradingView widget or no chart at all.
  function createCandlestickChart(containerId) {
    const container = document.getElementById(containerId);
    if (!container || typeof LightweightCharts === 'undefined') return null;
    container.innerHTML = '';

    const chart = LightweightCharts.createChart(container, {
      ...chartOptions(),
      width: container.clientWidth,
      height: container.clientHeight,
    });
    const series = chart.addCandlestickSeries({
      upColor: '#16a34a', downColor: '#dc2626', borderVisible: false,
      wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    });

    return {
      setCandles(candles) {
        series.setData((candles || []).map((c) => ({
          time: Math.floor(new Date(c.ts_utc).getTime() / 1000),
          open: c.open, high: c.high, low: c.low, close: c.close,
        })));
        chart.timeScale().fitContent();
      },
      destroy() {
        chart.remove();
      },
    };
  }

  return {
    createTradingViewWidget, createLineChart, createCandlestickChart,
    mapToTradingViewSymbol, mapTimeframeToTvInterval, hasTradingViewMapping,
  };
})();
