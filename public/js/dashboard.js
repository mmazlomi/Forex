'use strict';

/**
 * Main dashboard orchestration: tabs, asset loading, TA/fundamentals/signal rendering,
 * demo/real order flows, backtest, risk settings, emergency stop, and system/logs.
 * All dynamic content is rendered via textContent/DOM APIs, never innerHTML with data
 * that came from the API, to keep this XSS-safe per the project's security requirements.
 */
(() => {
  let currentAsset = { symbol: 'BTC/USDT', exchange: 'kucoin', assetType: 'crypto', timeframe: '1h' };
  let lastPrice = null;
  let equityChart = null;
  let watchlistCache = [];
  let strategiesCache = [];
  let exchangesCache = [];
  let pendingBacktestScoringConfig = null;
  // Matches the header's #timeframe-input options and the backend's SUPPORTED_TIMEFRAMES
  // (src/services/market-data/market-data-service.js) — kept as a literal list here rather than
  // fetched, since it's already duplicated as static <option>s in the header select.
  const TIMEFRAME_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

  // ---------- small DOM helpers ----------

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setField(root, field, value) {
    const node = root.querySelector(`[data-field="${field}"]`);
    if (node) node.textContent = value;
  }

  function showContent(cardEl) {
    cardEl.querySelector('[data-role="empty"]').hidden = true;
    cardEl.querySelector('[data-role="content"]').hidden = false;
  }

  function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const node = el('div', { class: `toast toast--${type}` }, message);
    container.appendChild(node);
    setTimeout(() => node.remove(), 5000);
  }

  function fmt(n, digits = 2) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  // Portfolio balances can be denominated in a crypto quote currency (e.g. Nobitex lets a user
  // hold BTC/ETH/USDT balances directly, not just its native IRT) where a real, non-zero amount
  // like 0.0006349704 rounds all the way down to "0" at fmt()'s default 2 decimal places —
  // indistinguishable from an actually-empty wallet. Widening precision only for sub-1 magnitudes
  // keeps normal fiat-scale balances (17285.5 IRT, 10000 USD demo balance) at a clean 2 decimals.
  function fmtBalance(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    const digits = Math.abs(n) > 0 && Math.abs(n) < 1 ? 8 : 2;
    return fmt(n, digits);
  }

  // Matches TradingView's own price-axis behavior: precision scales with magnitude instead of a
  // flat 2 decimals, so a sub-cent altcoin (e.g. 0.00001234) still shows meaningful digits instead
  // of rounding to "0.00" (same underlying problem fmtBalance above solves for account balances).
  // >= 1 stays at 2 decimals (BTC-/ETH-scale prices); below 1, precision grows with how many
  // leading zeros follow the decimal point, capped at 8, so ~4 significant digits stay visible.
  function fmtPrice(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    const num = Number(n);
    const abs = Math.abs(num);
    let digits = 2;
    if (abs > 0 && abs < 1) {
      const leadingZeros = Math.max(0, -Math.floor(Math.log10(abs)) - 1);
      digits = Math.min(8, leadingZeros + 4);
    }
    return fmt(num, digits);
  }

  // ---------- CoinMarketCap-style market list helpers (Signals Setting tables) ----------

  // Deterministic string -> hue, purely cosmetic: gives each symbol's avatar circle a stable,
  // distinct-looking color across reloads without needing real per-asset logo assets (which this
  // app has no source for — it only ever gets a bare symbol string like "BTC/USDT" from ccxt).
  function hashHue(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return hash % 360;
  }

  function symbolAvatar(symbol) {
    const base = String(symbol || '').split('/')[0] || '?';
    const avatar = el('span', { class: 'cmc-symbol-avatar' }, base.slice(0, 2).toUpperCase());
    avatar.style.background = `hsl(${hashHue(base)}, 55%, 42%)`;
    return avatar;
  }

  // CoinMarketCap-style colored pill for 24h % change — green/up, red/down, muted/flat.
  function changeBadge(percent) {
    if (percent === null || percent === undefined || Number.isNaN(percent)) {
      return el('span', { class: 'cmc-change cmc-change--flat' }, '-');
    }
    const direction = percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat';
    const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';
    return el('span', { class: `cmc-change cmc-change--${direction}` }, `${arrow} ${fmt(Math.abs(percent), 2)}%`.trim());
  }

  // Every stored timestamp in this app is a UTC ISO-8601 string (e.g. from new Date().toISOString()
  // at write time) — this renders it in the browser's own local timezone (whatever the device is
  // set to) for every history table, rather than showing the raw UTC string. No `timeZone` option
  // is passed to Intl.DateTimeFormat, so it defaults to the runtime's local zone. Falls back to
  // the raw string if it doesn't parse as a date, rather than showing something misleading.
  function formatTimestamp(isoString) {
    if (!isoString) return '-';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  // ---------- tabs ----------

  function switchToTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('tab-btn--active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('tab-panel--active'));
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) btn.classList.add('tab-btn--active');
    const panel = document.getElementById(`tab-${tabName}`);
    if (panel) panel.classList.add('tab-panel--active');

    if (tabName === 'demo') { refreshPortfolio('demo'); Futures.refreshPortfolio('demo'); }
    if (tabName === 'real') {
      refreshPortfolio('real');
      if (ModeSwitcher.isRealUnlocked()) Futures.refreshPortfolio('real');
    }
    if (tabName === 'watchlist') { refreshSpotWatchlist(); Futures.refreshBothWatchlists(); }
    if (tabName === 'risk') loadRiskSettings(ModeSwitcher.getMode());
    if (tabName === 'system') { refreshSystemStatus(); refreshLogs(); }
  }

  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchToTab(btn.dataset.tab));
    });
  }

  // ---------- dashboard: market data / chart / indicators / fundamentals ----------

  function updateSpotCurrentSymbolLabels() {
    const label = currentAsset.symbol && currentAsset.exchange ? `${currentAsset.symbol} @ ${currentAsset.exchange}` : '-';
    const demoLabel = document.getElementById('spot-demo-current-symbol');
    const realLabel = document.getElementById('spot-real-current-symbol');
    if (demoLabel) demoLabel.textContent = label;
    if (realLabel) realLabel.textContent = label;
  }

  async function loadAsset() {
    currentAsset = {
      symbol: document.getElementById('symbol-input').value.trim(),
      exchange: document.getElementById('exchange-input').value.trim().toLowerCase(),
      assetType: document.getElementById('asset-type-input').value,
      timeframe: document.getElementById('timeframe-input').value,
    };
    if (!currentAsset.symbol || !currentAsset.exchange) {
      toast('Symbol and exchange are required.', 'error');
      return;
    }

    updateSpotCurrentSymbolLabels();
    await Promise.all([loadMarketData(), loadChart(), loadIndicators(), loadFundamentals(), loadSignalHistory()]);
  }

  // ---------- strategies ----------

  function populateStrategySelect(select) {
    clear(select);
    strategiesCache.forEach((s) => {
      const opt = el('option', { value: s.id, title: s.description }, s.name);
      select.appendChild(opt);
    });
  }

  async function loadStrategyOptions() {
    try {
      strategiesCache = await Api.listStrategies();
      populateStrategySelect(document.getElementById('strategy-select'));
      populateStrategySelect(document.getElementById('backtest-strategy-select'));
      document.getElementById('strategy-select').value = 'balanced';
      document.getElementById('backtest-strategy-select').value = 'balanced';
    } catch (err) {
      toast(`Failed to load strategies: ${err.message}`, 'error');
    }
  }

  // ---------- exchange list / symbol suggestions ----------

  async function loadExchangeOptions() {
    try {
      const exchanges = await Api.listExchanges();
      exchangesCache = exchanges;
      const select = document.getElementById('exchange-input');
      clear(select);
      exchanges.forEach((ex) => {
        const opt = el('option', { value: ex.id }, `${ex.name}${ex.hasSandbox ? ' (sandbox)' : ''}`);
        select.appendChild(opt);
      });
      select.value = 'kucoin';
    } catch (err) {
      toast(`Failed to load exchange list: ${err.message}`, 'error');
    }
  }

  // Every actual tradable symbol on the currently-selected exchange (fetched once per exchange,
  // cached server-side for an hour). Rendered via a hand-built dropdown rather than the native
  // <datalist> element — datalist's suggestion popup is unreliable across browsers and, on iOS/
  // desktop Safari specifically, effectively never renders at all (long-standing WebKit gap), so
  // a datalist-based symbol picker silently shows nothing to Safari users.
  let symbolSuggestionsCache = [];

  async function refreshSymbolSuggestions() {
    const exchange = document.getElementById('exchange-input').value;
    if (!exchange) return;
    try {
      symbolSuggestionsCache = await Api.listSymbolsForExchange(exchange);
    } catch (err) {
      toast(`Failed to load symbol list for ${exchange}: ${err.message}`, 'error');
    }
  }

  function hideSymbolSuggestions() {
    document.getElementById('symbol-suggestions-list').hidden = true;
  }

  function showSymbolSuggestions(filterText) {
    const list = document.getElementById('symbol-suggestions-list');
    clear(list);
    const query = (filterText || '').trim().toUpperCase();
    const matches = (query ? symbolSuggestionsCache.filter((s) => s.toUpperCase().includes(query)) : symbolSuggestionsCache).slice(0, 25);
    if (matches.length === 0) {
      hideSymbolSuggestions();
      return;
    }
    matches.forEach((symbol) => list.appendChild(el('li', {}, symbol)));
    list.hidden = false;
  }

  // ---------- spot watchlist (Watchlist tab) ----------

  function loadAssetInto(asset) {
    document.getElementById('exchange-input').value = asset.exchange;
    document.getElementById('symbol-input').value = asset.symbol;
    document.getElementById('asset-type-input').value = asset.asset_type;
    document.getElementById('timeframe-input').value = asset.default_timeframe || '1h';
  }

  async function tradeWatchlistAsset(asset, mode) {
    loadAssetInto(asset);
    await loadAsset();
    switchToTab(mode);
  }

  async function refreshSpotWatchlist() {
    const body = document.getElementById('watchlist-spot-body');
    const emptyEl = document.getElementById('watchlist-spot-empty');
    try {
      watchlistCache = await Api.listAssets();
      clear(body);
      emptyEl.hidden = watchlistCache.length > 0;

      watchlistCache.forEach((asset, index) => {
        const row = el('tr');
        row.appendChild(el('td', { class: 'cmc-rank' }, String(index + 1)));

        const symbolCell = el('td');
        const symbolWrap = el('div', { class: 'cmc-symbol-cell' });
        symbolWrap.appendChild(symbolAvatar(asset.symbol));
        symbolWrap.appendChild(el('span', { class: 'cmc-symbol-name' }, asset.symbol));
        symbolCell.appendChild(symbolWrap);
        row.appendChild(symbolCell);

        // Live price/24h % — fetched below, per row, after the row is in the DOM (fire-and-forget,
        // same pattern as loadMarketData's header card); starts as a loading placeholder rather
        // than blocking the whole table on every asset's network round-trip.
        const priceCell = el('td', { class: 'cmc-price' }, '…');
        const changeCell = el('td');
        row.appendChild(priceCell);
        row.appendChild(changeCell);
        Api.getMarketData(asset.symbol, asset.exchange).then((snapshot) => {
          priceCell.textContent = fmtPrice(snapshot.price);
          clear(changeCell);
          changeCell.appendChild(changeBadge(snapshot.changePercent24h));
        }).catch(() => {
          priceCell.textContent = '-';
        });

        // Lets the exchange be changed in place instead of removing/re-adding the row — the
        // asset's `exchange` is part of its identity (UNIQUE(user_id, symbol, exchange), see
        // assets-repository.js#setExchange), so this issues a PUT rather than a plain field
        // update. Includes a synthetic option for asset.exchange if it's outside the curated
        // exchangesCache list (e.g. added directly via the API) so the select still shows the
        // real current value instead of silently defaulting to the first option.
        const exchangeSelect = el('select');
        if (!exchangesCache.some((ex) => ex.id === asset.exchange)) {
          exchangeSelect.appendChild(el('option', { value: asset.exchange, selected: 'selected' }, asset.exchange));
        }
        exchangesCache.forEach((ex) => {
          const opt = el('option', { value: ex.id }, ex.name);
          if (ex.id === asset.exchange) opt.setAttribute('selected', 'selected');
          exchangeSelect.appendChild(opt);
        });
        exchangeSelect.title = 'Switch which exchange this asset is priced/traded on, without removing and re-adding it.';
        exchangeSelect.addEventListener('change', async () => {
          const newExchange = exchangeSelect.value;
          try {
            await Api.setAssetExchange(asset.symbol, asset.exchange, newExchange);
            toast(`${asset.symbol} moved to ${newExchange}.`, 'success');
            await refreshSpotWatchlist();
          } catch (err) {
            exchangeSelect.value = asset.exchange;
            toast(`Failed to change exchange: ${err.message}`, 'error');
          }
        });
        const exchangeCell = el('td');
        exchangeCell.appendChild(exchangeSelect);
        row.append(exchangeCell, el('td', {}, asset.asset_type));

        const timeframeSelect = el('select');
        TIMEFRAME_OPTIONS.forEach((tf) => {
          const opt = el('option', { value: tf }, tf);
          if (tf === (asset.default_timeframe || '1h')) opt.setAttribute('selected', 'selected');
          timeframeSelect.appendChild(opt);
        });
        timeframeSelect.title = 'Also used by AI Auto-Trade — changing it changes which candle timeframe the auto-trader analyzes for this asset.';
        timeframeSelect.addEventListener('change', async () => {
          try {
            await Api.setAssetTimeframe(asset.symbol, asset.exchange, timeframeSelect.value);
            toast(`Timeframe updated for ${asset.symbol} (used by AI Auto-Trade too).`, 'success');
          } catch (err) {
            toast(`Failed to update timeframe: ${err.message}`, 'error');
          }
        });
        const timeframeCell = el('td');
        timeframeCell.appendChild(timeframeSelect);
        row.appendChild(timeframeCell);

        const strategyCell = el('td');
        if (asset.strategy_mode === 'auto') {
          strategyCell.appendChild(buildAutoStrategySummary(asset));
        } else {
          const strategySelect = el('select');
          strategiesCache.forEach((s) => {
            const opt = el('option', { value: s.id }, s.name || s.id);
            if (s.id === asset.strategy_id) opt.setAttribute('selected', 'selected');
            strategySelect.appendChild(opt);
          });
          strategySelect.addEventListener('change', async () => {
            try {
              await Api.setAssetStrategy(asset.symbol, asset.exchange, strategySelect.value);
              toast(`Strategy updated for ${asset.symbol} (used by AI Auto-Trade too).`, 'success');
            } catch (err) {
              toast(`Failed to update strategy: ${err.message}`, 'error');
            }
          });
          strategyCell.appendChild(strategySelect);
        }
        row.appendChild(strategyCell);

        const autoSelectCheckbox = el('input', { type: 'checkbox' });
        autoSelectCheckbox.checked = asset.strategy_mode === 'auto';
        autoSelectCheckbox.title = 'Let the AI pick 2-3 strategies for this asset by backtested win rate, trading only when a majority agree, instead of the single Strategy above.';
        autoSelectCheckbox.addEventListener('change', async () => {
          try {
            await Api.setAssetStrategyMode(asset.symbol, asset.exchange, autoSelectCheckbox.checked ? 'auto' : 'manual');
            toast(`Auto-select strategies ${autoSelectCheckbox.checked ? 'enabled' : 'disabled'} for ${asset.symbol}.`, 'success');
            await refreshSpotWatchlist();
          } catch (err) {
            autoSelectCheckbox.checked = !autoSelectCheckbox.checked;
            toast(`Failed to update strategy mode: ${err.message}`, 'error');
          }
        });
        const autoSelectCell = el('td');
        autoSelectCell.appendChild(autoSelectCheckbox);
        row.appendChild(autoSelectCell);

        const autoTradeCheckbox = el('input', { type: 'checkbox' });
        autoTradeCheckbox.checked = !!asset.auto_trade_enabled;
        autoTradeCheckbox.addEventListener('change', async () => {
          try {
            await Api.setAutoTrade(asset.symbol, asset.exchange, autoTradeCheckbox.checked);
            toast(`AI Auto-Trade ${autoTradeCheckbox.checked ? 'enabled' : 'disabled'} for ${asset.symbol} (Demo only).`, 'success');
            await refreshSpotWatchlist();
          } catch (err) {
            autoTradeCheckbox.checked = !autoTradeCheckbox.checked;
            toast(`Failed to update AI Auto-Trade: ${err.message}`, 'error');
          }
        });
        const autoTradeCell = el('td');
        autoTradeCell.appendChild(autoTradeCheckbox);
        row.appendChild(autoTradeCell);

        const tradeDemoBtn = el('button', { type: 'button' }, 'Trade Demo');
        tradeDemoBtn.addEventListener('click', () => tradeWatchlistAsset(asset, 'demo'));
        const tradeDemoCell = el('td');
        tradeDemoCell.appendChild(tradeDemoBtn);
        row.appendChild(tradeDemoCell);

        const tradeRealBtn = el('button', { type: 'button' }, 'Trade Real');
        tradeRealBtn.addEventListener('click', () => tradeWatchlistAsset(asset, 'real'));
        const tradeRealCell = el('td');
        tradeRealCell.appendChild(tradeRealBtn);
        row.appendChild(tradeRealCell);

        const removeBtn = el('button', { type: 'button' }, 'Remove');
        removeBtn.addEventListener('click', async () => {
          try {
            await Api.removeAsset(asset.symbol, asset.exchange);
            await refreshSpotWatchlist();
          } catch (err) {
            toast(`Failed to remove: ${err.message}`, 'error');
          }
        });
        const removeCell = el('td');
        removeCell.appendChild(removeBtn);
        row.appendChild(removeCell);

        body.appendChild(row);
      });

      loadLastWatchlistSignals();
    } catch (err) {
      toast(`Failed to load Signals Setting: ${err.message}`, 'error');
    }
  }

  async function addCurrentAssetToWatchlist() {
    const symbol = document.getElementById('symbol-input').value.trim();
    const exchange = document.getElementById('exchange-input').value.trim().toLowerCase();
    const assetType = document.getElementById('asset-type-input').value;
    const defaultTimeframe = document.getElementById('timeframe-input').value;
    if (!symbol || !exchange) {
      toast('Symbol and exchange are required.', 'error');
      return;
    }
    try {
      await Api.addAsset({ symbol, exchange, assetType, defaultTimeframe });
      toast(`${symbol} added to Signals Setting.`, 'success');
      await refreshSpotWatchlist();
    } catch (err) {
      toast(`Failed to add asset: ${err.message}`, 'error');
    }
  }

  // Turns AI Auto-Trade on for every asset currently on the Spot Watchlist, one PUT
  // /api/assets/:symbol/auto-trade call at a time — still Demo-only (auto-trader.js has no code
  // path to Real at all).
  async function enableAutoTradeForAll() {
    if (watchlistCache.length === 0) {
      toast('Your Signals Setting is empty — add an asset first.', 'error');
      return;
    }
    const btn = document.getElementById('enable-all-autotrade-btn');
    btn.disabled = true;
    let succeeded = 0;
    const failures = [];
    for (let i = 0; i < watchlistCache.length; i++) {
      const asset = watchlistCache[i];
      btn.textContent = `Enabling... (${i + 1}/${watchlistCache.length})`;
      try {
        await Api.setAutoTrade(asset.symbol, asset.exchange, true);
        succeeded += 1;
      } catch (err) {
        failures.push(`${asset.symbol}@${asset.exchange}: ${err.message}`);
      }
    }
    btn.disabled = false;
    btn.textContent = '🤖 Enable Auto-Trade for All';
    await refreshSpotWatchlist();
    if (failures.length === 0) {
      toast(`AI Auto-Trade enabled for all ${succeeded} Signals Setting asset(s) (Demo only).`, 'success');
    } else {
      toast(`Enabled ${succeeded}/${watchlistCache.length}. Failed: ${failures.join('; ')}`, 'error');
    }
  }

  async function loadMarketData() {
    const card = document.getElementById('price-card');
    try {
      const snapshot = await Api.getMarketData(currentAsset.symbol, currentAsset.exchange);
      if (snapshot.status !== 'ok') {
        toast(`Market data unavailable: ${snapshot.error || snapshot.status}`, 'error');
        return;
      }
      lastPrice = snapshot.price;
      showContent(card);
      setField(card, 'price', fmtPrice(snapshot.price));
      const change = snapshot.changePercent24h;
      const changeNode = card.querySelector('[data-field="change"]');
      changeNode.textContent = change === null ? '-' : `${fmt(change)}%`;
      changeNode.className = change > 0 ? 'text-positive' : change < 0 ? 'text-negative' : '';
      setField(card, 'volume', fmt(snapshot.volume24h));
      setField(card, 'marketOpen', snapshot.marketOpen ? 'Open' : 'Closed');
      setField(card, 'freshness', `${fmt(snapshot.dataFreshnessMs, 0)} ms`);
    } catch (err) {
      toast(`Failed to load market data: ${err.message}`, 'error');
    }
  }

  let fallbackPriceChart = null;

  async function loadBuiltinChart() {
    document.getElementById('chart-tv-attribution').hidden = true;
    document.getElementById('chart-fallback-notice').hidden = false;
    document.getElementById('try-tradingview-btn').hidden = !Charts.hasTradingViewMapping(currentAsset.exchange, currentAsset.assetType);
    document.getElementById('use-builtin-chart-btn').hidden = true;

    if (fallbackPriceChart) {
      fallbackPriceChart.destroy();
      fallbackPriceChart = null;
    }
    fallbackPriceChart = Charts.createCandlestickChart('tv-chart-container');
    try {
      const candles = await Api.getCandles(currentAsset.symbol, currentAsset.exchange, currentAsset.timeframe, 200);
      if (fallbackPriceChart) fallbackPriceChart.setCandles(candles);
    } catch (err) {
      toast(`Failed to load chart data: ${err.message}`, 'error');
    }
  }

  function loadTradingViewChart() {
    if (!Charts.hasTradingViewMapping(currentAsset.exchange, currentAsset.assetType)) {
      // e.g. Nobitex, a regional exchange TradingView doesn't index at all — offering the button
      // would just show "invalid symbol", indistinguishable from a broken chart.
      toast(`TradingView has no chart data for "${currentAsset.exchange}".`, 'error');
      return;
    }
    if (fallbackPriceChart) {
      fallbackPriceChart.destroy();
      fallbackPriceChart = null;
    }
    document.getElementById('chart-fallback-notice').hidden = true;
    document.getElementById('chart-tv-attribution').hidden = false;
    document.getElementById('try-tradingview-btn').hidden = true;
    document.getElementById('use-builtin-chart-btn').hidden = false;
    // Synchronous, best-effort: the TradingView widget fetches its own market data directly from
    // TradingView once embedded, so there's no await/network call of our own here — just
    // (re)creating the widget for the newly loaded symbol/timeframe.
    Charts.createTradingViewWidget('tv-chart-container', {
      symbol: currentAsset.symbol, exchange: currentAsset.exchange,
      assetType: currentAsset.assetType, timeframe: currentAsset.timeframe,
    });
  }

  // TradingView is the default chart wherever it actually has data for the asset's exchange
  // (hasTradingViewMapping) — it's not offered at all for exchanges TradingView doesn't index
  // (e.g. Nobitex), where the built-in chart (this app's own real candle data) is used instead.
  // Trade-off worth knowing: TradingView's widget is an opaque cross-origin iframe with no error
  // callback, so a user whose network/country blocks TradingView's own servers gets a blank/failed
  // chart with no JS-visible warning — the "Use Built-in Chart" button is the manual escape hatch
  // for that case (see loadTradingViewChart/loadBuiltinChart).
  async function loadChart() {
    if (Charts.hasTradingViewMapping(currentAsset.exchange, currentAsset.assetType)) {
      loadTradingViewChart();
    } else {
      await loadBuiltinChart();
    }
  }

  const INDICATOR_LABELS = {
    sma: 'SMA(20)', ema: 'EMA(20)', rsi: 'RSI(14)', macd: 'MACD',
    bollingerBands: 'Bollinger Bands', atr: 'ATR(14)', stochastic: 'Stochastic',
    adx: 'ADX(14)', ichimoku: 'Ichimoku Cloud', supportResistance: 'Support / Resistance', volumeAnalysis: 'Volume',
  };

  function formatIndicatorValue(key, indicator) {
    if (indicator.status !== 'ok') return `NO_DATA (${indicator.status})`;
    const v = indicator.value;
    if (typeof v === 'number') return fmt(v);
    if (key === 'macd') return `MACD ${fmt(v.macd)} / Signal ${fmt(v.signal)} / Hist ${fmt(v.histogram)}`;
    if (key === 'bollingerBands') return `Upper ${fmtPrice(v.upper)} / Mid ${fmtPrice(v.middle)} / Lower ${fmtPrice(v.lower)}`;
    if (key === 'stochastic') return `%K ${fmt(v.k)} / %D ${fmt(v.d)}`;
    if (key === 'adx') return `ADX ${fmt(v.adx)} / +DI ${fmt(v.pdi)} / -DI ${fmt(v.mdi)}`;
    if (key === 'ichimoku') return `Conversion ${fmtPrice(v.conversion)} / Base ${fmtPrice(v.base)} / Cloud ${fmtPrice(v.cloudBottom)}–${fmtPrice(v.cloudTop)}`;
    if (key === 'supportResistance') return `Support ${fmtPrice(v.nearestSupport)} / Resistance ${fmtPrice(v.nearestResistance)}`;
    if (key === 'volumeAnalysis') return `Vol ${fmt(v.currentVolume)} (${fmt(v.relativeVolume)}x avg)`;
    return JSON.stringify(v);
  }

  async function loadIndicators() {
    const card = document.getElementById('technical-card');
    try {
      const result = await Api.getIndicators(currentAsset.symbol, currentAsset.exchange, currentAsset.timeframe);
      const body = document.getElementById('technical-table-body');
      clear(body);
      if (!result.indicators) {
        return; // empty state stays visible
      }
      showContent(card);
      for (const [key, indicator] of Object.entries(result.indicators)) {
        const row = el('tr');
        row.append(el('td', {}, INDICATOR_LABELS[key] || key), el('td', {}, formatIndicatorValue(key, indicator)));
        body.appendChild(row);
      }
    } catch (err) {
      toast(`Failed to load indicators: ${err.message}`, 'error');
    }
  }

  function fundamentalFieldLabel(key) {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }

  async function loadFundamentals() {
    const card = document.getElementById('fundamental-card');
    try {
      // No providerId passed for crypto — the backend resolves the correct CoinGecko coin id
      // from the ticker itself (ticker.toLowerCase() is NOT a valid coin id; see
      // fundamental-analysis/index.js).
      const result = await Api.getFundamentals(currentAsset.symbol, currentAsset.assetType);
      const body = document.getElementById('fundamental-table-body');
      clear(body);
      showContent(card);
      for (const [key, field] of Object.entries(result.fields)) {
        const row = el('tr');
        // Large fields (Market Cap, FDV, Supply, Volume, ...) are plain numbers — route them
        // through fmt() for thousand separators, same as every other number in the app.
        // Non-numeric values ("unavailable"/"not_applicable" statuses, or object-shaped fields)
        // are left as-is rather than being coerced through a numeric formatter.
        const valueText = typeof field.value === 'number' ? fmt(field.value)
          : typeof field.value === 'object' ? JSON.stringify(field.value)
          : String(field.value);
        row.append(el('td', {}, fundamentalFieldLabel(key)), el('td', {}, valueText));
        body.appendChild(row);
      }
    } catch (err) {
      toast(`Failed to load fundamentals: ${err.message}`, 'error');
    }
  }

  // ---------- signals ----------

  function signalBadge(status) {
    return el('span', { class: `signal-badge signal-badge--${status.toLowerCase()}` }, status);
  }

  function renderCurrentSignal(signal) {
    const container = document.getElementById('signal-current');
    clear(container);
    container.appendChild(signalBadge(signal.status));
    container.appendChild(el('p', {}, `Strategy: ${signal.strategyName || 'Balanced'} | Final score: ${fmt(signal.finalScore, 3)} | Confidence: ${fmt(signal.confidence, 2)} | Data quality: ${signal.dataQuality}`));
    if (signal.entry !== null) {
      container.appendChild(el('p', {}, `Entry ${fmtPrice(signal.entry)} / Stop ${fmtPrice(signal.stopLoss)} / Take ${fmtPrice(signal.takeProfit)} / R:R ${fmt(signal.riskRewardRatio, 2)}`));
    }
    const reasons = el('ul');
    (signal.reasons || []).forEach((r) => reasons.appendChild(el('li', {}, r)));
    container.appendChild(reasons);
    if (signal.warnings && signal.warnings.length > 0) {
      const warn = el('p', { class: 'text-negative' }, signal.warnings.join(' '));
      container.appendChild(warn);
    }
  }

  async function generateSignal() {
    try {
      // No providerId — the backend resolves the correct CoinGecko coin id for crypto assets.
      const signal = await Api.analyzeSignal({
        symbol: currentAsset.symbol, exchange: currentAsset.exchange, timeframe: currentAsset.timeframe,
        assetType: currentAsset.assetType, mode: ModeSwitcher.getMode(),
        strategyId: document.getElementById('strategy-select').value,
      });
      renderCurrentSignal(signal);
      await loadSignalHistory();
      toast(`Signal generated: ${signal.status}`, 'success');
    } catch (err) {
      toast(`Failed to generate signal: ${err.message}`, 'error');
    }
  }

  async function loadSignalHistory() {
    try {
      const signals = await Api.listSignals(currentAsset.symbol, undefined, 20);
      const body = document.getElementById('signal-history-body');
      clear(body);
      signals.forEach((s) => {
        const row = el('tr');
        row.append(
          el('td', {}, formatTimestamp(s.ts_utc)),
          el('td', {}, s.symbol),
          el('td', {}, s.status),
          el('td', {}, fmt(s.final_score, 3)),
          el('td', {}, fmt(s.confidence, 2)),
          el('td', {}, fmtPrice(s.entry)),
          el('td', {}, fmtPrice(s.stop_loss)),
          el('td', {}, fmtPrice(s.take_profit)),
          el('td', {}, fmt(s.risk_reward_ratio, 2))
        );
        body.appendChild(row);
      });
    } catch (err) {
      toast(`Failed to load signal history: ${err.message}`, 'error');
    }
  }

  function strategyName(strategyId) {
    const strategy = strategiesCache.find((s) => s.id === strategyId);
    return strategy ? strategy.name : (strategyId || 'Balanced');
  }

  // Read-only summary shown in the Strategy column in place of the manual <select> once an asset
  // is in 🎯 Auto-Select mode — strategy-selector.js (server-side scheduler) owns this value, not
  // anything editable here.
  function buildAutoStrategySummary(asset) {
    let selectedIds = [];
    try {
      selectedIds = JSON.parse(asset.selected_strategy_ids_json || '[]');
    } catch {
      selectedIds = [];
    }
    const text = selectedIds.length > 0 ? selectedIds.map(strategyName).join(', ') : 'Not yet evaluated';
    const summary = el('span', { class: 'hint' }, text);
    summary.title = asset.strategy_selection_updated_at_utc
      ? `Last evaluated: ${formatTimestamp(asset.strategy_selection_updated_at_utc)} (Tehran). Backtested win rate is technical-only — live trades still use each strategy's real technical+fundamental weighting.`
      : 'Waiting for the first strategy-selection cycle to run — this can take a while (see STRATEGY_SELECTION_INTERVAL_MS).';
    return summary;
  }

  function renderWatchlistSignalsTable(results) {
    const body = document.getElementById('watchlist-signals-body');
    clear(body);
    results.forEach(({ asset, signal, error, notice }) => {
      const row = el('tr');
      row.append(el('td', {}, asset.symbol), el('td', {}, asset.exchange), el('td', {}, strategyName(asset.strategy_id)));
      if (error || notice) {
        // `notice` (e.g. "no signal yet") is informational — muted, not styled as a failure the
        // way a genuine fetch/generate `error` is.
        const messageCell = notice ? el('td', { class: 'hint' }, notice) : el('td', { class: 'text-negative' }, `Error: ${error}`);
        row.append(el('td', {}, '-'), messageCell, el('td', {}, '-'), el('td', {}, '-'), el('td', {}, '-'), el('td', {}, '-'), el('td', {}, '-'));
      } else {
        const statusCell = el('td');
        statusCell.appendChild(signalBadge(signal.status));
        row.append(
          el('td', {}, signal.tsUtc ? formatTimestamp(signal.tsUtc) : '-'),
          statusCell,
          el('td', {}, fmt(signal.finalScore, 3)),
          el('td', {}, fmtPrice(signal.entry)),
          el('td', {}, fmtPrice(signal.stopLoss)),
          el('td', {}, fmtPrice(signal.takeProfit)),
          el('td', {}, fmt(signal.riskRewardRatio, 2))
        );
      }
      body.appendChild(row);
    });
    document.getElementById('watchlist-signals-empty').hidden = results.length > 0;
  }

  // DB rows (from GET /api/signals, snake_case) vs. a live analyzeSignal() response (camelCase)
  // have different field names for the same data — normalized here so
  // renderWatchlistSignalsTable() can render either without caring which one it got.
  function normalizeDbSignal(row) {
    return {
      status: row.status,
      finalScore: row.final_score,
      entry: row.entry,
      stopLoss: row.stop_loss,
      takeProfit: row.take_profit,
      riskRewardRatio: row.risk_reward_ratio,
      tsUtc: row.ts_utc,
    };
  }

  // Populates the Watchlist Signals table from each asset's most recently *persisted* signal
  // (every signal generated anywhere in the app — single-asset or batch — is saved to the
  // database, so this survives a page refresh even though the batch results themselves were
  // only ever held in memory). Called whenever the watchlist loads/changes, not just after
  // clicking "Generate for Watchlist", so a refresh shows the last known state instead of an
  // empty table.
  async function loadLastWatchlistSignals() {
    if (watchlistCache.length === 0) {
      renderWatchlistSignalsTable([]);
      return;
    }
    const results = await Promise.all(watchlistCache.map(async (asset) => {
      try {
        // listSignals() only filters by symbol, not exchange (the same symbol could be on more
        // than one exchange in the watchlist) — fetch a few and pick the newest matching this
        // asset's specific exchange, rather than assuming the very first row is the right one.
        const signals = await Api.listSignals(asset.symbol, undefined, 5);
        const latest = signals.find((s) => s.exchange === asset.exchange);
        if (!latest) return { asset, notice: 'No signal generated yet' };
        return { asset, signal: normalizeDbSignal(latest) };
      } catch (err) {
        return { asset, error: err.message };
      }
    }));
    renderWatchlistSignalsTable(results);
  }

  async function generateSignalsForWatchlist() {
    if (watchlistCache.length === 0) {
      toast('Your Signals Setting is empty — add an asset first.', 'error');
      return;
    }
    const btn = document.getElementById('generate-watchlist-signals-btn');
    btn.disabled = true;
    const mode = ModeSwitcher.getMode();
    const results = [];
    for (let i = 0; i < watchlistCache.length; i++) {
      const asset = watchlistCache[i];
      btn.textContent = `Generating... (${i + 1}/${watchlistCache.length})`;
      try {
        const signal = await Api.analyzeSignal({
          symbol: asset.symbol, exchange: asset.exchange, timeframe: asset.default_timeframe,
          assetType: asset.asset_type, mode, strategyId: asset.strategy_id,
        });
        results.push({ asset, signal });
      } catch (err) {
        results.push({ asset, error: err.message });
      }
      renderWatchlistSignalsTable(results); // render incrementally so progress is visible
    }
    btn.disabled = false;
    btn.textContent = 'Generate for Signals Setting';
    const succeeded = results.filter((r) => !r.error).length;
    toast(`Generated ${succeeded}/${results.length} signal(s).`, succeeded === results.length ? 'success' : 'error');
  }

  // ---------- real exchange credentials ----------

  async function loadRealCredentialsExchangeOptions() {
    try {
      const exchanges = await Api.listExchanges();
      const select = document.getElementById('real-credentials-exchange');
      clear(select);
      exchanges.forEach((ex) => select.appendChild(el('option', { value: ex.id }, ex.name)));
      updateRealCredentialsExchangeHint();
    } catch (err) {
      toast(`Failed to load exchange list: ${err.message}`, 'error');
    }
  }

  // Nobitex isn't a ccxt exchange — it's a hand-written adapter (see architecture.md §16) with a
  // fundamentally different auth model: a single Token (from the user's Nobitex account, Profile
  // → API settings) instead of an API key/secret pair, and that token expires (4h by default, up
  // to 30 days) rather than being a permanent credential like every other exchange here.
  function updateRealCredentialsExchangeHint() {
    const select = document.getElementById('real-credentials-exchange');
    const hintEl = document.getElementById('real-credentials-exchange-hint');
    const secretInput = document.getElementById('real-credentials-form').apiSecret;
    if (select.value === 'nobitex') {
      hintEl.textContent = 'Nobitex uses a single Token instead of an API key/secret pair: paste it into the "API Key" field (get it from your Nobitex account → Profile → API settings). "API Secret" is not used — leave it blank. This token expires (4 hours by default, up to 30 days) and will need to be refreshed here periodically.';
      secretInput.disabled = true;
      secretInput.placeholder = 'not used for Nobitex';
    } else {
      hintEl.textContent = '';
      secretInput.disabled = false;
      secretInput.placeholder = '';
    }
  }

  async function refreshRealCredentialsStatus() {
    const statusEl = document.getElementById('real-credentials-status');
    try {
      const status = await Api.getRealCredentialsStatus();
      if (!status.configured) {
        statusEl.textContent = 'Not configured — no real orders can be placed until an exchange and API key/secret are saved below.';
        return;
      }
      const sourceLabel = status.source === 'database' ? 'saved here in the UI' : 'from the server\'s .env file';
      statusEl.textContent = `Configured: ${status.exchangeName} (key ${status.apiKeyPreview}), ${sourceLabel}.`;
      const select = document.getElementById('real-credentials-exchange');
      if (select.querySelector(`option[value="${status.exchangeName}"]`)) select.value = status.exchangeName;
      updateRealCredentialsExchangeHint();
    } catch (err) {
      statusEl.textContent = '';
      toast(`Failed to load real exchange credentials status: ${err.message}`, 'error');
    }
  }

  function initRealCredentialsForm() {
    document.getElementById('real-credentials-exchange').addEventListener('change', updateRealCredentialsExchangeHint);
    document.getElementById('real-credentials-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      document.getElementById('real-credentials-error').hidden = true;
      const form = e.target;
      try {
        await Api.setRealCredentials(form.exchangeName.value, form.apiKey.value, form.apiSecret.value);
        form.apiKey.value = '';
        form.apiSecret.value = '';
        await refreshRealCredentialsStatus();
        toast('Real exchange credentials saved.', 'success');
        // Immediately try to populate the portfolio so it doesn't look like nothing happened —
        // quiet because currentAsset might be on a different exchange than what was just saved,
        // in which case this is expected to fail and shouldn't look like an error.
        refreshRealBalance({ quiet: true });
      } catch (err) {
        const errEl = document.getElementById('real-credentials-error');
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    document.getElementById('real-credentials-clear-btn').addEventListener('click', async () => {
      try {
        await Api.clearRealCredentials();
        await refreshRealCredentialsStatus();
        toast('Real exchange credentials cleared.', 'success');
      } catch (err) {
        toast(`Failed to clear real exchange credentials: ${err.message}`, 'error');
      }
    });
  }

  // ---------- portfolio / orders ----------

  function renderStatList(container, entries) {
    clear(container);
    entries.forEach(([label, value]) => {
      const div = el('div');
      div.append(el('dt', {}, label), el('dd', {}, value));
      container.appendChild(div);
    });
  }

  function renderPositionsTable(body, positions) {
    clear(body);
    positions.forEach((p) => {
      const row = el('tr');
      const unrealizedCell = el('td', {}, p.unrealizedPnl != null ? fmt(p.unrealizedPnl) : '-');
      if (p.unrealizedPnl > 0) unrealizedCell.className = 'text-positive';
      else if (p.unrealizedPnl < 0) unrealizedCell.className = 'text-negative';
      row.append(
        el('td', {}, p.symbol), el('td', {}, p.exchange || '-'), el('td', {}, p.side), el('td', {}, fmt(p.qty, 6)),
        el('td', {}, fmtPrice(p.entry_price)), el('td', {}, p.currentPrice != null ? fmtPrice(p.currentPrice) : '-'),
        unrealizedCell, el('td', {}, fmtPrice(p.stop_loss)), el('td', {}, fmtPrice(p.take_profit))
      );
      body.appendChild(row);
    });
  }

  function orderTypeLabel(orderType) {
    return (orderType || 'market').replace('_', '-');
  }

  function renderOrdersTable(body, orders) {
    clear(body);
    orders.forEach((o) => {
      const row = el('tr');
      row.append(
        el('td', {}, formatTimestamp(o.created_at_utc)), el('td', {}, o.symbol || '-'), el('td', {}, orderTypeLabel(o.order_type)), el('td', {}, o.side), el('td', {}, fmt(o.qty, 6)),
        el('td', {}, fmtPrice(o.price)), el('td', {}, o.status), el('td', {}, o.reject_reason || '')
      );
      body.appendChild(row);
    });
  }

  // Limit/Stop/OCO orders awaiting a fill or trigger — separate from Order History's
  // filled/rejected/cancelled records. A Cancel button lets the user abandon one before it fills.
  function renderPendingOrdersTable(body, orders, mode) {
    clear(body);
    orders.forEach((o) => {
      const row = el('tr');
      const limitOrTrigger = o.order_type === 'stop_market' ? fmtPrice(o.trigger_price)
        : o.order_type === 'stop_limit' ? `${fmtPrice(o.trigger_price)} → ${fmtPrice(o.limit_price)}`
        : fmtPrice(o.limit_price);
      const cancelBtn = el('button', { type: 'button' }, 'Cancel');
      cancelBtn.addEventListener('click', () => cancelPendingOrder(mode, o.id, cancelBtn));
      const actionCell = el('td');
      actionCell.appendChild(cancelBtn);
      row.append(
        el('td', {}, formatTimestamp(o.created_at_utc)), el('td', {}, o.symbol || '-'), el('td', {}, orderTypeLabel(o.order_type)), el('td', {}, o.side),
        el('td', {}, fmt(o.qty, 6)), el('td', {}, limitOrTrigger), actionCell
      );
      body.appendChild(row);
    });
  }

  async function cancelPendingOrder(mode, orderId, buttonEl) {
    buttonEl.disabled = true;
    try {
      await Api.cancelOrder(mode, orderId);
      toast('Order cancelled.', 'success');
      await refreshPortfolio(mode);
    } catch (err) {
      toast(`Failed to cancel order: ${err.message}`, 'error');
      buttonEl.disabled = false;
    }
  }

  // Persisted alongside portfolio.balance (see the sync-balance controller) so this shows up
  // immediately on every view of the Real tab — page reload, tab switch, mode toggle — not just
  // right after clicking Refresh Balance. Demo mode has no such concept (a single simulated
  // currency, not a live multi-currency exchange wallet), so portfolio.walletBalances is only
  // ever populated for 'real'.
  function renderWalletBalances(walletBalances) {
    const section = document.getElementById('real-wallet-balances-section');
    const list = document.getElementById('real-wallet-balances');
    if (!walletBalances || walletBalances.length === 0) {
      section.hidden = true;
      return;
    }
    renderStatList(list, walletBalances.map((w) => [w.currency, fmtBalance(w.amount)]));
    section.hidden = false;
  }

  async function refreshPortfolio(mode) {
    try {
      const portfolio = await Api.getPortfolio(mode);
      const statsEl = document.getElementById(`${mode}-portfolio-stats`);
      // Real balance is scoped to whichever quote currency was last synced (see
      // refreshRealBalance) — Nobitex in particular lets a user hold several currencies (IRT,
      // USDT, BTC, ...) at once, so without labeling the unit a correctly-synced-but-different-
      // currency balance (or a genuinely tiny one) is indistinguishable from "balance is broken."
      const unit = mode === 'real' ? ` ${currentAsset.symbol.split('/')[1] || ''}`.trimEnd() : '';
      renderStatList(statsEl, [
        ['Balance', `${fmtBalance(portfolio.balance)}${unit}`],
        ['Available', `${fmtBalance(portfolio.availableBalance)}${unit}`],
        ['Exposure', `${fmt(portfolio.exposurePercent, 1)}%`],
        ['Daily loss', `${fmtBalance(portfolio.dailyLossSoFar)}${unit}`],
        ['Open positions', String(portfolio.openPositions.length)],
      ]);
      if (mode === 'real') renderWalletBalances(portfolio.walletBalances);
      renderPositionsTable(document.getElementById(`${mode}-positions-body`), portfolio.openPositions);

      const pnlEl = document.getElementById(`${mode}-pnl-stats`);
      if (pnlEl && portfolio.pnl) {
        const p = portfolio.pnl;
        renderStatList(pnlEl, [
          ['Realized P&L (all-time)', fmt(p.totalRealizedPnl)],
          ['Unrealized P&L', fmt(p.unrealizedPnl)],
          ['Net P&L', fmt(p.netPnl)],
          ['Win rate', `${fmt(p.winRatePercent, 1)}% (${p.winCount}W / ${p.lossCount}L)`],
        ]);
        // Color the realized/net P&L values as a quick visual signal.
        [pnlEl.children[0], pnlEl.children[2]].forEach((div, i) => {
          const value = i === 0 ? p.totalRealizedPnl : p.netPnl;
          const dd = div.querySelector('dd');
          dd.className = value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : '';
        });
      }

      const orders = await Api.listOrders(mode, 20);
      renderOrdersTable(document.getElementById(`${mode}-orders-body`), orders);

      const pendingOrders = await Api.listOrders(mode, 50, 'pending');
      renderPendingOrdersTable(document.getElementById(`${mode}-pending-orders-body`), pendingOrders, mode);
    } catch (err) {
      toast(`Failed to load ${mode} portfolio: ${err.message}`, 'error');
    }
  }

  // Real Trading's balance otherwise only syncs from the live exchange as a side effect of
  // actually placing an order — this fetches it on demand (read-only, no order placed) so a
  // freshly saved API key/Token shows a real balance immediately instead of $0 until the first
  // trade attempt. `quiet` suppresses the error toast for the auto-sync-after-saving-credentials
  // call site, where currentAsset might not be on the same exchange as what was just configured.
  async function refreshRealBalance({ quiet = false } = {}) {
    try {
      // fetchBalance() reads every currency in the wallet in one call; the sync-balance
      // controller persists both the position-sizing-scoped number and the full breakdown, so
      // refreshPortfolio('real') below (which re-renders Wallet Balances from that same DB row)
      // is the only render this needs to trigger.
      await Api.syncRealBalance(currentAsset.symbol, currentAsset.exchange);
      await refreshPortfolio('real');
      const quoteCurrency = currentAsset.symbol.split('/')[1] || '';
      if (!quiet) toast(`Real balance synced (${quoteCurrency} used for position sizing) — see Wallet Balances below for every currency.`, 'success');
    } catch (err) {
      if (!quiet) toast(`Failed to sync real balance: ${err.message}`, 'error');
    }
  }

  async function submitOrder(mode, side, stopLoss, takeProfit, qty, orderType, limitPrice, triggerPrice) {
    // qty is optional — omitted, the risk pipeline auto-sizes the position from Max Risk Per
    // Trade (the usual case); supplied, it trades that exact amount instead, still capped so it
    // can never risk more than that same max (see validate-trade.js's RISK_AMOUNT_TOO_LARGE).
    const estimatedValue = side === 'buy' && qty != null && lastPrice != null ? qty * lastPrice : null;
    const confirmation = await OrderConfirmation.show({
      mode, symbol: currentAsset.symbol, exchange: currentAsset.exchange, side,
      price: lastPrice, stopLoss: side === 'buy' ? stopLoss : null, takeProfit: side === 'buy' ? takeProfit : null,
      estimatedValue, orderType, limitPrice, triggerPrice,
    });
    if (!confirmation.confirmed) return;

    try {
      const body = { symbol: currentAsset.symbol, exchange: currentAsset.exchange, side, stopLoss, takeProfit, qty, orderType, limitPrice, triggerPrice };
      const result = mode === 'real'
        ? await Api.placeRealOrder({ ...body, confirmationText: confirmation.confirmationText })
        : await Api.placeDemoOrder(body);
      // OCO returns {takeProfitOrder, stopLossOrder} instead of a single order — a deliberate,
      // documented shape difference (see placeDemoOcoExit/placeRealOcoExit) since it genuinely
      // creates two linked orders, not one.
      if (result.takeProfitOrder) {
        toast('OCO placed: take-profit and stop-loss orders are both pending.', 'success');
      } else {
        toast(`Order ${result.status}`, result.status === 'rejected' ? 'error' : 'success');
      }
      await Promise.all([refreshPortfolio(mode), refreshStatusBar()]);
    } catch (err) {
      // Rejections come back as a thrown error with the reason in err.message (server-verified).
      toast(`Order rejected: ${err.message}`, 'error');
      await Promise.all([refreshPortfolio(mode), refreshStatusBar()]);
    }
  }

  // Shows/hides the Limit Price / Trigger Price fields based on the selected Order Type — pure
  // UI convenience; the backend is authoritative and rejects an invalid combination regardless
  // (e.g. MISSING_LIMIT_PRICE) if this ever gets out of sync with it.
  function updateOrderTypeFieldVisibility(form) {
    const orderType = form.orderType.value;
    form.querySelectorAll('.order-type-field[data-for]').forEach((label) => {
      const applicableTypes = label.dataset.for.split(',');
      label.hidden = !applicableTypes.includes(orderType);
    });
  }

  function initOrderForm(mode, formId) {
    const form = document.getElementById(formId);
    form.orderType.addEventListener('change', () => updateOrderTypeFieldVisibility(form));
    updateOrderTypeFieldVisibility(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (mode === 'real' && !ModeSwitcher.isRealUnlocked()) {
        toast('Unlock Real Trading first.', 'error');
        return;
      }
      const side = form.side.value;
      const orderType = form.orderType.value;
      const stopLoss = form.stopLoss.value ? Number(form.stopLoss.value) : undefined;
      const takeProfit = form.takeProfit.value ? Number(form.takeProfit.value) : undefined;
      const qty = form.qty.value ? Number(form.qty.value) : undefined;
      const limitPrice = form.limitPrice.value ? Number(form.limitPrice.value) : undefined;
      const triggerPrice = form.triggerPrice.value ? Number(form.triggerPrice.value) : undefined;
      await submitOrder(mode, side, stopLoss, takeProfit, qty, orderType, limitPrice, triggerPrice);
    });
  }

  // ---------- backtest ----------

  function renderBacktestResult(result) {
    const card = document.getElementById('backtest-results-card');
    card.hidden = false;
    const m = result.metrics;
    renderStatList(document.getElementById('backtest-metrics'), [
      ['Final equity', fmt(m.finalEquity)],
      ['Total P&L', `${fmt(m.totalPnl)} (${fmt(m.totalPnlPercent, 2)}%)`],
      ['Max drawdown', `${fmt(m.maxDrawdownPercent, 2)}%`],
      ['Trades', String(m.tradeCount)],
      ['Win rate', `${fmt(m.winRatePercent, 1)}%`],
      ['Profit factor', fmt(m.profitFactor, 2)],
      ['Avg win', fmt(m.avgWin)],
      ['Avg loss', fmt(m.avgLoss)],
    ]);

    if (!equityChart) equityChart = Charts.createLineChart('equity-chart');
    if (equityChart) equityChart.setPoints(result.equityCurve);

    const warnEl = document.getElementById('backtest-warnings');
    clear(warnEl);
    (result.warnings || []).forEach((w) => warnEl.appendChild(el('p', { class: 'hint' }, w)));
  }

  function initBacktestForm() {
    document.getElementById('backtest-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Running...';
      try {
        const result = await Api.runBacktest({
          symbol: currentAsset.symbol, exchange: currentAsset.exchange, timeframe: currentAsset.timeframe,
          start: new Date(form.start.value).toISOString(), end: new Date(form.end.value).toISOString(),
          initialCapital: Number(form.initialCapital.value), feePercent: Number(form.feePercent.value),
          slippagePercent: Number(form.slippagePercent.value),
          strategyId: form.strategyId.value,
          scoringConfig: pendingBacktestScoringConfig || undefined,
        });
        renderBacktestResult(result);
        toast('Backtest completed.', 'success');
      } catch (err) {
        toast(`Backtest failed: ${err.message}`, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Run Backtest';
        pendingBacktestScoringConfig = null;
        document.getElementById('backtest-applied-hint').textContent = '';
      }
    });
  }

  // ---------- strategy optimizer (hyperopt-lite) ----------

  function renderOptimizerResult(result) {
    const container = document.getElementById('optimizer-results');
    container.hidden = false;
    document.getElementById('optimizer-summary').textContent =
      `Ran ${result.combinationsRun} strategy/threshold combinations, ranked by ${result.rankBy}.`;
    document.getElementById('optimizer-disclaimer').textContent = result.disclaimer;

    const body = document.getElementById('optimizer-leaderboard-body');
    clear(body);
    result.leaderboard.slice(0, 10).forEach((entry, index) => {
      const m = entry.metrics;
      const row = el('tr', index === 0 ? { class: 'leaderboard-row--best' } : {});
      const pnlCell = el('td', {}, `${fmt(m.totalPnlPercent, 2)}%`);
      pnlCell.className = m.totalPnlPercent > 0 ? 'text-positive' : m.totalPnlPercent < 0 ? 'text-negative' : '';
      const applyBtn = el('button', { type: 'button' }, 'Apply');
      applyBtn.addEventListener('click', () => applyOptimizerResult(entry));
      const applyCell = el('td');
      applyCell.appendChild(applyBtn);
      row.append(
        el('td', {}, entry.strategyName || entry.strategyId),
        el('td', {}, fmt(entry.buyThreshold, 2)),
        el('td', {}, fmt(entry.sellThreshold, 2)),
        el('td', {}, String(m.tradeCount)),
        el('td', {}, `${fmt(m.winRatePercent, 1)}%`),
        pnlCell,
        el('td', {}, `${fmt(m.maxDrawdownPercent, 2)}%`),
        applyCell
      );
      body.appendChild(row);
    });
  }

  function applyOptimizerResult(entry) {
    const select = document.getElementById('backtest-strategy-select');
    if (select.querySelector(`option[value="${entry.strategyId}"]`)) select.value = entry.strategyId;
    pendingBacktestScoringConfig = { buyThreshold: entry.buyThreshold, sellThreshold: entry.sellThreshold };
    document.getElementById('backtest-applied-hint').textContent =
      `Applied: ${entry.strategyName || entry.strategyId} strategy with buy>=${fmt(entry.buyThreshold, 2)} / sell<=${fmt(entry.sellThreshold, 2)} thresholds. Click "Run Backtest" to use them.`;
    toast('Optimizer result applied to the backtest form.', 'success');
  }

  function initOptimizer() {
    document.getElementById('run-optimizer-btn').addEventListener('click', async () => {
      const form = document.getElementById('backtest-form');
      if (!form.start.value || !form.end.value) {
        toast('Set a start and end date on the backtest form first.', 'error');
        return;
      }
      const btn = document.getElementById('run-optimizer-btn');
      btn.disabled = true;
      btn.textContent = 'Optimizing...';
      try {
        const result = await Api.runOptimizer({
          symbol: currentAsset.symbol, exchange: currentAsset.exchange, timeframe: currentAsset.timeframe,
          start: new Date(form.start.value).toISOString(), end: new Date(form.end.value).toISOString(),
          initialCapital: Number(form.initialCapital.value), feePercent: Number(form.feePercent.value),
          slippagePercent: Number(form.slippagePercent.value),
        });
        renderOptimizerResult(result);
        toast('Optimizer run completed.', 'success');
      } catch (err) {
        toast(`Optimizer failed: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run Optimizer';
      }
    });
  }

  // ---------- persistent status bar (always visible, independent of active tab) ----------

  async function refreshStatusBar() {
    const mode = ModeSwitcher.getMode();
    try {
      const [portfolio, status] = await Promise.all([Api.getPortfolio(mode), Api.getSystemStatus()]);

      document.getElementById('status-balance').textContent = fmt(portfolio.balance);

      const netPnl = portfolio.pnl ? portfolio.pnl.netPnl : null;
      const netPnlEl = document.getElementById('status-net-pnl');
      netPnlEl.textContent = netPnl === null ? '-' : fmt(netPnl);
      netPnlEl.className = `status-bar__value ${netPnl > 0 ? 'text-positive' : netPnl < 0 ? 'text-negative' : ''}`;

      document.getElementById('status-open-positions').textContent = String(portfolio.openPositions.length);

      const globalStopped = !!status.emergencyStop?.global?.active;
      const modeStopped = !!status.emergencyStop?.[mode]?.active;
      const emergencyEl = document.getElementById('status-emergency');
      if (globalStopped) {
        emergencyEl.textContent = '🔴 STOPPED (global)';
        emergencyEl.className = 'status-bar__value status-emergency--stopped';
      } else if (modeStopped) {
        emergencyEl.textContent = `🔴 STOPPED (${mode})`;
        emergencyEl.className = 'status-bar__value status-emergency--stopped';
      } else {
        emergencyEl.textContent = '🟢 Active';
        emergencyEl.className = 'status-bar__value status-emergency--active';
      }
    } catch (err) {
      // Non-critical, always-on background refresh — don't spam toasts on transient failures.
    }
  }

  // ---------- risk settings ----------

  async function loadRiskSettings(mode) {
    document.getElementById('risk-mode-badge').textContent = mode.toUpperCase();
    document.getElementById('risk-mode-badge').className = `mode-badge mode-badge--${mode}`;
    try {
      const settings = await Api.getRiskSettings(mode);
      const form = document.getElementById('risk-settings-form');
      form.maxRiskPerTradePercent.value = settings.max_risk_per_trade_percent;
      form.maxDailyLossPercent.value = settings.max_daily_loss_percent;
      form.maxOpenPositions.value = settings.max_open_positions;
      form.maxOrderValue.value = settings.max_order_value;
      form.minRiskRewardRatio.value = settings.min_risk_reward_ratio;
      form.maxPortfolioExposurePercent.value = settings.max_portfolio_exposure_percent;
    } catch (err) {
      toast(`Failed to load risk settings: ${err.message}`, 'error');
    }
  }

  function initRiskSettingsForm() {
    document.getElementById('risk-settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const mode = ModeSwitcher.getMode();
      try {
        await Api.updateRiskSettings(mode, {
          maxRiskPerTradePercent: Number(form.maxRiskPerTradePercent.value),
          maxDailyLossPercent: Number(form.maxDailyLossPercent.value),
          maxOpenPositions: Number(form.maxOpenPositions.value),
          maxOrderValue: Number(form.maxOrderValue.value),
          minRiskRewardRatio: Number(form.minRiskRewardRatio.value),
          maxPortfolioExposurePercent: Number(form.maxPortfolioExposurePercent.value),
        });
        toast('Risk settings saved.', 'success');
      } catch (err) {
        toast(`Failed to save risk settings: ${err.message}`, 'error');
      }
    });
  }

  // ---------- emergency stop ----------

  function initEmergencyControls() {
    document.querySelectorAll('.emergency-controls button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { action, scope } = btn.dataset;
        try {
          if (action === 'stop') {
            await Api.triggerEmergencyStop(scope, 'Triggered from dashboard.');
            toast(`Emergency stop ACTIVATED (${scope}).`, 'error');
          } else {
            await Api.resetEmergencyStop(scope);
            toast(`Emergency stop RESET (${scope}).`, 'success');
          }
          refreshSystemStatus();
          refreshStatusBar();
        } catch (err) {
          toast(`Emergency stop action failed: ${err.message}`, 'error');
        }
      });
    });
  }

  // ---------- system / logs ----------

  async function refreshSystemStatus() {
    try {
      const status = await Api.getSystemStatus();
      document.getElementById('system-status-output').textContent = JSON.stringify(status, null, 2);
    } catch (err) {
      toast(`Failed to load system status: ${err.message}`, 'error');
    }
  }

  async function refreshLogs() {
    try {
      const logs = await Api.getLogs(50);
      const body = document.getElementById('logs-body');
      clear(body);
      logs.forEach((log) => {
        const row = el('tr');
        row.append(
          el('td', {}, formatTimestamp(log.created_at_utc)), el('td', {}, log.level), el('td', {}, log.mode || ''),
          el('td', {}, log.category || ''), el('td', {}, log.message)
        );
        body.appendChild(row);
      });
    } catch (err) {
      toast(`Failed to load logs: ${err.message}`, 'error');
    }
  }

  // ---------- init ----------

  function init() {
    initTabs();
    ModeSwitcher.init();
    ModeSwitcher.onChange((mode) => { loadRiskSettings(mode); refreshStatusBar(); });

    document.getElementById('load-asset-btn').addEventListener('click', loadAsset);
    document.getElementById('try-tradingview-btn').addEventListener('click', loadTradingViewChart);
    document.getElementById('use-builtin-chart-btn').addEventListener('click', loadBuiltinChart);
    document.getElementById('generate-signal-btn').addEventListener('click', generateSignal);
    document.getElementById('generate-watchlist-signals-btn').addEventListener('click', generateSignalsForWatchlist);
    document.getElementById('add-watchlist-btn').addEventListener('click', addCurrentAssetToWatchlist);
    document.getElementById('enable-all-autotrade-btn').addEventListener('click', enableAutoTradeForAll);

    const symbolInput = document.getElementById('symbol-input');
    const symbolSuggestionsList = document.getElementById('symbol-suggestions-list');
    symbolInput.addEventListener('input', (e) => showSymbolSuggestions(e.target.value));
    // Show the *full* list on focus rather than filtering by whatever's already in the field —
    // the field usually already holds a committed value (e.g. pre-filled "BTC/USDT"), and
    // filtering by that on focus would show only near-matches instead of letting the user
    // browse everything, which was the exact symptom of an earlier bug report.
    symbolInput.addEventListener('focus', () => showSymbolSuggestions(''));
    symbolInput.addEventListener('blur', hideSymbolSuggestions);
    // Selecting a suggestion is a mousedown (not click) that preventDefault()s, so it fires
    // *before* the input's blur — otherwise blur would hide the list first and the tap/click on
    // a now-hidden <li> would never register (the classic "datalist workaround" pitfall, and a
    // common source of "nothing happens when I tap it" reports on touch browsers).
    symbolSuggestionsList.addEventListener('mousedown', (e) => e.preventDefault());
    symbolSuggestionsList.addEventListener('click', (e) => {
      if (e.target.tagName !== 'LI') return;
      symbolInput.value = e.target.textContent;
      hideSymbolSuggestions();
    });
    document.getElementById('unlock-real-btn').addEventListener('click', () => {
      const phrase = document.getElementById('unlock-phrase-input').value;
      const result = ModeSwitcher.unlockReal(phrase);
      const statusEl = document.getElementById('real-server-status');
      if (!result.ok) {
        statusEl.textContent = result.message;
        statusEl.className = 'hint text-negative';
      } else {
        statusEl.textContent = '';
        toast('Real Trading unlocked for this session.', 'success');
      }
    });

    initOrderForm('demo', 'demo-order-form');
    initOrderForm('real', 'real-order-form');
    initBacktestForm();
    initOptimizer();
    initRiskSettingsForm();
    initEmergencyControls();
    initRealCredentialsForm();
    document.getElementById('refresh-real-balance-btn').addEventListener('click', () => refreshRealBalance());

    document.getElementById('refresh-system-btn').addEventListener('click', refreshSystemStatus);
    document.getElementById('refresh-logs-btn').addEventListener('click', refreshLogs);

    document.getElementById('exchange-input').addEventListener('change', refreshSymbolSuggestions);
    loadStrategyOptions().then(() => loadExchangeOptions().then(() => Promise.all([loadAsset(), refreshSymbolSuggestions()])).then(refreshSpotWatchlist));
    loadRealCredentialsExchangeOptions().then(refreshRealCredentialsStatus);
    loadRiskSettings(ModeSwitcher.getMode());
    refreshStatusBar();

    // Light polling so prices/indicators don't go stale while the dashboard tab is open.
    setInterval(() => {
      if (document.getElementById('tab-dashboard').classList.contains('tab-panel--active')) {
        loadMarketData();
      }
    }, 30_000);

    // Status bar is always visible regardless of active tab, so it polls independently.
    setInterval(refreshStatusBar, 15_000);
  }

  window.Dashboard = { init, switchToTab };
})();
