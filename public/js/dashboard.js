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

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (children.length === 1 && (typeof children[0] === 'string' || typeof children[0] === 'number')) {
      node.textContent = String(children[0]);
    } else {
      for (const child of children) {
        if (child == null) continue;
        if (child instanceof Node) {
          node.appendChild(child);
        } else {
          node.appendChild(document.createTextNode(String(child)));
        }
      }
    }
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

    if (tabName === 'dashboard') refreshWatchList();
    if (tabName === 'demo') { refreshPortfolio('demo'); Futures.refreshPortfolio('demo'); }
    if (tabName === 'real') {
      refreshPortfolio('real');
      if (ModeSwitcher.isRealUnlocked()) Futures.refreshPortfolio('real');
    }
    if (tabName === 'watchlist') { refreshSpotWatchlist(); Futures.refreshBothWatchlists(); }
    if (tabName === 'backtest') { loadAutoPilotMatrix(); }
    if (tabName === 'statistics') refreshStatistics();
    if (tabName === 'risk') { loadRiskSettings(ModeSwitcher.getMode()); loadFuturesRiskSettings(ModeSwitcher.getMode()); }
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
    await Promise.all([loadMarketData(), loadChart(), loadIndicators(), loadFundamentals()]);
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

  const POPULAR_MAJORS = [
    'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'SUI',
    'PEPE', 'NEAR', 'DOT', 'LTC', 'BCH', 'SHIB', 'TRX', 'UNI', 'APT', 'FET',
    'RENDER', 'TAO', 'INJ', 'ATOM', 'FIL', 'ARB', 'OP', 'POL', 'XLM', 'KAS'
  ];

  function filterAndRankSymbols(symbols, filterText) {
    const query = (filterText || '').trim().toUpperCase();

    if (!query) {
      // Empty input: prioritize top major cryptocurrencies, then return the rest
      const majors = [];
      const others = [];
      const seen = new Set();

      for (const major of POPULAR_MAJORS) {
        for (const s of symbols) {
          const base = s.split('/')[0].toUpperCase();
          if (base === major && !seen.has(s)) {
            majors.push(s);
            seen.add(s);
          }
        }
      }

      for (const s of symbols) {
        if (!seen.has(s)) {
          others.push(s);
        }
      }
      return majors.concat(others).slice(0, 30);
    }

    // Query provided: multi-tier relevance ranking
    // Tier 1: Base currency exactly matches query (e.g. "SOL" -> "SOL/USDT")
    // Tier 2: Base currency starts with query (e.g. "S" -> "SOL/USDT", "SUI/USDT", "SHIB/USDT")
    // Tier 3: Base currency contains query (e.g. "OL" -> "SOL/USDT")
    // Tier 4: Pair contains query anywhere (e.g. quote currency or slash matches "USDC")
    const tier1 = [];
    const tier2 = [];
    const tier3 = [];
    const tier4 = [];

    for (const s of symbols) {
      const upper = s.toUpperCase();
      const base = (upper.split('/')[0] || '').trim();

      if (base === query) {
        tier1.push(s);
      } else if (base.startsWith(query)) {
        tier2.push(s);
      } else if (base.includes(query)) {
        tier3.push(s);
      } else if (upper.includes(query)) {
        tier4.push(s);
      }
    }

    // Within Tier 2 and Tier 3, prioritize popular coins
    const rankWithMajors = (list) => {
      return list.sort((a, b) => {
        const baseA = a.split('/')[0].toUpperCase();
        const baseB = b.split('/')[0].toUpperCase();
        const idxA = POPULAR_MAJORS.indexOf(baseA);
        const idxB = POPULAR_MAJORS.indexOf(baseB);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    };

    const sortedTier2 = rankWithMajors(tier2);
    const sortedTier3 = rankWithMajors(tier3);

    return [...tier1, ...sortedTier2, ...sortedTier3, ...tier4].slice(0, 30);
  }

  function showSymbolSuggestions(filterText) {
    const list = document.getElementById('symbol-suggestions-list');
    clear(list);
    const matches = filterAndRankSymbols(symbolSuggestionsCache, filterText);
    if (matches.length === 0) {
      hideSymbolSuggestions();
      return;
    }
    matches.forEach((symbol) => list.appendChild(el('li', {}, symbol)));
    list.hidden = false;
  }


  // ---------- WatchList tab (lightweight tracking list, separate from Signals Setting below) ----------

  let watchlistItemsCache = [];

  async function refreshWatchList() {
    const body = document.getElementById('watchlist-body');
    const emptyEl = document.getElementById('watchlist-empty');
    try {
      watchlistItemsCache = await Api.listWatchlist();
      clear(body);
      emptyEl.hidden = watchlistItemsCache.length > 0;

      watchlistItemsCache.forEach((item, index) => {
        const row = el('tr');
        row.appendChild(el('td', { class: 'cmc-rank' }, String(index + 1)));

        const symbolCell = el('td');
        const symbolWrap = el('div', { class: 'cmc-symbol-cell' });
        symbolWrap.appendChild(symbolAvatar(item.symbol));
        symbolWrap.appendChild(el('span', { class: 'cmc-symbol-name' }, item.symbol));
        symbolCell.appendChild(symbolWrap);
        row.appendChild(symbolCell);

        // Live price/24h % — same fire-and-forget per-row fetch as refreshSpotWatchlist below.
        const priceCell = el('td', { class: 'cmc-price' }, '…');
        const changeCell = el('td');
        row.appendChild(priceCell);
        row.appendChild(changeCell);
        Api.getMarketData(item.symbol, item.exchange).then((snapshot) => {
          priceCell.textContent = fmtPrice(snapshot.price);
          clear(changeCell);
          changeCell.appendChild(changeBadge(snapshot.changePercent24h));
        }).catch(() => {
          priceCell.textContent = '-';
        });

        row.appendChild(el('td', {}, item.exchange));
        row.appendChild(el('td', {}, item.asset_type));

        const promoteBtn = el('button', { type: 'button' }, 'Add to Signals Setting');
        promoteBtn.title = 'Adds this asset to Spot Signals Setting plus Demo & Real Futures Signals Setting (1h timeframe, default strategy, 3x leverage).';
        promoteBtn.addEventListener('click', async () => {
          promoteBtn.disabled = true;
          try {
            const result = await Api.promoteWatchlistItem(item.symbol, item.exchange);
            toast(`${item.symbol} — spot: ${result.spot}${result.demoFutures ? `; demo futures: ${result.demoFutures}` : ''}${result.realFutures ? `; real futures: ${result.realFutures}` : ''}`, 'success');
            await refreshSpotWatchlist();
            await Futures.refreshBothWatchlists();
          } catch (err) {
            toast(`Failed to add ${item.symbol} to Signals Setting: ${err.message}`, 'error');
          } finally {
            promoteBtn.disabled = false;
          }
        });
        const promoteCell = el('td');
        promoteCell.appendChild(promoteBtn);
        row.appendChild(promoteCell);

        const removeBtn = el('button', { type: 'button' }, 'Remove');
        removeBtn.addEventListener('click', async () => {
          try {
            await Api.removeFromWatchlist(item.symbol, item.exchange);
            await refreshWatchList();
          } catch (err) {
            toast(`Failed to remove: ${err.message}`, 'error');
          }
        });
        const removeCell = el('td');
        removeCell.appendChild(removeBtn);
        row.appendChild(removeCell);

        const chartBtn = el('button', { type: 'button' }, 'Chart');
        chartBtn.title = 'Load this asset into the Market Data / Chart / Technical Analysis cards below.';
        chartBtn.addEventListener('click', async () => {
          loadAssetInto(item);
          await loadAsset();
          document.getElementById('price-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        const chartCell = el('td');
        chartCell.appendChild(chartBtn);
        row.appendChild(chartCell);

        body.appendChild(row);
      });
    } catch (err) {
      toast(`Failed to load WatchList: ${err.message}`, 'error');
    }
  }

  async function addAssetToWatchList() {
    const symbol = document.getElementById('symbol-input').value.trim();
    const exchange = document.getElementById('exchange-input').value.trim().toLowerCase();
    const assetType = document.getElementById('asset-type-input').value;
    if (!symbol || !exchange) {
      toast('Symbol and exchange are required.', 'error');
      return;
    }
    try {
      await Api.addToWatchlist({ symbol, exchange, assetType });
      toast(`${symbol} added to WatchList.`, 'success');
      await refreshWatchList();
    } catch (err) {
      toast(`Failed to add to WatchList: ${err.message}`, 'error');
    }
  }

  // ---------- spot Signals Setting (Signals Setting tab) ----------

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
        row.appendChild(exchangeCell);
        row.appendChild(el('td', {}, asset.asset_type || '-'));

        const isAutoPilot = !!asset.autopilot_enabled;
        const isAutoTimeframe = isAutoPilot || asset.timeframe_mode === 'auto';

        const timeframeSelect = el('select');
        TIMEFRAME_OPTIONS.forEach((tf) => {
          const opt = el('option', { value: tf }, tf);
          if (tf === (asset.default_timeframe || '1h')) opt.setAttribute('selected', 'selected');
          timeframeSelect.appendChild(opt);
        });
        timeframeSelect.disabled = isAutoTimeframe;
        timeframeSelect.title = 'Also used by AI Auto-Trade — changing it changes which candle timeframe the auto-trader analyzes for this asset.';
        timeframeSelect.addEventListener('change', async () => {
          try {
            await Api.setAssetTimeframe(asset.symbol, asset.exchange, timeframeSelect.value);
            toast(`Timeframe updated for ${asset.symbol} (used by AI Auto-Trade too).`, 'success');
          } catch (err) {
            toast(`Failed to update timeframe: ${err.message}`, 'error');
          }
        });

        const timeframeAutoCheckbox = el('input', { type: 'checkbox' });
        timeframeAutoCheckbox.checked = isAutoTimeframe;
        timeframeAutoCheckbox.disabled = isAutoPilot;
        timeframeAutoCheckbox.title = isAutoPilot
          ? '🚀 AI Full AutoPilot automatically selects the optimal timeframe'
          : 'Auto: let AI periodically evaluate and pick the highest win-rate timeframe (15m, 1h, 4h)';

        timeframeAutoCheckbox.addEventListener('change', async () => {
          const useAuto = timeframeAutoCheckbox.checked;
          try {
            await Api.setAssetTimeframeMode(asset.symbol, asset.exchange, useAuto ? 'auto' : 'manual');
            asset.timeframe_mode = useAuto ? 'auto' : 'manual';
            timeframeSelect.disabled = useAuto;
            toast(useAuto ? `Auto-timeframe enabled for ${asset.symbol}.` : `Manual timeframe set for ${asset.symbol}.`, 'success');
          } catch (err) {
            timeframeAutoCheckbox.checked = !useAuto;
            toast(`Failed to update timeframe mode: ${err.message}`, 'error');
          }
        });

        const timeframeCell = el('td', { class: 'timeframe-cell' });
        if (asset.strategy_id === LSR_STRATEGY_ID) {
          timeframeCell.appendChild(buildLsrTimeframeCell(asset, (mode) => Api.setAssetLsrTimeframeMode(asset.symbol, asset.exchange, mode)));
        } else {
          const timeframeWrap = el('div', { class: 'timeframe-cell-wrap' });
          timeframeWrap.appendChild(timeframeSelect);
          timeframeWrap.appendChild(timeframeAutoCheckbox);
          timeframeWrap.appendChild(el('span', { class: 'timeframe-auto-label' }, ' auto'));
          timeframeCell.appendChild(timeframeWrap);
        }
        row.appendChild(timeframeCell);

        const autopilotCheckbox = el('input', { type: 'checkbox', class: 'autopilot-toggle' });
        autopilotCheckbox.checked = isAutoPilot;
        autopilotCheckbox.title = '🚀 AI Full AutoPilot: automatically sets Strategy (AI Auto-Select), Timeframe (AI Auto-Timeframe), Trailing Stop (Live ATR), Adaptive TP, and Auto-Trading.';
        autopilotCheckbox.addEventListener('change', async () => {
          try {
            await Api.setAssetAutopilot(asset.symbol, asset.exchange, autopilotCheckbox.checked);
            toast(autopilotCheckbox.checked ? `🚀 AutoPilot activated for ${asset.symbol}!` : `AutoPilot deactivated for ${asset.symbol}.`, 'success');
            await refreshSpotWatchlist();
          } catch (err) {
            autopilotCheckbox.checked = !autopilotCheckbox.checked;
            toast(`Failed to update AutoPilot: ${err.message}`, 'error');
          }
        });
        const autopilotCell = el('td', { class: 'autopilot-cell' });
        const autopilotWrap = el('div', { class: 'autopilot-cell-wrap' });
        autopilotWrap.appendChild(autopilotCheckbox);
        if (isAutoPilot) {
          autopilotWrap.appendChild(el('span', { class: 'autopilot-badge' }, 'AUTO'));
        }
        autopilotCell.appendChild(autopilotWrap);
        row.appendChild(autopilotCell);

        const strategyCell = el('td');
        if (asset.strategy_mode === 'auto') {
          strategyCell.appendChild(buildAutoStrategySummary(asset));
        } else {
          const strategySelect = el('select');
          if (isAutoPilot) strategySelect.disabled = true;
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

        // Default trailing-stop distance for a position opened from this asset (manually via
        // "Trade from Signal", or by AI Auto-Trade) — blank/0 means off. Saved on blur, not on
        // every keystroke, matching a plain number input's natural change-commit point.
        // "Auto" opts into an ATR-based distance recomputed fresh each time a position opens
        // (see risk/atr-trailing.js) instead of this fixed number.
        const trailingInput = el('input', { type: 'number', step: 'any', min: '0', max: '100', placeholder: 'off' });
        if (asset.trailing_percent != null) trailingInput.value = String(asset.trailing_percent);
        trailingInput.title = 'Trailing-stop % this asset\'s positions use by default (manual "Trade from Signal" and AI Auto-Trade). Leave blank to trade with a fixed stop-loss instead.';
        const trailingAutoCheckbox = el('input', { type: 'checkbox' });
        trailingAutoCheckbox.checked = asset.trailing_mode === 'atr';
        trailingInput.disabled = trailingAutoCheckbox.checked || isAutoPilot;
        trailingAutoCheckbox.disabled = isAutoPilot;
        trailingAutoCheckbox.title = 'Auto: compute the trailing distance from live volatility (ATR) each time a position opens, instead of a fixed %.';

        function revertTrailingUi() {
          trailingAutoCheckbox.checked = asset.trailing_mode === 'atr';
          trailingInput.disabled = trailingAutoCheckbox.checked || isAutoPilot;
          trailingInput.value = asset.trailing_percent != null ? String(asset.trailing_percent) : '';
        }

        trailingInput.addEventListener('change', async () => {
          const value = trailingInput.value ? Number(trailingInput.value) : null;
          try {
            await Api.setAssetTrailingPercent(asset.symbol, asset.exchange, value, 'fixed');
            asset.trailing_percent = value;
            asset.trailing_mode = 'fixed';
            toast(value ? `Trailing stop set to ${value}% for ${asset.symbol}.` : `Trailing stop disabled for ${asset.symbol}.`, 'success');
          } catch (err) {
            revertTrailingUi();
            toast(`Failed to update trailing stop: ${err.message}`, 'error');
          }
        });
        trailingAutoCheckbox.addEventListener('change', async () => {
          const useAuto = trailingAutoCheckbox.checked;
          try {
            await Api.setAssetTrailingPercent(asset.symbol, asset.exchange, useAuto ? null : (trailingInput.value ? Number(trailingInput.value) : null), useAuto ? 'atr' : 'fixed');
            asset.trailing_mode = useAuto ? 'atr' : 'fixed';
            if (useAuto) asset.trailing_percent = null;
            trailingInput.disabled = useAuto;
            if (useAuto) trailingInput.value = '';
            toast(useAuto ? `Trailing stop set to auto (ATR-based) for ${asset.symbol}.` : `Trailing stop set to fixed for ${asset.symbol}.`, 'success');
          } catch (err) {
            revertTrailingUi();
            toast(`Failed to update trailing stop: ${err.message}`, 'error');
          }
        });
        const trailingCell = el('td', { class: 'trailing-cell' });
        const trailingWrap = el('div', { class: 'trailing-cell-wrap' });
        trailingWrap.appendChild(trailingInput);
        trailingWrap.appendChild(trailingAutoCheckbox);
        trailingWrap.appendChild(el('span', { class: 'trailing-auto-label' }, ' auto'));
        trailingCell.appendChild(trailingWrap);
        row.appendChild(trailingCell);

        const autoSelectCheckbox = el('input', { type: 'checkbox' });
        autoSelectCheckbox.checked = asset.strategy_mode === 'auto';
        autoSelectCheckbox.disabled = isAutoPilot;
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
        autoTradeCheckbox.disabled = isAutoPilot;
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

        // Real-money spot auto-trading — currently only actually acted on for the Liquidity
        // Sweep Reversal strategy (reversal-spot-auto-trader.js); a no-op for every other
        // strategy today, since the original AI auto-trader above is Demo-only by design.
        const realAutoTradeCheckbox = el('input', { type: 'checkbox' });
        realAutoTradeCheckbox.checked = !!asset.real_auto_trade_enabled;
        realAutoTradeCheckbox.title = 'Real-money auto-trading. Currently only takes effect for the "Liquidity Sweep Reversal" strategy — also requires ENABLE_SPOT_AUTO_TRADING on the server (a restart-only .env setting) and Real credentials configured for your account.';
        realAutoTradeCheckbox.addEventListener('change', async () => {
          try {
            const result = await Api.setRealAutoTrade(asset.symbol, asset.exchange, realAutoTradeCheckbox.checked);
            toast(result.message || `Real Auto-Trade ${realAutoTradeCheckbox.checked ? 'enabled' : 'disabled'} for ${asset.symbol}.`, 'success');
          } catch (err) {
            realAutoTradeCheckbox.checked = !realAutoTradeCheckbox.checked;
            toast(`Failed to update Real Auto-Trade: ${err.message}`, 'error');
          }
        });
        const realAutoTradeCell = el('td');
        realAutoTradeCell.appendChild(realAutoTradeCheckbox);
        row.appendChild(realAutoTradeCell);

        const adaptiveTpCheckbox = el('input', { type: 'checkbox' });
        adaptiveTpCheckbox.checked = !!asset.adaptive_tp_enabled;
        adaptiveTpCheckbox.disabled = isAutoPilot;
        adaptiveTpCheckbox.title = 'Adaptive Take-Profit: staged partial exits (TP1/TP2/TP3) sized by ATR/market structure, with trailing that only starts after TP1 fires — instead of one fixed take-profit. Only affects positions opened after this is enabled.';
        adaptiveTpCheckbox.addEventListener('change', async () => {
          try {
            await Api.setAssetAdaptiveTp(asset.symbol, asset.exchange, adaptiveTpCheckbox.checked);
            toast(`Adaptive Take-Profit ${adaptiveTpCheckbox.checked ? 'enabled' : 'disabled'} for ${asset.symbol}.`, 'success');
          } catch (err) {
            adaptiveTpCheckbox.checked = !adaptiveTpCheckbox.checked;
            toast(`Failed to update Adaptive Take-Profit: ${err.message}`, 'error');
          }
        });
        const adaptiveTpCell = el('td');
        adaptiveTpCell.appendChild(adaptiveTpCheckbox);
        row.appendChild(adaptiveTpCell);

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

  async function enableAutoPilotForAll() {
    if (watchlistCache.length === 0) {
      toast('Your Signals Setting is empty — add an asset first.', 'error');
      return;
    }
    const btn = document.getElementById('enable-all-autopilot-btn');
    if (btn) btn.disabled = true;
    let succeeded = 0;
    const failures = [];
    for (let i = 0; i < watchlistCache.length; i++) {
      const asset = watchlistCache[i];
      if (btn) btn.textContent = `Enabling... (${i + 1}/${watchlistCache.length})`;
      try {
        await Api.setAssetAutopilot(asset.symbol, asset.exchange, true);
        succeeded += 1;
      } catch (err) {
        failures.push(`${asset.symbol}@${asset.exchange}: ${err.message}`);
      }
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🚀 Enable AutoPilot for All';
    }
    await refreshSpotWatchlist();
    if (failures.length === 0) {
      toast(`🚀 AI Full AutoPilot enabled for all ${succeeded} Signals Setting asset(s).`, 'success');
    } else {
      toast(`AutoPilot enabled for ${succeeded}/${watchlistCache.length}. Failed: ${failures.join('; ')}`, 'error');
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
    marketRegime: 'Market Regime',
    sma: 'SMA(20)', ema: 'EMA(20)', rsi: 'RSI(14)', macd: 'MACD',
    bollingerBands: 'Bollinger Bands', atr: 'ATR(14)', stochastic: 'Stochastic',
    adx: 'ADX(14)', ichimoku: 'Ichimoku Cloud', supportResistance: 'Support / Resistance', volumeAnalysis: 'Volume',
  };

  function formatIndicatorValue(key, indicator) {
    if (indicator.status !== 'ok') return `NO_DATA (${indicator.status})`;
    if (key === 'marketRegime') {
      return `🧭 ${indicator.regimeName || indicator.regime} (${indicator.description || ''})`;
    }
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

  function strategyName(strategyId) {
    const strategy = strategiesCache.find((s) => s.id === strategyId);
    return strategy ? strategy.name : (strategyId || 'Balanced');
  }

  // Liquidity Sweep Reversal never goes through the normal signal engine — it trades directly off
  // its own dedicated scheduler (reversal-auto-trader.js / reversal-spot-auto-trader.js), which
  // never writes a row into the signals table (see strategies.js#scoringRejectionReason's server-
  // side twin of this constant). Once an asset is switched to LSR, the regular auto-trader also
  // stops generating signals for it (auto-trader.js's identical guard) — so the *last* signals-
  // table row for that symbol/exchange is a leftover from whatever strategy it had before the
  // switch, not something LSR produced. Showing that stale row next to "Liquidity Sweep Reversal"
  // in the Strategy column was actively misleading, so both loadLastWatchlistSignals() and
  // generateSignalsForWatchlist() special-case it below instead.
  const LSR_STRATEGY_ID = 'liquidity-sweep-reversal';
  const LSR_NOTICE = 'Trades directly via its own scheduler, not through this table — see Open Positions / Trade History.';

  // Read-only progress through LSR's Sweep -> Divergence -> CHOCH -> Retest -> Entry state
  // machine (see reversal-controller.js) — this is what "generate a signal" means for LSR, since
  // it never scores on demand the way the weighted strategies do. Falls back to the static
  // LSR_NOTICE if the live-status fetch itself fails (e.g. offline), rather than showing an error
  // for something that isn't actually broken. `tsUtc` is the close time of the most recently
  // processed candle (signal or entry timeframe, whichever is later) — how current this status
  // actually is, not "now" — null before the first cycle has processed any bar yet.
  async function buildLsrStatusNotice(asset) {
    try {
      const status = await Api.getReversalStatus(asset.symbol, asset.exchange, asset.market || 'spot', ModeSwitcher.getMode());
      return { label: status.label, tsUtc: status.asOfTsUtc || null };
    } catch {
      return { label: LSR_NOTICE, tsUtc: null };
    }
  }

  // Replaces the normal Timeframe <select> for an LSR-tagged asset row — default_timeframe has no
  // effect on LSR (it watches htf/signal/entry simultaneously, see live-engine.js), so showing that
  // control here would be silently inert. "Auto" opts this asset into lsr-timeframe-selector.js's
  // periodic backtest of a handful of candidate htf/signal/entry combos (mirrors the "🎯 Auto-
  // Select" strategy checkbox elsewhere in this table, but for timeframe instead of strategy).
  function buildLsrTimeframeCell(asset, apiSetMode) {
    const cell = el('div', { class: 'lsr-timeframe-cell-wrap' });
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = asset.lsr_timeframe_mode === 'auto';
    checkbox.title = 'Auto: periodically backtest a set of htf/signal/entry timeframe combinations for this LSR asset and use whichever ranks best, instead of the fixed 4h/15m/5m default.';
    const summary = el('span', { class: 'lsr-timeframe-summary' });

    function renderSummary() {
      if (asset.lsr_timeframe_mode === 'auto') {
        if (asset.lsr_selected_timeframes_json) {
          try {
            const tf = JSON.parse(asset.lsr_selected_timeframes_json);
            const updated = asset.lsr_timeframe_selection_updated_at_utc ? formatTimestamp(asset.lsr_timeframe_selection_updated_at_utc) : 'pending';
            summary.textContent = `Auto: ${tf.htfTimeframe}/${tf.signalTimeframe}/${tf.entryTimeframe} (${updated})`;
          } catch {
            summary.textContent = 'Auto: pending first selection';
          }
        } else {
          summary.textContent = 'Auto: pending first selection';
        }
      } else {
        const htf = asset.lsr_htf_timeframe, sig = asset.lsr_signal_timeframe, ent = asset.lsr_entry_timeframe;
        summary.textContent = (htf || sig || ent) ? `${htf || '4h'}/${sig || '15m'}/${ent || '5m'}` : 'Default: 4h/15m/5m';
      }
    }
    renderSummary();

    checkbox.addEventListener('change', async () => {
      const mode = checkbox.checked ? 'auto' : 'manual';
      try {
        await apiSetMode(mode);
        asset.lsr_timeframe_mode = mode;
        renderSummary();
        toast(`LSR auto timeframe ${mode === 'auto' ? 'enabled' : 'disabled'} for ${asset.symbol}.`, 'success');
      } catch (err) {
        checkbox.checked = !checkbox.checked;
        toast(`Failed to update LSR timeframe mode: ${err.message}`, 'error');
      }
    });

    cell.append(checkbox, el('span', {}, ' '), summary);
    return cell;
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
    // Most recently generated signal first; entries with no timestamp yet (error/notice rows,
    // or a slot not generated yet during generateSignalsForWatchlist's incremental fill) sort
    // to the bottom rather than scattering among timestamped rows. An LSR notice row carries its
    // own timestamp (noticeTsUtc — the last candle its live status was computed as of), so it
    // sorts by recency like every other row instead of always falling to the bottom.
    const sorted = [...results].sort((a, b) => {
      const tA = a.signal?.tsUtc ? Date.parse(a.signal.tsUtc) : a.noticeTsUtc ? Date.parse(a.noticeTsUtc) : -Infinity;
      const tB = b.signal?.tsUtc ? Date.parse(b.signal.tsUtc) : b.noticeTsUtc ? Date.parse(b.noticeTsUtc) : -Infinity;
      return tB - tA;
    });
    sorted.forEach(({ asset, signal, error, notice, noticeTsUtc }) => {
      const row = el('tr');
      row.append(
        el('td', {}, asset.symbol),
        el('td', {}, asset.market === 'futures' ? 'Futures' : 'Spot'),
        el('td', {}, asset.exchange),
        el('td', {}, strategyName(asset.strategy_id))
      );
      if (error || notice) {
        // `notice` (e.g. "no signal yet") is informational — muted, not styled as a failure the
        // way a genuine fetch/generate `error` is.
        const messageCell = notice ? el('td', { class: 'hint' }, notice) : el('td', { class: 'text-negative' }, `Error: ${error}`);
        const timeCell = el('td', {}, noticeTsUtc ? formatTimestamp(noticeTsUtc) : '-');
        row.append(timeCell, messageCell, el('td', {}, '-'), el('td', {}, '-'), el('td', {}, '-'), el('td', {}, '-'), el('td', {}, '-'));
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

  // Spot Signals Setting (watchlistCache, mode-agnostic — one shared list) plus the current
  // mode's Futures Signals Setting (Demo or Real are genuinely separate symbol lists — see
  // futures.js's header comment — so only whichever one matches ModeSwitcher.getMode() is
  // included). Fetched fresh from the API rather than reading Futures' own cache, so this stays
  // a read-only, additive query with no shared state between the two modules. Real is only
  // queried when unlocked — Api.listFuturesAssets('real') 403s otherwise.
  async function getSignalsSettingEntries() {
    const spotEntries = watchlistCache.map((asset) => ({ ...asset, market: 'spot' }));
    const mode = ModeSwitcher.getMode();
    if (mode === 'real' && !ModeSwitcher.isRealUnlocked()) return spotEntries;
    try {
      const futuresAssets = await Api.listFuturesAssets(mode);
      const futuresEntries = futuresAssets.map((asset) => ({ ...asset, market: 'futures', asset_type: 'crypto' }));
      return [...spotEntries, ...futuresEntries];
    } catch {
      return spotEntries; // futures list unavailable — still show spot results rather than nothing
    }
  }

  // Populates the Watchlist Signals table from each asset's most recently *persisted* signal
  // (every signal generated anywhere in the app — single-asset or batch — is saved to the
  // database, so this survives a page refresh even though the batch results themselves were
  // only ever held in memory). Called whenever the watchlist loads/changes, not just after
  // clicking "Generate for Watchlist", so a refresh shows the last known state instead of an
  // empty table.
  async function loadLastWatchlistSignals() {
    const entries = await getSignalsSettingEntries();
    if (entries.length === 0) {
      renderWatchlistSignalsTable([]);
      return;
    }
    const results = await Promise.all(entries.map(async (asset) => {
      if (asset.strategy_id === LSR_STRATEGY_ID) {
        const { label, tsUtc } = await buildLsrStatusNotice(asset);
        return { asset, notice: label, noticeTsUtc: tsUtc };
      }
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

  // Capped, not unbounded, concurrency: each analyzeSignal call does its own live exchange +
  // fundamentals fetch server-side, so firing every asset at once would just move the bottleneck
  // (and risks hammering the exchange). This is still a large win over the old one-at-a-time loop
  // since assets on different exchanges/symbols no longer wait on each other at all.
  const WATCHLIST_SIGNAL_CONCURRENCY = 5;

  async function generateSignalsForWatchlist() {
    const entries = await getSignalsSettingEntries();
    if (entries.length === 0) {
      toast('Your Signals Setting is empty — add an asset first.', 'error');
      return;
    }
    const btn = document.getElementById('generate-watchlist-signals-btn');
    btn.disabled = true;
    const mode = ModeSwitcher.getMode();
    const results = new Array(entries.length);
    let completed = 0;

    async function runOne(index) {
      const asset = entries[index];
      if (asset.strategy_id === LSR_STRATEGY_ID) {
        // Skip analyzeSignal entirely — the backend would just reject it (scoringRejectionReason)
        // since LSR isn't scoreable on demand. Show its live state-machine status instead of
        // surfacing that rejection as a batch "error" — see loadLastWatchlistSignals()'s identical handling.
        const { label, tsUtc } = await buildLsrStatusNotice(asset);
        results[index] = { asset, notice: label, noticeTsUtc: tsUtc };
      } else {
        try {
          const signal = await Api.analyzeSignal({
            symbol: asset.symbol, exchange: asset.exchange, timeframe: asset.default_timeframe,
            assetType: asset.asset_type, mode, strategyId: asset.strategy_id, market: asset.market,
          });
          results[index] = { asset, signal };
        } catch (err) {
          results[index] = { asset, error: err.message };
        }
      }
      completed += 1;
      btn.textContent = `Generating... (${completed}/${entries.length})`;
      renderWatchlistSignalsTable(results.filter(Boolean)); // render incrementally so progress is visible
    }

    // A small fixed-size worker pool: each worker pulls the next un-started index until none are
    // left, so at most WATCHLIST_SIGNAL_CONCURRENCY requests are in flight at once regardless of
    // watchlist size.
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < entries.length) {
        const index = nextIndex;
        nextIndex += 1;
        await runOne(index);
      }
    }
    const workerCount = Math.min(WATCHLIST_SIGNAL_CONCURRENCY, entries.length);
    await Promise.all(Array.from({ length: workerCount }, worker));

    btn.disabled = false;
    btn.textContent = 'Generate for Signals Setting';
    // LSR entries were never attempted (see above) — excluded from both counts so e.g. "3/3" means
    // 3 real generations succeeded, not 3-succeeded-plus-2-skipped-counted-as-5.
    const attempted = results.filter((r) => r.asset.strategy_id !== LSR_STRATEGY_ID);
    const succeeded = attempted.filter((r) => !r.error).length;
    toast(`Generated ${succeeded}/${attempted.length} signal(s).`, succeeded === attempted.length ? 'success' : 'error');
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

  // Which strategy/strategies opened this position — resolved server-side from the signal that
  // triggered it (see portfolio-service.js's describeStrategyIds enrichment). A combined signal
  // (auto-mode, majority vote across 2-3 strategies) shows every contributing strategy joined
  // with "+", with a tooltip breaking down how each one voted; a plain manual order with no linked
  // signal shows "-". Private copy, mirroring futures.js's identical helper — see this file's
  // established "deliberately not shared with futures.js" convention.
  function buildStrategyCell(p) {
    const cell = el('td');
    if (!p.strategies || p.strategies.length === 0) {
      cell.textContent = '-';
      cell.title = 'Not opened from a generated signal.';
      return cell;
    }
    cell.textContent = p.strategies.map((s) => s.name).join(' + ');
    if (p.combined_votes_json) {
      try {
        const votes = JSON.parse(p.combined_votes_json);
        cell.title = `Votes — ${Object.entries(votes).map(([id, vote]) => `${strategyName(id)}: ${vote}`).join(', ')}`;
      } catch {
        cell.title = 'Opened from a manually generated signal.';
      }
    } else {
      cell.title = 'Opened from a manually generated signal.';
    }
    return cell;
  }

  // The timeframe that led to this position's signal — private copy, mirroring futures.js's
  // identical helper (see its comment for the LSR composite-timeframe explanation).
  function buildTimeframeCell(p) {
    return el('td', {}, p.timeframe || '-');
  }

  // Full raw JSON for one position, hidden by default, toggled per-row by the "Raw" button built
  // in buildRawToggleCell — private copy, mirroring futures.js's identical helper.
  function buildRawRow(p, colSpan) {
    const row = el('tr', { class: 'position-raw-row' });
    row.hidden = true;
    const cell = el('td', { colspan: String(colSpan) });
    cell.appendChild(el('pre', { class: 'raw-output' }, JSON.stringify(p, null, 2)));
    row.appendChild(cell);
    return row;
  }

  function buildRawToggleCell(rawRow) {
    const cell = el('td');
    const btn = el('button', { type: 'button', class: 'raw-toggle-btn' }, 'Raw');
    btn.addEventListener('click', () => { rawRow.hidden = !rawRow.hidden; });
    cell.appendChild(btn);
    return cell;
  }

  const POSITION_TABLE_COLUMN_COUNT = 14; // Symbol..Adaptive TP (11) + Strategy + Timeframe + Raw-toggle

  // A trailing position's stop_loss is a live-ratcheted value, not the fixed number you set at
  // order time — the suffix + tooltip makes that visible instead of it looking identical to a
  // plain stop-loss. high-water-mark is the best price seen since entry it's trailing behind.
  function buildStopCell(p) {
    const cell = el('td', {}, fmtPrice(p.stop_loss));
    if (p.trailing_percent) {
      cell.appendChild(el('span', {}, ` (trailing ${fmt(p.trailing_percent, 2)}%)`));
      cell.title = `Trailing stop: ${fmt(p.trailing_percent, 2)}% behind the high-water mark of ${fmtPrice(p.trailing_high_water_mark)} — moves in your favor only, never loosens.`;
    }
    return cell;
  }

  function buildAdaptiveTpCell(p) {
    if (!p.adaptive_tp_enabled) {
      return el('td', { class: 'text-muted' }, '-');
    }

    const cell = el('td', { class: 'adaptive-tp-cell' });
    const container = el('div', { class: 'adaptive-tp-wrap' });

    let partialExits = [];
    if (p.partial_exits_json) {
      try {
        partialExits = typeof p.partial_exits_json === 'string' ? JSON.parse(p.partial_exits_json) : p.partial_exits_json;
      } catch {}
    }

    const tiers = [
      { num: 1, price: p.tp1_price, filledAt: p.tp1_filled_at_utc, fillPrice: p.tp1_fill_price, qtyPct: p.tp1_qty_percent },
      { num: 2, price: p.tp2_price, filledAt: p.tp2_filled_at_utc, fillPrice: p.tp2_fill_price, qtyPct: p.tp2_qty_percent },
      { num: 3, price: p.tp3_price, filledAt: p.tp3_filled_at_utc, fillPrice: p.tp3_fill_price, qtyPct: p.tp3_qty_percent },
    ];

    const tooltipLines = ['⚡ Adaptive Take-Profit Tiers:'];
    let hasAnyTier = false;

    tiers.forEach((t) => {
      if (t.price == null) return;
      hasAnyTier = true;
      const isFilled = Boolean(t.filledAt);
      const exitData = Array.isArray(partialExits) ? partialExits.find((pe) => pe.level === t.num) : null;
      const chip = el('span', {
        class: `tp-tier-chip ${isFilled ? 'tp-tier-chip--filled' : 'tp-tier-chip--pending'}`,
      });
      const checkmark = isFilled ? ' ✓' : '';
      chip.textContent = `T${t.num}: ${fmtPrice(t.price)}${checkmark}`;

      let tierTip = `TP${t.num}: ${fmtPrice(t.price)}`;
      if (t.qtyPct != null) tierTip += ` (${fmt(t.qtyPct, 0)}%)`;
      if (isFilled) {
        tierTip += ` [FILLED${t.fillPrice ? ' @ ' + fmtPrice(t.fillPrice) : ''}`;
        if (exitData && exitData.pnl != null) {
          tierTip += ` | PnL: ${exitData.pnl >= 0 ? '+' : ''}${fmt(exitData.pnl, 2)}`;
        }
        if (t.filledAt) {
          tierTip += ` on ${formatTimestamp(t.filledAt)}`;
        }
        tierTip += `]`;
      } else {
        tierTip += ` [Pending]`;
      }
      chip.title = tierTip;
      tooltipLines.push(tierTip);
      container.appendChild(chip);
    });

    if (!hasAnyTier) {
      return el('td', { class: 'text-muted' }, 'Active');
    }

    cell.appendChild(container);
    cell.title = tooltipLines.join('\n');
    return cell;
  }

  function renderPositionsTable(body, positions) {
    clear(body);
    positions.forEach((p) => {
      const row = el('tr');
      const unrealizedCell = el('td', {}, p.unrealizedPnl != null ? fmt(p.unrealizedPnl) : '-');
      if (p.unrealizedPnl > 0) unrealizedCell.className = 'text-positive';
      else if (p.unrealizedPnl < 0) unrealizedCell.className = 'text-negative';
      const rawRow = buildRawRow(p, POSITION_TABLE_COLUMN_COUNT);
      const initialStop = p.initial_stop_loss != null ? p.initial_stop_loss : p.stop_loss;
      row.append(
        el('td', {}, p.symbol), el('td', {}, p.exchange || '-'), el('td', {}, p.side), el('td', {}, fmt(p.qty, 6)),
        el('td', {}, fmtPrice(p.entry_price)), el('td', {}, p.currentPrice != null ? fmtPrice(p.currentPrice) : '-'),
        unrealizedCell, el('td', {}, fmtPrice(initialStop)), buildStopCell(p),
        el('td', {}, fmtPrice(p.take_profit)), buildAdaptiveTpCell(p),
        buildStrategyCell(p), buildTimeframeCell(p), buildRawToggleCell(rawRow)
      );
      body.appendChild(row);
      body.appendChild(rawRow);
    });
  }

  function orderTypeLabel(orderType) {
    return (orderType || 'market').replace('_', '-');
  }

  function renderOrdersTable(body, orders) {
    clear(body);
    orders.forEach((o) => {
      const row = el('tr');
      const strategyLabel = o.strategies && o.strategies.length > 0 ? o.strategies.map((s) => s.name).join(' + ') : '-';
      row.append(
        el('td', {}, formatTimestamp(o.created_at_utc)), el('td', {}, o.symbol || '-'), el('td', {}, orderTypeLabel(o.order_type)), el('td', {}, o.side),
        el('td', {}, strategyLabel), el('td', {}, o.timeframe || '-'), el('td', {}, fmt(o.qty, 6)),
        el('td', {}, fmtPrice(o.price)), el('td', {}, o.status), el('td', {}, o.reject_reason || '')
      );
      body.appendChild(row);
    });
  }

  // Human label for a closed position's exit_reason — see position-risk-watcher.js /
  // orders.js's `reason` convention this was written into the trades table with.
  const EXIT_REASON_LABELS = { stop_loss: 'Stop-loss', take_profit: 'Take-profit', signal: 'Signal', manual: 'Manual' };
  function exitReasonLabel(reason) {
    return EXIT_REASON_LABELS[reason] || (reason || '-');
  }

  // Complete round-trip trade history — every CLOSED position, most recent first, with which
  // strategy/timeframe opened it and its realized profit/loss (see portfolio-controller.js#getTradeHistory).
  // Initial SL/Initial Take are the risk levels the position was opened with (take-profit is
  // static — never trails — so this is always just t.take_profit, named to match Initial SL's
  // convention); Trailed SL is stop_loss as it stood at close time — identical to Initial SL
  // unless trailing ratcheted it — see positions-repository.js's initial_stop_loss comment for why
  // the two are stored separately.
  function renderTradeHistoryTable(body, emptyEl, trades) {
    clear(body);
    trades.forEach((t) => {
      const row = el('tr');
      const pnlCell = el('td', {}, t.realized_pnl != null ? fmt(t.realized_pnl) : '-');
      if (t.realized_pnl > 0) pnlCell.className = 'text-positive';
      else if (t.realized_pnl < 0) pnlCell.className = 'text-negative';
      const initialSl = t.initial_stop_loss != null ? t.initial_stop_loss : t.stop_loss;
      const trailedStop = t.trailing_percent != null ? fmtPrice(t.stop_loss) : '-';
      row.append(
        el('td', {}, formatTimestamp(t.opened_at_utc)), el('td', {}, formatTimestamp(t.closed_at_utc)),
        el('td', {}, t.symbol), el('td', {}, t.side), el('td', {}, strategyLabel), el('td', {}, t.timeframe || '-'),
        el('td', {}, fmt(t.qty, 6)), el('td', {}, fmtPrice(t.entry_price)),
        el('td', {}, fmtPrice(initialSl)), el('td', {}, trailedStop),
        el('td', {}, fmtPrice(t.take_profit)), buildAdaptiveTpCell(t),
        el('td', {}, fmtPrice(t.exit_price)), el('td', {}, exitReasonLabel(t.exit_reason)), pnlCell
      );
      body.appendChild(row);
    });
    if (emptyEl) emptyEl.hidden = trades.length > 0;
  }

  // ---------- statistics ----------

  function fmtWinRate(s) {
    if (s.winRatePercent == null) return '-';
    const breakevenSuffix = s.breakeven > 0 ? `/${s.breakeven}BE` : '';
    return `${fmt(s.winRatePercent, 1)}% (${s.wins}W/${s.losses}L${breakevenSuffix})`;
  }

  function fmtProfitFactor(pf) {
    if (pf === null || pf === undefined) return '-';
    if (typeof pf === 'string') return pf; // '∞' — server sends this instead of the number
    // Infinity, since JSON can't represent Infinity (it would silently become null).
    return fmt(pf, 2);
  }

  function pnlClassName(value) {
    return value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : '';
  }

  // One of the three top-of-tab summary dls (Demo total / Real total / Overall) — see
  // trading-statistics-service.js#summarize for the shape of `s`.
  function renderStatsSummary(container, s) {
    renderStatList(container, [
      ['Trades', String(s.count)],
      ['Win rate', fmtWinRate(s)],
      ['Realized P&L', fmt(s.totalRealizedPnl)],
      ['Profit factor', fmtProfitFactor(s.profitFactor)],
    ]);
    container.children[2].querySelector('dd').className = pnlClassName(s.totalRealizedPnl);
  }

  // Spot vs Futures rows for one mode (Demo or Real).
  function renderStatsMarketTable(body, rows) {
    clear(body);
    rows.forEach(({ label, ...s }) => {
      const row = el('tr');
      const pnlCell = el('td', {}, fmt(s.totalRealizedPnl));
      pnlCell.className = pnlClassName(s.totalRealizedPnl);
      row.append(
        el('td', {}, label), el('td', {}, String(s.count)), el('td', {}, String(s.wins)), el('td', {}, String(s.losses)),
        el('td', {}, String(s.breakeven)),
        el('td', {}, s.winRatePercent == null ? '-' : `${fmt(s.winRatePercent, 1)}%`),
        pnlCell,
        el('td', {}, s.avgWin == null ? '-' : fmt(s.avgWin)),
        el('td', {}, s.avgLoss == null ? '-' : fmt(s.avgLoss)),
        el('td', {}, fmtProfitFactor(s.profitFactor))
      );
      body.appendChild(row);
    });
  }

  // Per-strategy rows for one mode — a combined-vote trade is one row (its joined strategy names),
  // not split across component strategies (see trading-statistics-service.js#strategyGroupKey).
  function renderStatsStrategyTable(body, emptyEl, byStrategy) {
    clear(body);
    byStrategy.forEach((s) => {
      const row = el('tr');
      const pnlCell = el('td', {}, fmt(s.totalRealizedPnl));
      pnlCell.className = pnlClassName(s.totalRealizedPnl);
      row.append(
        el('td', {}, s.strategyName), el('td', {}, String(s.count)), el('td', {}, String(s.wins)), el('td', {}, String(s.losses)),
        el('td', {}, String(s.breakeven)),
        el('td', {}, s.winRatePercent == null ? '-' : `${fmt(s.winRatePercent, 1)}%`),
        pnlCell
      );
      body.appendChild(row);
    });
    if (emptyEl) emptyEl.hidden = byStrategy.length > 0;
  }

  async function refreshStatistics() {
    try {
      const stats = await Api.getTradingStatistics();

      renderStatsSummary(document.getElementById('stats-demo-total'), stats.demo.total);
      renderStatsSummary(document.getElementById('stats-real-total'), stats.real.total);
      renderStatsSummary(document.getElementById('stats-overall'), stats.overall);

      renderStatsMarketTable(document.getElementById('stats-demo-market-body'), [
        { label: 'Spot', ...stats.demo.spot }, { label: 'Futures', ...stats.demo.futures },
      ]);
      renderStatsMarketTable(document.getElementById('stats-real-market-body'), [
        { label: 'Spot', ...stats.real.spot }, { label: 'Futures', ...stats.real.futures },
      ]);

      renderStatsStrategyTable(document.getElementById('stats-demo-strategy-body'), document.getElementById('stats-demo-strategy-empty'), stats.demo.byStrategy);
      renderStatsStrategyTable(document.getElementById('stats-real-strategy-body'), document.getElementById('stats-real-strategy-empty'), stats.real.byStrategy);
    } catch (err) {
      toast(`Failed to load trading statistics: ${err.message}`, 'error');
    }
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

      const trades = await Api.getTradeHistory(mode, 50);
      renderTradeHistoryTable(document.getElementById(`${mode}-trade-history-body`), document.getElementById(`${mode}-trade-history-empty`), trades);
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

  async function submitOrder(mode, side, stopLoss, takeProfit, qty, orderType, limitPrice, triggerPrice, trailingPercent) {
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
      const body = { symbol: currentAsset.symbol, exchange: currentAsset.exchange, side, stopLoss, takeProfit, qty, orderType, limitPrice, triggerPrice, trailingPercent };
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
      const trailingPercent = form.trailingPercent.value ? Number(form.trailingPercent.value) : undefined;
      await submitOrder(mode, side, stopLoss, takeProfit, qty, orderType, limitPrice, triggerPrice, trailingPercent);
    });
  }

  // ---------- backtest ----------

  const BACKTEST_AUTO_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes = 900,000 ms
  let backtestAutoTimer = null;
  let backtestCountdownInterval = null;
  let nextBacktestRunTimestamp = 0;
  let isBacktestAutoEnabled = true;
  let isBacktestExecuting = false;

  function formatExitReason(reason) {
    const EXIT_LABELS = {
      take_profit: '🎯 Take Profit',
      stop_loss: '🛑 Stop Loss',
      end_of_backtest: '⏱️ End of Window',
      signal_change: '🔄 Signal Reversal',
      trailing_stop: '📈 Trailing Stop',
      adaptive_tp: '⚡ Adaptive TP',
    };
    return EXIT_LABELS[reason] || (reason ? reason.replace(/_/g, ' ') : '-');
  }

  function renderBacktestResult(result) {
    const card = document.getElementById('backtest-results-card');
    if (!card) return;
    card.hidden = false;
    const m = result.metrics || {};
    const trades = result.trades || [];
    const wins = trades.filter((t) => (t.pnl || 0) > 0).length;
    const losses = trades.filter((t) => (t.pnl || 0) < 0).length;
    const breakevens = trades.filter((t) => (t.pnl || 0) === 0).length;

    const bannerEl = document.getElementById('backtest-summary-banner');
    if (bannerEl) {
      const startStr = result.startUtc ? new Date(result.startUtc).toLocaleDateString() : '';
      const endStr = result.endUtc ? new Date(result.endUtc).toLocaleDateString() : '';
      bannerEl.textContent = `📊 ${result.symbol || currentAsset.symbol} @ ${result.exchange || currentAsset.exchange} (${result.timeframe || currentAsset.timeframe}) • Strategy: ${result.strategyName || result.strategyId || 'Default'} • Window: ${startStr} to ${endStr} • Capital: $${fmt(result.initialCapital || 10000)}`;
    }

    renderStatList(document.getElementById('backtest-metrics'), [
      ['Final equity', fmt(m.finalEquity)],
      ['Total P&L', `${fmt(m.totalPnl)} (${fmt(m.totalPnlPercent, 2)}%)`],
      ['Max drawdown', `${fmt(m.maxDrawdownPercent, 2)}%`],
      ['Total Trades', String(m.tradeCount ?? trades.length)],
      ['Wins / Losses', `${wins}W / ${losses}L (${breakevens}BE)`],
      ['Win rate', `${fmt(m.winRatePercent, 1)}%`],
      ['Profit factor', fmt(m.profitFactor, 2)],
      ['Avg win', fmt(m.avgWin)],
      ['Avg loss', fmt(m.avgLoss)],
    ]);

    if (!equityChart) equityChart = Charts.createLineChart('equity-chart');
    if (equityChart && result.equityCurve) equityChart.setPoints(result.equityCurve);

    const warnEl = document.getElementById('backtest-warnings');
    if (warnEl) {
      clear(warnEl);
      (result.warnings || []).forEach((w) => warnEl.appendChild(el('p', { class: 'hint' }, w)));
    }

    // Render complete executed trades list
    const tradesCountEl = document.getElementById('backtest-trades-count');
    if (tradesCountEl) tradesCountEl.textContent = String(trades.length);

    const tradesBody = document.getElementById('backtest-trades-body');
    if (tradesBody) {
      clear(tradesBody);
      if (trades.length === 0) {
        const emptyRow = el('tr');
        emptyRow.appendChild(el('td', { colspan: '10', class: 'empty-state' }, 'No trades triggered during this backtest period.'));
        tradesBody.appendChild(emptyRow);
      } else {
        trades.forEach((t, index) => {
          const row = el('tr');
          row.appendChild(el('td', { class: 'cmc-rank' }, String(index + 1)));
          row.appendChild(el('td', {}, t.enteredAtUtc ? formatTimestamp(t.enteredAtUtc) : '-'));
          row.appendChild(el('td', {}, t.exitedAtUtc ? formatTimestamp(t.exitedAtUtc) : '-'));

          const sideCell = el('td');
          const isBuy = (t.side || 'BUY').toUpperCase() === 'BUY';
          const sideBadge = el('span', {
            class: 'badge',
            style: isBuy
              ? 'background: rgba(34, 197, 94, 0.15); color: #22c55e; border-color: rgba(34, 197, 94, 0.4); font-weight: 700;'
              : 'background: rgba(239, 68, 68, 0.15); color: #ef4444; border-color: rgba(239, 68, 68, 0.4); font-weight: 700;'
          }, t.side || 'BUY');
          sideCell.appendChild(sideBadge);
          row.appendChild(sideCell);

          row.appendChild(el('td', {}, fmt(t.qty, 4)));
          row.appendChild(el('td', {}, fmtPrice(t.entryPrice)));
          row.appendChild(el('td', {}, fmtPrice(t.exitPrice)));

          const pnlVal = t.pnl || 0;
          const pnlCell = el('td', {
            class: pnlVal > 0 ? 'text-positive' : pnlVal < 0 ? 'text-negative' : ''
          }, `${pnlVal >= 0 ? '+' : ''}${fmt(pnlVal, 2)}`);
          row.appendChild(pnlCell);

          const pnlPercent = t.entryPrice ? ((t.exitPrice - t.entryPrice) / t.entryPrice * 100 * (t.side === 'SELL' ? -1 : 1)) : 0;
          const pnlPctCell = el('td', {
            class: pnlPercent > 0 ? 'text-positive' : pnlPercent < 0 ? 'text-negative' : ''
          }, `${pnlPercent >= 0 ? '+' : ''}${fmt(pnlPercent, 2)}%`);
          row.appendChild(pnlPctCell);

          row.appendChild(el('td', {}, formatExitReason(t.exitReason)));
          tradesBody.appendChild(row);
        });
      }
    }
  }

  async function executeBacktest({ isAuto = false } = {}) {
    if (isBacktestExecuting) return;
    const form = document.getElementById('backtest-form');
    if (!form) return;

    ensureBacktestFormDefaults(form);

    const submitBtn = form.querySelector('button[type="submit"]');
    const runNowBtn = document.getElementById('backtest-run-now-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Running...';
    }
    if (runNowBtn) {
      runNowBtn.disabled = true;
      runNowBtn.textContent = 'Running...';
    }
    isBacktestExecuting = true;

    try {
      const result = await Api.runBacktest({
        symbol: currentAsset.symbol,
        exchange: currentAsset.exchange,
        timeframe: currentAsset.timeframe,
        start: new Date(form.start.value).toISOString(),
        end: new Date(form.end.value).toISOString(),
        initialCapital: Number(form.initialCapital.value) || 10000,
        feePercent: Number(form.feePercent.value) || 0.1,
        slippagePercent: Number(form.slippagePercent.value) || 0.05,
        strategyId: form.strategyId.value || 'balanced',
        scoringConfig: pendingBacktestScoringConfig || undefined,
      });

      renderBacktestResult(result);
      const timeStr = new Date().toLocaleTimeString('en-GB');
      const lastRunEl = document.getElementById('backtest-last-run-info');
      if (lastRunEl) {
        lastRunEl.textContent = `Last execution: ${timeStr} (${result.symbol} • ${result.trades?.length || 0} trades evaluated)`;
      }

      if (isAuto) {
        toast(`Backtest 15m cycle updated for ${result.symbol}.`, 'success');
      } else {
        toast('Backtest completed.', 'success');
      }
    } catch (err) {
      toast(`Backtest failed: ${err.message}`, 'error');
    } finally {
      isBacktestExecuting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Run Backtest';
      }
      if (runNowBtn) {
        runNowBtn.disabled = false;
        runNowBtn.textContent = '🔄 Run Now';
      }
      pendingBacktestScoringConfig = null;
      const appliedHint = document.getElementById('backtest-applied-hint');
      if (appliedHint) appliedHint.textContent = '';
      resetBacktestTimer();
    }
  }

  function ensureBacktestFormDefaults(form) {
    if (!form) return;
    const today = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (!form.end.value) form.end.value = today.toISOString().split('T')[0];
    if (!form.start.value) form.start.value = thirtyDaysAgo.toISOString().split('T')[0];
  }

  function resetBacktestTimer() {
    nextBacktestRunTimestamp = Date.now() + BACKTEST_AUTO_INTERVAL_MS;
    if (backtestAutoTimer) clearTimeout(backtestAutoTimer);
    if (isBacktestAutoEnabled) {
      backtestAutoTimer = setTimeout(() => {
        executeBacktest({ isAuto: true });
      }, BACKTEST_AUTO_INTERVAL_MS);
    }
    updateBacktestCountdown();
  }

  function updateBacktestCountdown() {
    const countdownEl = document.getElementById('backtest-countdown-display');
    if (!isBacktestAutoEnabled) {
      if (countdownEl) countdownEl.textContent = 'Paused';
      return;
    }
    const remainingMs = Math.max(0, nextBacktestRunTimestamp - Date.now());
    const totalSecs = Math.floor(remainingMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    if (countdownEl) countdownEl.textContent = formatted;
  }

  function setupBacktestAutoRunner() {
    const toggleBtn = document.getElementById('backtest-auto-toggle-btn');
    const runNowBtn = document.getElementById('backtest-run-now-btn');
    const stateText = document.getElementById('backtest-auto-state-text');

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        isBacktestAutoEnabled = !isBacktestAutoEnabled;
        if (isBacktestAutoEnabled) {
          toggleBtn.textContent = '⏸️ Pause';
          if (stateText) {
            stateText.textContent = 'Active';
            stateText.style.color = '#10b981';
          }
          resetBacktestTimer();
          toast('15-minute Backtest auto-refresh resumed.', 'success');
        } else {
          toggleBtn.textContent = '▶️ Resume';
          if (stateText) {
            stateText.textContent = 'Paused';
            stateText.style.color = '#f59e0b';
          }
          if (backtestAutoTimer) clearTimeout(backtestAutoTimer);
          updateBacktestCountdown();
          toast('15-minute Backtest auto-refresh paused.', 'info');
        }
      });
    }

    if (runNowBtn) {
      runNowBtn.addEventListener('click', () => {
        executeBacktest({ isAuto: false });
      });
    }

    if (backtestCountdownInterval) clearInterval(backtestCountdownInterval);
    backtestCountdownInterval = setInterval(updateBacktestCountdown, 1000);

    resetBacktestTimer();

    // Auto-run or load initial backtest so Backtest tab is immediately populated
    setTimeout(async () => {
      try {
        const recentRuns = await Api.listBacktests(1);
        if (recentRuns && recentRuns.length > 0) {
          const latestRun = await Api.getBacktest(recentRuns[0].id);
          if (latestRun) {
            renderBacktestResult(latestRun);
            const lastRunEl = document.getElementById('backtest-last-run-info');
            if (lastRunEl && latestRun.created_at_utc) {
              lastRunEl.textContent = `Last execution: ${formatTimestamp(latestRun.created_at_utc)} (${latestRun.symbol} • ${latestRun.trades?.length || 0} trades evaluated)`;
            }
          }
        } else {
          executeBacktest({ isAuto: true });
        }
      } catch {
        executeBacktest({ isAuto: true });
      }
    }, 2000);
  }

  function initBacktestForm() {
    const form = document.getElementById('backtest-form');
    if (!form) return;
    ensureBacktestFormDefaults(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await executeBacktest({ isAuto: false });
    });

    setupBacktestAutoRunner();
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

  // ---------- AutoPilot Multi-Asset Backtest Matrix ----------

  let cachedMatrixAssets = [];
  let matrixActiveFilter = 'all';
  let matrixSearchQuery = '';

  function getStrategyDisplayName(id) {
    const s = (strategiesCache || []).find((x) => x.id === id);
    if (s && s.name) return s.name;
    return id ? id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : '-';
  }

  function updateAutoPilotKpis(assets) {
    const totalEl = document.getElementById('autopilot-kpi-total');
    const activeEl = document.getElementById('autopilot-kpi-active');
    const evaluatedEl = document.getElementById('autopilot-kpi-evaluated');
    const winrateEl = document.getElementById('autopilot-kpi-winrate');

    if (totalEl) totalEl.textContent = String(assets.length);
    if (activeEl) {
      const activeCount = assets.filter((a) => a.autopilotEnabled || a.strategyMode === 'auto').length;
      activeEl.textContent = String(activeCount);
    }
    if (evaluatedEl) {
      const evalCount = assets.filter((a) => a.evaluated).length;
      evaluatedEl.textContent = String(evalCount);
    }
    if (winrateEl) {
      const wrs = assets
        .map((a) => a.metrics?.compositeWinRatePercent)
        .filter((w) => typeof w === 'number' && Number.isFinite(w));
      if (wrs.length > 0) {
        const avg = wrs.reduce((sum, val) => sum + val, 0) / wrs.length;
        winrateEl.textContent = `${fmt(avg, 1)}%`;
      } else {
        winrateEl.textContent = '-';
      }
    }

    const countAll = document.getElementById('filter-count-all');
    const countSpot = document.getElementById('filter-count-spot');
    const countDemo = document.getElementById('filter-count-demo');
    const countReal = document.getElementById('filter-count-real');
    if (countAll) countAll.textContent = String(assets.length);
    if (countSpot) countSpot.textContent = String(assets.filter((a) => a.market === 'spot').length);
    if (countDemo) countDemo.textContent = String(assets.filter((a) => a.market === 'futures-demo').length);
    if (countReal) countReal.textContent = String(assets.filter((a) => a.market === 'futures-real').length);
  }

  function renderAutoPilotMatrixRows() {
    const tbody = document.getElementById('autopilot-matrix-tbody');
    if (!tbody) return;

    clear(tbody);

    let list = cachedMatrixAssets;
    if (matrixActiveFilter !== 'all') {
      list = list.filter((a) => a.market === matrixActiveFilter);
    }
    if (matrixSearchQuery.trim()) {
      const q = matrixSearchQuery.trim().toLowerCase();
      list = list.filter((a) => a.symbol.toLowerCase().includes(q) || a.exchange.toLowerCase().includes(q));
    }

    if (list.length === 0) {
      const emptyRow = el('tr', {},
        el('td', { colspan: '11', style: 'text-align: center; color: var(--color-text-dim); padding: 1.5rem;' },
          'No matching assets found for current filter/search.'
        )
      );
      tbody.appendChild(emptyRow);
      return;
    }

    list.forEach((asset) => {
      const row = el('tr');

      // Market cell
      const marketCell = el('td');
      let marketBadge;
      if (asset.market === 'spot') {
        marketBadge = el('span', { class: 'mode-badge', style: 'background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3);' }, 'SPOT');
      } else if (asset.market === 'futures-demo') {
        marketBadge = el('span', { class: 'mode-badge mode-badge--demo' }, 'FUTURES DEMO');
      } else {
        marketBadge = el('span', { class: 'mode-badge mode-badge--real' }, 'FUTURES REAL');
      }
      marketCell.appendChild(marketBadge);

      // Symbol cell
      const symbolCell = el('td');
      const symbolStrong = el('strong', {}, asset.symbol || '-');
      const exchangeHint = el('span', { class: 'hint', style: 'font-size: 0.75rem; margin-left: 0.35rem;' }, `@ ${asset.exchange || ''}`);
      symbolCell.appendChild(symbolStrong);
      symbolCell.appendChild(exchangeHint);

      // AutoPilot cell
      const autoCell = el('td');
      const isAuto = asset.autopilotEnabled || asset.strategyMode === 'auto';
      const autoBadge = isAuto
        ? el('span', { class: 'badge', style: 'background: rgba(16, 185, 129, 0.15); color: #10b981; border-color: rgba(16, 185, 129, 0.3);' }, '⚡ Auto')
        : el('span', { class: 'badge', style: 'background: rgba(148, 163, 184, 0.1); color: var(--color-text-dim);' }, 'Manual');
      autoCell.appendChild(autoBadge);

      // Timeframe cell
      const tfCell = el('td');
      const tfStrong = el('strong', {}, asset.timeframe || '1h');
      tfCell.appendChild(tfStrong);
      if (asset.timeframeMode === 'auto') {
        tfCell.appendChild(el('span', { class: 'hint', style: 'font-size: 0.7rem; color: #38bdf8; margin-left: 0.35rem;' }, ' (Auto)'));
      }

      // Strategies & Individual Win Rates cell
      const stratsCell = el('td');
      if (asset.metrics?.strategies && asset.metrics.strategies.length > 0) {
        asset.metrics.strategies.forEach((s) => {
          const badge = el('span', { class: 'strategy-metric-badge' });
          badge.appendChild(document.createTextNode((s.strategyName || getStrategyDisplayName(s.strategyId)) + ' '));
          badge.appendChild(el('strong', {}, `${fmt(s.winRatePercent, 1)}%`));
          stratsCell.appendChild(badge);
        });
      } else if (asset.selectedStrategies && asset.selectedStrategies.length > 0) {
        asset.selectedStrategies.forEach((id) => {
          stratsCell.appendChild(el('span', {
            class: 'badge',
            style: 'background: rgba(99, 102, 241, 0.15); color: #a5b4fc; border-color: rgba(99, 102, 241, 0.3); margin-right: 4px;',
          }, getStrategyDisplayName(id)));
        });
      } else {
        stratsCell.appendChild(el('span', { class: 'hint', style: 'font-size: 0.75rem;' }, `Single: ${getStrategyDisplayName(asset.strategyId)}`));
      }

      // Avg Win Rate % cell
      const wrVal = asset.metrics?.compositeWinRatePercent;
      let wrCell;
      if (typeof wrVal === 'number' && Number.isFinite(wrVal)) {
        const wrColor = wrVal >= 60 ? '#10b981' : wrVal >= 48 ? '#38bdf8' : 'var(--color-text-dim)';
        wrCell = el('td', { style: `font-family: var(--font-mono); font-weight: 700; color: ${wrColor};` }, `${fmt(wrVal, 1)}%`);
      } else {
        wrCell = el('td');
        wrCell.appendChild(el('span', { class: 'hint' }, '-'));
      }

      // Net P&L % cell
      const pnlVal = asset.metrics?.compositePnlPercent;
      let pnlCell;
      if (typeof pnlVal === 'number' && Number.isFinite(pnlVal)) {
        const pnlColor = pnlVal > 0 ? '#10b981' : pnlVal < 0 ? '#ef4444' : 'inherit';
        pnlCell = el('td', { style: `font-family: var(--font-mono); color: ${pnlColor}; font-weight: 600;` }, `${fmt(pnlVal, 2)}%`);
      } else {
        pnlCell = el('td');
        pnlCell.appendChild(el('span', { class: 'hint' }, '-'));
      }

      // Trades cell
      const tradesVal = asset.metrics?.totalTradeCount;
      let tradesCell;
      if (typeof tradesVal === 'number' && Number.isFinite(tradesVal)) {
        tradesCell = el('td', { style: 'font-family: var(--font-mono);' }, String(tradesVal));
      } else {
        tradesCell = el('td');
        tradesCell.appendChild(el('span', { class: 'hint' }, '-'));
      }

      // Status cell
      const statusCell = el('td');
      if (asset.evaluated) {
        const dot = el('span', { class: 'status-indicator status-indicator--live', style: 'width: 7px; height: 7px; background: #10b981; border-radius: 50%; display: inline-block; margin-right: 4px;' });
        const text = el('span', { style: 'color: #10b981;' }, 'Evaluated');
        statusCell.appendChild(dot);
        statusCell.appendChild(text);
      } else {
        statusCell.appendChild(el('span', { style: 'color: #f59e0b;' }, '⏳ Pending Cycle'));
      }

      // Last evaluated cell
      const lastEvalCell = el('td', { style: 'font-size: 0.78rem; font-family: var(--font-mono);' },
        asset.strategySelectionUpdatedAt ? formatTimestamp(asset.strategySelectionUpdatedAt) : '-'
      );

      // Actions cell
      const actionCell = el('td', { style: 'white-space: nowrap;' });
      const breakdownBtn = el('button', { type: 'button', class: 'btn-breakdown', style: 'font-size: 0.75rem; padding: 0.25rem 0.55rem; margin-right: 0.35rem;' }, '📊 Breakdown');
      breakdownBtn.addEventListener('click', () => showStrategyBreakdownModal(asset));

      const testBtn = el('button', { type: 'button', style: 'font-size: 0.75rem; padding: 0.25rem 0.55rem;' }, '🔄 Test');
      testBtn.addEventListener('click', () => retestAutoPilotAsset(asset, testBtn));

      actionCell.appendChild(breakdownBtn);
      actionCell.appendChild(testBtn);

      [marketCell, symbolCell, autoCell, tfCell, stratsCell, wrCell, pnlCell, tradesCell, statusCell, lastEvalCell, actionCell].forEach((c) => row.appendChild(c));
      tbody.appendChild(row);
    });
  }

  async function retestAutoPilotAsset(asset, btn) {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '⏳ Testing...';

    try {
      const res = await Api.evaluateAutoPilotAsset({
        symbol: asset.symbol,
        exchange: asset.exchange,
        timeframe: asset.timeframe,
        market: asset.market,
      });

      if (res.timeframe) {
        asset.timeframe = res.timeframe;
      }
      asset.metrics = res.metrics;
      asset.selectedStrategies = res.selected;
      asset.evaluated = true;
      asset.strategySelectionUpdatedAt = new Date().toISOString();

      updateAutoPilotKpis(cachedMatrixAssets);
      renderAutoPilotMatrixRows();

      toast(`Evaluated ${asset.symbol} on ${asset.timeframe}: Win Rate ${res.metrics?.compositeWinRatePercent || 0}%, P&L ${res.metrics?.compositePnlPercent || 0}%!`, 'success');
    } catch (err) {
      toast(`Evaluation failed for ${asset.symbol}: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  async function loadAutoPilotMatrix() {
    const tbody = document.getElementById('autopilot-matrix-tbody');
    if (!tbody) return;

    try {
      const data = await Api.getAutoPilotMatrix();
      if (!data) return;

      if (data.config) {
        const lookbackEl = document.getElementById('autopilot-config-lookback');
        const minTradesEl = document.getElementById('autopilot-config-min-trades');
        const topCountEl = document.getElementById('autopilot-config-top-count');
        const intervalEl = document.getElementById('autopilot-config-interval');

        if (lookbackEl) lookbackEl.textContent = `${data.config.lookbackDays}d`;
        if (minTradesEl) minTradesEl.textContent = String(data.config.minTrades);
        if (topCountEl) topCountEl.textContent = `${data.config.selectionCount} Strategies`;
        if (intervalEl) intervalEl.textContent = `${Math.round((data.config.intervalMs || 43200000) / 3600000)}h`;
      }

      cachedMatrixAssets = data.assets || [];
      const evaluatedCount = cachedMatrixAssets.filter((a) => a.evaluated).length;
      const countEl = document.getElementById('autopilot-matrix-eval-count');
      if (countEl) countEl.textContent = `${evaluatedCount} / ${cachedMatrixAssets.length} Evaluated`;

      updateAutoPilotKpis(cachedMatrixAssets);
      renderAutoPilotMatrixRows();
    } catch (err) {
      clear(tbody);
      const errRow = el('tr', {},
        el('td', { colspan: '11', style: 'text-align: center; color: #ef4444; padding: 1rem;' }, `Failed to load AutoPilot matrix: ${err.message}`)
      );
      tbody.appendChild(errRow);
    }
  }

  async function showStrategyBreakdownModal(asset) {
    const backdrop = document.getElementById('autopilot-breakdown-backdrop');
    const titleEl = document.getElementById('autopilot-breakdown-title');
    const metaEl = document.getElementById('autopilot-breakdown-meta');
    const tbody = document.getElementById('autopilot-breakdown-tbody');
    if (!backdrop || !tbody) return;

    backdrop.hidden = false;
    titleEl.textContent = `AutoPilot Strategy Evaluation: ${asset.symbol} (${asset.market.toUpperCase()})`;
    metaEl.textContent = `Simulating 30-day historical candles for ${asset.symbol} @ ${asset.exchange} (${asset.timeframe})...`;

    clear(tbody);
    const loadingRow = el('tr', {},
      el('td', { colspan: '6', style: 'text-align: center; padding: 2rem; color: #38bdf8;' }, '⏳ Running multi-strategy grid backtests across all threshold combinations...')
    );
    tbody.appendChild(loadingRow);

    try {
      const result = await Api.evaluateAutoPilotAsset({
        symbol: asset.symbol,
        exchange: asset.exchange,
        timeframe: asset.timeframe,
        market: asset.market,
      });

      // Update cached row data if it exists
      if (result.timeframe) {
        asset.timeframe = result.timeframe;
      }
      titleEl.textContent = `AutoPilot Strategy Evaluation: ${asset.symbol} (${asset.market.toUpperCase()}) - ${asset.timeframe}${asset.timeframeMode === 'auto' ? ' (Auto)' : ''}`;
      asset.metrics = result.metrics;
      asset.selectedStrategies = result.selected;
      asset.evaluated = true;
      asset.strategySelectionUpdatedAt = new Date().toISOString();
      updateAutoPilotKpis(cachedMatrixAssets);
      renderAutoPilotMatrixRows();

      clear(metaEl);
      metaEl.append(
        'Range: ',
        el('strong', {}, formatTimestamp(result.startUtc)),
        ' to ',
        el('strong', {}, formatTimestamp(result.endUtc)),
        ' • Selection Criteria: ',
        el('strong', {}, `Top ${result.selectionCount}`),
        ` by Win Rate (Min ${result.minTrades} closed trades)`
      );

      clear(tbody);
      const strats = result.strategies || [];
      if (strats.length === 0) {
        const emptyRow = el('tr', {},
          el('td', { colspan: '6', style: 'text-align: center; padding: 1rem;' }, 'No strategy simulation data returned.')
        );
        tbody.appendChild(emptyRow);
        return;
      }

      strats.forEach((s) => {
        const row = el('tr');
        const isSelected = Array.isArray(result.selected) && result.selected.includes(s.strategyId);

        if (isSelected) {
          row.style.background = 'rgba(16, 185, 129, 0.08)';
        }

        const winRateColor = s.winRatePercent >= 60 ? '#10b981' : s.winRatePercent >= 45 ? '#38bdf8' : 'var(--color-text-dim)';
        const pnlColor = s.totalPnlPercent > 0 ? '#10b981' : s.totalPnlPercent < 0 ? '#ef4444' : 'inherit';

        let statusBadge;
        if (isSelected) {
          statusBadge = el('span', { class: 'badge', style: 'background: rgba(16, 185, 129, 0.2); color: #10b981; border-color: rgba(16, 185, 129, 0.4);' }, '⭐ AutoPilot Selected');
        } else if (!s.qualifies) {
          statusBadge = el('span', { class: 'badge', style: 'background: rgba(245, 158, 11, 0.1); color: #f59e0b; border-color: rgba(245, 158, 11, 0.3);' }, `Low Trades (<${result.minTrades})`);
        } else {
          statusBadge = el('span', { class: 'hint' }, 'Eligible (Lower Rank)');
        }

        const nameCell = el('td');
        nameCell.appendChild(el('strong', {}, s.strategyName || s.strategyId));

        const winRateCell = el('td', { style: `color: ${winRateColor}; font-weight: 600; font-family: var(--font-mono);` }, `${fmt(s.winRatePercent, 1)}%`);
        const pnlCell = el('td', { style: `color: ${pnlColor}; font-family: var(--font-mono);` }, `${fmt(s.totalPnlPercent, 2)}%`);
        const tradesCell = el('td', { style: 'font-family: var(--font-mono);' }, String(s.tradeCount));
        const ddCell = el('td', { style: 'font-family: var(--font-mono); color: var(--color-text-dim);' }, `${fmt(s.maxDrawdownPercent, 2)}%`);
        
        const statusCell = el('td');
        statusCell.appendChild(statusBadge);

        [nameCell, winRateCell, pnlCell, tradesCell, ddCell, statusCell].forEach((c) => row.appendChild(c));
        tbody.appendChild(row);
      });
    } catch (err) {
      clear(tbody);
      const errRow = el('tr', {},
        el('td', { colspan: '6', style: 'text-align: center; color: #ef4444; padding: 1.5rem;' }, `Evaluation failed: ${err.message}`)
      );
      tbody.appendChild(errRow);
    }
  }

  function initAutoPilotMatrix() {
    const evalAllBtn = document.getElementById('autopilot-matrix-eval-all-btn');
    if (evalAllBtn) {
      evalAllBtn.addEventListener('click', async () => {
        evalAllBtn.disabled = true;
        const originalText = evalAllBtn.textContent;
        evalAllBtn.textContent = '⏳ Evaluating all assets (running backtests)...';
        try {
          const res = await Api.evaluateAutoPilotAll();
          toast(`AutoPilot evaluation finished (${res.spotEvaluated} spot, ${res.demoFuturesEvaluated} demo futures, ${res.realFuturesEvaluated} real futures).`, 'success');
          await loadAutoPilotMatrix();
        } catch (err) {
          toast(`AutoPilot evaluation failed: ${err.message}`, 'error');
        } finally {
          evalAllBtn.disabled = false;
          evalAllBtn.textContent = originalText;
        }
      });
    }

    const refreshBtn = document.getElementById('autopilot-matrix-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        loadAutoPilotMatrix();
        toast('AutoPilot matrix refreshed.', 'info');
      });
    }

    // Market filters
    const filterContainer = document.getElementById('autopilot-matrix-market-filters');
    if (filterContainer) {
      filterContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-filter');
        if (!btn) return;
        filterContainer.querySelectorAll('.btn-filter').forEach((b) => b.classList.remove('btn-filter--active'));
        btn.classList.add('btn-filter--active');
        matrixActiveFilter = btn.dataset.market || 'all';
        renderAutoPilotMatrixRows();
      });
    }

    // Search input
    const searchInput = document.getElementById('autopilot-matrix-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        matrixSearchQuery = searchInput.value || '';
        renderAutoPilotMatrixRows();
      });
    }

    const modalBackdrop = document.getElementById('autopilot-breakdown-backdrop');
    const closeBtn = document.getElementById('autopilot-breakdown-close-btn');
    const doneBtn = document.getElementById('autopilot-breakdown-done-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => { if (modalBackdrop) modalBackdrop.hidden = true; });
    if (doneBtn) doneBtn.addEventListener('click', () => { if (modalBackdrop) modalBackdrop.hidden = true; });
    if (modalBackdrop) {
      modalBackdrop.addEventListener('click', (e) => {
        if (e.target === modalBackdrop) modalBackdrop.hidden = true;
      });
    }
  }

  // ---------- persistent status bar (always visible, independent of active tab) ----------

  async function refreshStatusBar() {
    const mode = ModeSwitcher.getMode();
    try {
      const [portfolio, status] = await Promise.all([Api.getPortfolio(mode), Api.getSystemStatus()]);

      // Combine with Futures, same as refreshOpenPositionsSummary()'s established pattern below —
      // previously spot-only, which under-reported balance/P&L whenever futures positions/balance
      // existed too. Real futures is only queried when unlocked (Api.getFuturesPortfolio('real')
      // 403s otherwise); if that call fails for any reason, fall back to spot-only rather than
      // showing nothing.
      let balance = portfolio.balance;
      let netPnl = portfolio.pnl ? portfolio.pnl.netPnl : null;
      if (mode !== 'real' || ModeSwitcher.isRealUnlocked()) {
        try {
          const futuresPortfolio = await Api.getFuturesPortfolio(mode);
          balance += futuresPortfolio.balance;
          netPnl = (netPnl ?? 0) + (futuresPortfolio.pnl ? futuresPortfolio.pnl.netPnl : 0);
        } catch {
          // Futures portfolio unavailable — still show spot-only figures rather than nothing.
        }
      }

      document.getElementById('status-balance').textContent = fmt(balance);

      const netPnlEl = document.getElementById('status-net-pnl');
      netPnlEl.textContent = netPnl === null ? '-' : fmt(netPnl);
      netPnlEl.className = `status-bar__value ${netPnl > 0 ? 'text-positive' : netPnl < 0 ? 'text-negative' : ''}`;

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

      try {
        const fng = await Api.getFearAndGreed();
        const fngEl = document.getElementById('status-fng-value');
        if (fngEl && fng) {
          fngEl.textContent = `${fng.value} (${fng.classification})`;
          if (fng.value <= 25) {
            fngEl.style.color = '#ef4444';
          } else if (fng.value <= 45) {
            fngEl.style.color = '#f97316';
          } else if (fng.value <= 55) {
            fngEl.style.color = '#eab308';
          } else if (fng.value <= 75) {
            fngEl.style.color = '#22c55e';
          } else {
            fngEl.style.color = '#10b981';
          }
        }
      } catch {}
    } catch (err) {
      // Non-critical, always-on background refresh — don't spam toasts on transient failures.
    }
    refreshOpenPositionsSummary(mode);
  }

  function renderOpenPositionsSummaryRow(market, p) {
    const row = el('tr');
    const unrealizedCell = el('td', {}, p.unrealizedPnl != null ? fmt(p.unrealizedPnl) : '-');
    if (p.unrealizedPnl > 0) unrealizedCell.className = 'text-positive';
    else if (p.unrealizedPnl < 0) unrealizedCell.className = 'text-negative';
    const initialStop = p.initial_stop_loss != null ? p.initial_stop_loss : p.stop_loss;
    row.append(
      el('td', {}, market), el('td', {}, p.symbol), el('td', {}, p.exchange || '-'), el('td', {}, p.side),
      el('td', {}, p.leverage != null ? `${p.leverage}x` : '-'), el('td', {}, fmt(p.qty, 6)),
      el('td', {}, fmtPrice(p.entry_price)), el('td', {}, p.currentPrice != null ? fmtPrice(p.currentPrice) : '-'),
      unrealizedCell, el('td', {}, fmtPrice(initialStop)), buildStopCell(p),
      el('td', {}, fmtPrice(p.take_profit)), buildAdaptiveTpCell(p)
    );
    return row;
  }

  // Combines Spot + Futures open positions for the current mode into one at-a-glance table above
  // the tabs, so switching between Demo/Real Trading, Watchlist, etc. doesn't require flipping
  // tabs just to see everything that's open. Also drives the top status bar's "Open Positions"
  // count — previously spot-only (just portfolio.openPositions.length from refreshStatusBar),
  // which under-reported whenever futures positions were open too. Real futures is only queried
  // when unlocked — Api.getFuturesPortfolio('real') 403s otherwise, same guard as
  // getSignalsSettingEntries().
  async function refreshOpenPositionsSummary(mode) {
    const badge = document.getElementById('open-positions-summary-mode-badge');
    badge.textContent = mode.toUpperCase();
    badge.className = `mode-badge mode-badge--${mode}`;

    const body = document.getElementById('open-positions-summary-body');
    const emptyEl = document.getElementById('open-positions-summary-empty');
    try {
      const spotPortfolio = await Api.getPortfolio(mode);
      let futuresPositions = [];
      if (mode !== 'real' || ModeSwitcher.isRealUnlocked()) {
        try {
          const futuresPortfolio = await Api.getFuturesPortfolio(mode);
          futuresPositions = futuresPortfolio.openPositions;
        } catch {
          // Futures portfolio unavailable — still show spot positions rather than nothing.
        }
      }
      clear(body);
      spotPortfolio.openPositions.forEach((p) => body.appendChild(renderOpenPositionsSummaryRow('Spot', p)));
      futuresPositions.forEach((p) => body.appendChild(renderOpenPositionsSummaryRow('Futures', p)));
      const total = spotPortfolio.openPositions.length + futuresPositions.length;
      emptyEl.hidden = total > 0;
      document.getElementById('status-open-positions').textContent = String(total);
    } catch {
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

  // Separate table/endpoint from spot's risk settings above — futures open_long/open_short
  // orders are checked against these, not api/risk-settings. See futures-controller.js#getRiskSettings.
  async function loadFuturesRiskSettings(mode) {
    document.getElementById('futures-risk-mode-badge').textContent = mode.toUpperCase();
    document.getElementById('futures-risk-mode-badge').className = `mode-badge mode-badge--${mode}`;
    try {
      const settings = await Api.getFuturesRiskSettings(mode);
      const form = document.getElementById('futures-risk-settings-form');
      form.maxRiskPerTradePercent.value = settings.max_risk_per_trade_percent;
      form.maxDailyLossPercent.value = settings.max_daily_loss_percent;
      form.maxOpenPositions.value = settings.max_open_positions;
      form.maxOrderValue.value = settings.max_order_value;
      form.minRiskRewardRatio.value = settings.min_risk_reward_ratio;
      form.maxPortfolioExposurePercent.value = settings.max_portfolio_exposure_percent;
      form.maxLeverage.value = settings.max_leverage;
    } catch (err) {
      toast(`Failed to load futures risk settings: ${err.message}`, 'error');
    }
  }

  function initFuturesRiskSettingsForm() {
    document.getElementById('futures-risk-settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const mode = ModeSwitcher.getMode();
      try {
        await Api.updateFuturesRiskSettings(mode, {
          maxRiskPerTradePercent: Number(form.maxRiskPerTradePercent.value),
          maxDailyLossPercent: Number(form.maxDailyLossPercent.value),
          maxOpenPositions: Number(form.maxOpenPositions.value),
          maxOrderValue: Number(form.maxOrderValue.value),
          minRiskRewardRatio: Number(form.minRiskRewardRatio.value),
          maxPortfolioExposurePercent: Number(form.maxPortfolioExposurePercent.value),
          maxLeverage: Number(form.maxLeverage.value),
        });
        toast('Futures risk settings saved.', 'success');
      } catch (err) {
        toast(`Failed to save futures risk settings: ${err.message}`, 'error');
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

  function setupTelegramIntegration() {
    const testBtn = document.getElementById('telegram-test-btn');
    const tokenInput = document.getElementById('telegram-token-input');
    const chatIdInput = document.getElementById('telegram-chatid-input');
    const statusText = document.getElementById('telegram-status-text');

    if (!testBtn) return;

    async function checkStatus() {
      try {
        const res = await Api.getTelegramStatus();
        clear(statusText);
        if (res.enabled) {
          statusText.textContent = '🟢 Telegram is active and configured. Alerts will be sent automatically.';
          statusText.style.color = '#10b981';
        } else if (res.hasToken && res.hasChatId) {
          statusText.textContent = '🟡 Credentials present, but TELEGRAM_NOTIFICATIONS_ENABLED is false in .env';
          statusText.style.color = '#f59e0b';
        } else {
          statusText.textContent = '⚪ Not configured. Enter your Bot Token and Chat ID above to test.';
          statusText.style.color = 'var(--color-fg-muted)';
        }
      } catch {}
    }

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = 'Sending...';
      try {
        const botToken = tokenInput.value.trim() || undefined;
        const chatId = chatIdInput.value.trim() || undefined;
        await Api.sendTelegramTest({ botToken, chatId });
        toast('Telegram test message sent successfully!', 'success');
        clear(statusText);
        statusText.textContent = '✅ Test message sent successfully!';
        statusText.style.color = '#10b981';
      } catch (err) {
        toast(err.message, 'error');
        clear(statusText);
        statusText.textContent = `❌ Error: ${err.message}`;
        statusText.style.color = '#ef4444';
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Send Test Message';
      }
    });

    checkStatus();
  }

  // ---------- init ----------

  function init() {
    initTabs();
    ModeSwitcher.init();
    // The Futures half of the Signals Setting Results table depends on which mode is selected
    // (Demo/Real Futures Signals Setting are separate lists) — re-load it on every mode switch,
    // not just when the Spot watchlist itself changes.
    ModeSwitcher.onChange((mode) => { loadRiskSettings(mode); loadFuturesRiskSettings(mode); refreshStatusBar(); loadLastWatchlistSignals(); });

    document.getElementById('load-asset-btn').addEventListener('click', loadAsset);
    document.getElementById('try-tradingview-btn').addEventListener('click', loadTradingViewChart);
    document.getElementById('use-builtin-chart-btn').addEventListener('click', loadBuiltinChart);
    document.getElementById('generate-watchlist-signals-btn').addEventListener('click', generateSignalsForWatchlist);
    document.getElementById('add-watchlist-btn').addEventListener('click', addCurrentAssetToWatchlist);
    document.getElementById('add-to-watchlist-btn').addEventListener('click', addAssetToWatchList);
    document.getElementById('enable-all-autotrade-btn').addEventListener('click', enableAutoTradeForAll);
    document.getElementById('enable-all-autopilot-btn')?.addEventListener('click', enableAutoPilotForAll);

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
    initAutoPilotMatrix();
    loadAutoPilotMatrix();
    initRiskSettingsForm();
    initFuturesRiskSettingsForm();
    initEmergencyControls();
    initRealCredentialsForm();
    setupTelegramIntegration();
    document.getElementById('refresh-real-balance-btn').addEventListener('click', () => refreshRealBalance());

    document.getElementById('refresh-system-btn').addEventListener('click', refreshSystemStatus);
    document.getElementById('refresh-logs-btn').addEventListener('click', refreshLogs);

    document.getElementById('exchange-input').addEventListener('change', refreshSymbolSuggestions);
    loadStrategyOptions().then(() => loadExchangeOptions().then(() => Promise.all([loadAsset(), refreshSymbolSuggestions()])).then(refreshSpotWatchlist));
    loadRealCredentialsExchangeOptions().then(refreshRealCredentialsStatus);
    loadRiskSettings(ModeSwitcher.getMode());
    loadFuturesRiskSettings(ModeSwitcher.getMode());
    refreshStatusBar();
    refreshWatchList();

    // Light polling so prices/indicators don't go stale while the dashboard tab is open.
    setInterval(() => {
      if (document.getElementById('tab-dashboard').classList.contains('tab-panel--active')) {
        loadMarketData();
      }
    }, 30_000);

    // Status bar is always visible regardless of active tab, so it polls independently.
    setInterval(refreshStatusBar, 15_000);

    // Keeps Signals Setting Results current with whatever the scheduler/auto-trader just
    // persisted, without waiting for a tab switch or list mutation to trigger a reload.
    setInterval(() => {
      if (document.getElementById('tab-watchlist').classList.contains('tab-panel--active')) {
        loadLastWatchlistSignals();
      }
    }, 60_000);
  }

  window.Dashboard = { init, switchToTab };
})();
