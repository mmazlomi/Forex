'use strict';

/**
 * Futures: KuCoin-only, own symbol picker, own Demo/Real portfolios, positions, orders, and
 * watchlist/auto-trade — deliberately zero shared code paths with Spot's dashboard.js, mirroring
 * the backend's "separate everything" design. Self-contained module, same style as
 * mode-switcher.js/order-confirmation.js (not part of Dashboard's IIFE). Its cards live inside
 * the Demo Trading / Real Trading tabs (owned by index.html/dashboard.js), and its watchlist
 * management lives on the Watchlist tab — this module only owns the DOM ids inside those cards,
 * not tab switching itself (see Dashboard.switchToTab, called from the "Trade" buttons below).
 */
const Futures = (() => {
  const EXCHANGE = 'kucoin';
  let lastPrice = null;
  let symbolsCache = [];
  let strategiesCache = [];
  // Private copy, deliberately not shared with dashboard.js's own TIMEFRAME_OPTIONS — see this
  // file's header comment. Matches the backend's SUPPORTED_TIMEFRAMES.
  const TIMEFRAME_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
  // Fully independent Demo/Real watchlist caches — never merged, never shared.
  const watchlistCache = { demo: [], real: [] };

  // ---------- small DOM helpers (deliberately not shared with dashboard.js's private copies) ----------

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
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

  function fmtBalance(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    const digits = Math.abs(n) > 0 && Math.abs(n) < 1 ? 8 : 2;
    return fmt(n, digits);
  }

  // Matches TradingView's own price-axis behavior — see dashboard.js's identical fmtPrice for the
  // full rationale (kept as a private copy per this file's established "deliberately not shared"
  // convention with dashboard.js).
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

  // CoinMarketCap-style market list helpers for the Futures Signals Setting tables — private
  // copies of dashboard.js's identical helpers, per this file's established convention.
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

  function changeBadge(percent) {
    if (percent === null || percent === undefined || Number.isNaN(percent)) {
      return el('span', { class: 'cmc-change cmc-change--flat' }, '-');
    }
    const direction = percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat';
    const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';
    return el('span', { class: `cmc-change cmc-change--${direction}` }, `${arrow} ${fmt(Math.abs(percent), 2)}%`.trim());
  }

  // Private copy, deliberately not shared with dashboard.js's own formatTimestamp() — see this
  // file's header comment. Every stored timestamp is a UTC ISO-8601 string; this renders it in
  // the browser's own local timezone (no `timeZone` option passed to Intl.DateTimeFormat, so it
  // defaults to the runtime's local zone) for the futures order history tables.
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

  function renderStatList(container, entries) {
    clear(container);
    entries.forEach(([label, value]) => {
      const div = el('div');
      div.append(el('dt', {}, label), el('dd', {}, value));
      container.appendChild(div);
    });
  }

  function strategyName(strategyId) {
    const strategy = strategiesCache.find((s) => s.id === strategyId);
    return strategy ? strategy.name : (strategyId || 'Balanced');
  }

  // Read-only summary shown in the Strategy column in place of the manual <select> once an asset
  // is in 🎯 Auto-Select mode — strategy-selector.js (server-side scheduler) owns this value.
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

  // ---------- symbol picker ----------

  // The input field itself is the single source of truth for the current symbol, read fresh at
  // every use — not a separately-tracked variable kept in sync only via a `change` event. A
  // change-event-only variable is fragile to event-ordering edge cases (most concretely: mobile
  // browsers, where focus/blur timing around a virtual keyboard doesn't always fire `change`
  // before a subsequent tap on another button registers), and was the root cause of "must type
  // the symbol completely to add" — the Add button was reading a stale symbol that never updated.
  function getCurrentSymbol() {
    return document.getElementById('futures-symbol-input').value.trim();
  }

  // The symbol input lives on the Watchlist tab, but the order forms it drives live on the Demo
  // Trading / Real Trading tabs — this readout is the only visible link between them, so a user
  // switching tabs can always see which symbol they're about to trade.
  function updateCurrentSymbolLabels() {
    const symbol = getCurrentSymbol() || '-';
    const demoLabel = document.getElementById('futures-demo-current-symbol');
    const realLabel = document.getElementById('futures-real-current-symbol');
    if (demoLabel) demoLabel.textContent = symbol;
    if (realLabel) realLabel.textContent = symbol;
  }

  async function refreshSymbolSuggestions() {
    try {
      symbolsCache = await Api.listFuturesSymbols(EXCHANGE);
    } catch (err) {
      toast(`Failed to load futures symbols: ${err.message}`, 'error');
    }
  }

  function showSymbolSuggestions(filterText) {
    const list = document.getElementById('futures-symbol-suggestions-list');
    const filter = filterText.trim().toUpperCase();
    const matches = (filter ? symbolsCache.filter((s) => s.toUpperCase().includes(filter)) : symbolsCache).slice(0, 25);
    clear(list);
    matches.forEach((s) => list.appendChild(el('li', {}, s)));
    list.hidden = matches.length === 0;
  }

  function hideSymbolSuggestions() {
    document.getElementById('futures-symbol-suggestions-list').hidden = true;
  }

  // ---------- portfolio / positions / orders ----------

  function renderPositionsTable(body, positions) {
    clear(body);
    positions.forEach((p) => {
      const row = el('tr');
      const unrealizedCell = el('td', {}, p.unrealizedPnl != null ? fmt(p.unrealizedPnl) : '-');
      if (p.unrealizedPnl > 0) unrealizedCell.className = 'text-positive';
      else if (p.unrealizedPnl < 0) unrealizedCell.className = 'text-negative';
      const liqCell = el('td', {}, p.liquidation_price != null ? fmtPrice(p.liquidation_price) : '-');
      if (typeof p.liquidationDistancePercent === 'number' && p.liquidationDistancePercent < 10) {
        liqCell.className = 'text-negative';
        liqCell.title = `Only ${fmt(p.liquidationDistancePercent, 1)}% away from liquidation at the current price.`;
      }
      row.append(
        el('td', {}, p.symbol), el('td', {}, p.side), el('td', {}, `${p.leverage}x`), el('td', {}, fmt(p.qty, 6)),
        el('td', {}, fmtPrice(p.entry_price)), el('td', {}, p.currentPrice != null ? fmtPrice(p.currentPrice) : '-'),
        unrealizedCell, liqCell, el('td', {}, fmtPrice(p.stop_loss)), el('td', {}, fmtPrice(p.take_profit))
      );
      body.appendChild(row);
    });
  }

  function renderOrdersTable(body, orders) {
    clear(body);
    orders.forEach((o) => {
      const row = el('tr');
      row.append(
        el('td', {}, formatTimestamp(o.created_at_utc)), el('td', {}, o.symbol || '-'), el('td', {}, o.action.replace('_', ' ')), el('td', {}, `${o.leverage}x`),
        el('td', {}, fmt(o.qty, 6)), el('td', {}, fmtPrice(o.price)), el('td', {}, o.status), el('td', {}, o.reject_reason || '')
      );
      body.appendChild(row);
    });
  }

  async function refreshPortfolio(mode) {
    updateCurrentSymbolLabels();
    try {
      const portfolio = await Api.getFuturesPortfolio(mode);
      const statsEl = document.getElementById(`futures-${mode}-portfolio-stats`);
      const settleCurrency = getCurrentSymbol().split(':')[1] || '';
      const unit = settleCurrency ? ` ${settleCurrency}` : '';
      renderStatList(statsEl, [
        ['Balance', `${fmtBalance(portfolio.balance)}${unit}`],
        ['Available (margin)', `${fmtBalance(portfolio.availableBalance)}${unit}`],
        ['Notional exposure', `${fmt(portfolio.exposurePercent, 1)}%`],
        ['Margin used', `${fmtBalance(portfolio.marginUsed)}${unit}`],
        ['Daily loss', `${fmtBalance(portfolio.dailyLossSoFar)}${unit}`],
        ['Open positions', String(portfolio.openPositions.length)],
      ]);
      renderPositionsTable(document.getElementById(`futures-${mode}-positions-body`), portfolio.openPositions);

      const pnlEl = document.getElementById(`futures-${mode}-pnl-stats`);
      if (pnlEl && portfolio.pnl) {
        const p = portfolio.pnl;
        renderStatList(pnlEl, [
          ['Realized P&L (all-time)', fmt(p.totalRealizedPnl)],
          ['Unrealized P&L', fmt(p.unrealizedPnl)],
          ['Net P&L', fmt(p.netPnl)],
          ['Win rate', `${fmt(p.winRatePercent, 1)}% (${p.winCount}W / ${p.lossCount}L)`],
        ]);
        [pnlEl.children[0], pnlEl.children[2]].forEach((div, i) => {
          const value = i === 0 ? p.totalRealizedPnl : p.netPnl;
          const dd = div.querySelector('dd');
          dd.className = value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : '';
        });
      }

      const orders = await Api.listFuturesOrders(mode, 20);
      renderOrdersTable(document.getElementById(`futures-${mode}-orders-body`), orders);
    } catch (err) {
      toast(`Failed to load ${mode} futures portfolio: ${err.message}`, 'error');
    }
  }

  async function refreshBothPortfolios() {
    await refreshPortfolio('demo');
    if (ModeSwitcher.isRealUnlocked()) await refreshPortfolio('real');
  }

  // ---------- order form ----------

  function updateActionFieldVisibility(form) {
    const action = form.action.value;
    form.querySelectorAll('.futures-action-field[data-for]').forEach((label) => {
      const applicable = label.dataset.for.split(',');
      label.hidden = !applicable.includes(action);
    });
  }

  async function submitOrder(mode, action, leverage, stopLoss, takeProfit, qty) {
    const symbol = getCurrentSymbol();
    const isOpen = action === 'open_long' || action === 'open_short';
    const side = action === 'open_long' ? 'LONG' : action === 'open_short' ? 'SHORT' : 'CLOSE';
    const estimatedValue = isOpen && qty != null && lastPrice != null ? qty * lastPrice : null;

    const confirmation = await OrderConfirmation.show({
      mode, symbol, exchange: EXCHANGE, side,
      price: lastPrice, stopLoss: isOpen ? stopLoss : null, takeProfit: isOpen ? takeProfit : null,
      estimatedValue, leverage: isOpen ? leverage : null,
    });
    if (!confirmation.confirmed) return;

    try {
      const body = { symbol, exchange: EXCHANGE, action, leverage, stopLoss, takeProfit, qty };
      const result = mode === 'real'
        ? await Api.placeRealFuturesOrder({ ...body, confirmationText: confirmation.confirmationText })
        : await Api.placeDemoFuturesOrder(body);
      toast(`Futures ${action.replace('_', ' ')} ${result.status}`, result.status === 'rejected' ? 'error' : 'success');
      await refreshPortfolio(mode);
    } catch (err) {
      toast(`Futures order rejected: ${err.message}`, 'error');
      await refreshPortfolio(mode);
    }
  }

  function initOrderForm(mode, formId) {
    const form = document.getElementById(formId);
    if (!form) return;
    form.action.addEventListener('change', () => updateActionFieldVisibility(form));
    updateActionFieldVisibility(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (mode === 'real' && !ModeSwitcher.isRealUnlocked()) {
        toast('Unlock Real Trading first (Real Trading tab).', 'error');
        return;
      }
      const action = form.action.value;
      const leverage = form.leverage.value ? Number(form.leverage.value) : undefined;
      const stopLoss = form.stopLoss.value ? Number(form.stopLoss.value) : undefined;
      const takeProfit = form.takeProfit.value ? Number(form.takeProfit.value) : undefined;
      const qty = form.qty.value ? Number(form.qty.value) : undefined;
      await submitOrder(mode, action, leverage, stopLoss, takeProfit, qty);
    });
  }

  // ---------- watchlist / auto-trade (Watchlist tab) ----------

  // Loads a watchlist symbol into the futures symbol input and jumps to that mode's trading tab —
  // the futures equivalent of dashboard.js's tradeWatchlistAsset().
  async function tradeWatchlistAsset(asset, mode) {
    document.getElementById('futures-symbol-input').value = asset.symbol;
    updateCurrentSymbolLabels();
    Dashboard.switchToTab(mode);
    await refreshPortfolio(mode);
  }

  // Renders one mode's watchlist table — called separately for 'demo' and 'real', each reading
  // and writing only its own table (demo_futures_assets / real_futures_assets) via the mode
  // param threaded through every Api.*Futures* call. Never mixes the two.
  async function refreshWatchlist(mode) {
    const body = document.getElementById(`futures-${mode}-watchlist-body`);
    const emptyEl = document.getElementById(`futures-${mode}-watchlist-empty`);
    try {
      const assets = await Api.listFuturesAssets(mode);
      watchlistCache[mode] = assets;
      clear(body);
      emptyEl.hidden = assets.length > 0;

      assets.forEach((asset, index) => {
        const row = el('tr');
        row.appendChild(el('td', { class: 'cmc-rank' }, String(index + 1)));

        const symbolCell = el('td');
        const symbolWrap = el('div', { class: 'cmc-symbol-cell' });
        symbolWrap.appendChild(symbolAvatar(asset.symbol));
        symbolWrap.appendChild(el('span', { class: 'cmc-symbol-name' }, asset.symbol));
        symbolCell.appendChild(symbolWrap);
        row.appendChild(symbolCell);

        // Live price/24h % via the futures snapshot (market: 'futures' routes /api/market-data
        // through the KuCoin futures client — see market-controller.js — since the spot client
        // has no data for a futures-only symbol like BTC/USDT:USDT).
        const priceCell = el('td', { class: 'cmc-price' }, '…');
        const changeCell = el('td');
        row.appendChild(priceCell);
        row.appendChild(changeCell);
        Api.getMarketData(asset.symbol, asset.exchange || 'kucoin', 'futures').then((snapshot) => {
          priceCell.textContent = fmtPrice(snapshot.price);
          clear(changeCell);
          changeCell.appendChild(changeBadge(snapshot.changePercent24h));
        }).catch(() => {
          priceCell.textContent = '-';
        });

        const timeframeSelect = el('select');
        TIMEFRAME_OPTIONS.forEach((tf) => {
          const opt = el('option', { value: tf }, tf);
          if (tf === (asset.default_timeframe || '1h')) opt.setAttribute('selected', 'selected');
          timeframeSelect.appendChild(opt);
        });
        timeframeSelect.title = 'Also used by AI Auto-Trade — changing it changes which candle timeframe the auto-trader analyzes for this asset.';
        timeframeSelect.addEventListener('change', async () => {
          try {
            await Api.setFuturesTimeframe(mode, asset.symbol, asset.exchange, timeframeSelect.value);
            toast(`Timeframe updated for ${asset.symbol}.`, 'success');
          } catch (err) {
            toast(`Failed to update timeframe: ${err.message}`, 'error');
          }
        });
        const timeframeCell = el('td');
        timeframeCell.appendChild(timeframeSelect);
        row.appendChild(timeframeCell);

        const leverageInput = el('input', { type: 'number', min: '1', step: '1', value: String(asset.leverage) });
        leverageInput.addEventListener('change', async () => {
          try {
            await Api.setFuturesLeverage(mode, asset.symbol, asset.exchange, Number(leverageInput.value));
            toast(`Leverage updated for ${asset.symbol}.`, 'success');
          } catch (err) {
            toast(`Failed to update leverage: ${err.message}`, 'error');
          }
        });
        const leverageCell = el('td');
        leverageCell.appendChild(leverageInput);
        row.appendChild(leverageCell);

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
              await Api.setFuturesStrategy(mode, asset.symbol, asset.exchange, strategySelect.value);
              toast(`Strategy updated for ${asset.symbol}.`, 'success');
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
            await Api.setFuturesStrategyMode(mode, asset.symbol, asset.exchange, autoSelectCheckbox.checked ? 'auto' : 'manual');
            toast(`Auto-select strategies ${autoSelectCheckbox.checked ? 'enabled' : 'disabled'} for ${asset.symbol}.`, 'success');
            await refreshWatchlist(mode);
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
        if (mode === 'real') {
          autoTradeCheckbox.title = 'Also requires ENABLE_FUTURES_AUTO_TRADING=true on the server (a restart-only .env setting) — this checkbox alone does not enable real autonomous trading.';
        }
        autoTradeCheckbox.addEventListener('change', async () => {
          try {
            const result = await Api.setFuturesAutoTrade(mode, asset.symbol, asset.exchange, autoTradeCheckbox.checked);
            toast(result.message || `Auto-trade ${autoTradeCheckbox.checked ? 'enabled' : 'disabled'} for ${asset.symbol}.`, 'success');
          } catch (err) {
            autoTradeCheckbox.checked = !autoTradeCheckbox.checked;
            toast(`Failed to update auto-trade: ${err.message}`, 'error');
          }
        });
        const autoTradeCell = el('td');
        autoTradeCell.appendChild(autoTradeCheckbox);
        row.appendChild(autoTradeCell);

        const tradeBtn = el('button', { type: 'button' }, 'Trade');
        tradeBtn.addEventListener('click', () => tradeWatchlistAsset(asset, mode));
        const tradeCell = el('td');
        tradeCell.appendChild(tradeBtn);
        row.appendChild(tradeCell);

        const removeBtn = el('button', { type: 'button' }, 'Remove');
        removeBtn.addEventListener('click', async () => {
          try {
            await Api.removeFuturesAsset(mode, asset.symbol, asset.exchange);
            await refreshWatchlist(mode);
          } catch (err) {
            toast(`Failed to remove: ${err.message}`, 'error');
          }
        });
        const removeCell = el('td');
        removeCell.appendChild(removeBtn);
        row.appendChild(removeCell);

        body.appendChild(row);
      });
    } catch (err) {
      toast(`Failed to load ${mode} futures Signals Setting: ${err.message}`, 'error');
    }
  }

  async function refreshBothWatchlists() {
    await refreshWatchlist('demo');
    if (ModeSwitcher.isRealUnlocked()) await refreshWatchlist('real');
  }

  async function addCurrentSymbolToWatchlist(mode) {
    const symbol = getCurrentSymbol();
    if (!symbol) {
      toast('Enter a symbol first.', 'error');
      return;
    }
    try {
      await Api.addFuturesAsset(mode, { symbol, exchange: EXCHANGE, leverage: 3 });
      toast(`${symbol} added to your ${mode === 'real' ? 'Real' : 'Demo'} Futures Signals Setting.`, 'success');
      await refreshWatchlist(mode);
    } catch (err) {
      toast(`Failed to add to Signals Setting: ${err.message}`, 'error');
    }
  }

  // Demo-only bulk enable, mirroring dashboard.js's enableAutoTradeForAll() exactly — the
  // per-row checkbox above only ever applies to one symbol at a time. Deliberately has NO Real
  // equivalent: bulk-enabling real, leveraged, unattended trading for every real-watchlisted
  // symbol in one click would undermine the whole point of that list being a deliberate,
  // one-at-a-time opt-in — that stays a conscious per-symbol decision no matter how many symbols
  // are watched.
  async function enableAutoTradeForAll() {
    const assets = watchlistCache.demo;
    if (assets.length === 0) {
      toast('Your Demo Futures Signals Setting is empty — add a symbol first.', 'error');
      return;
    }
    const btn = document.getElementById('futures-demo-enable-all-autotrade-btn');
    btn.disabled = true;
    let succeeded = 0;
    const failures = [];
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      btn.textContent = `Enabling... (${i + 1}/${assets.length})`;
      try {
        await Api.setFuturesAutoTrade('demo', asset.symbol, asset.exchange, true);
        succeeded += 1;
      } catch (err) {
        failures.push(`${asset.symbol}: ${err.message}`);
      }
    }
    btn.disabled = false;
    btn.textContent = '🤖 Enable Auto-Trade for All';
    await refreshWatchlist('demo');
    if (failures.length === 0) {
      toast(`Demo AI Auto-Trade enabled for all ${succeeded} Demo Futures Signals Setting symbol(s).`, 'success');
    } else {
      toast(`Enabled ${succeeded}/${assets.length}. Failed: ${failures.join('; ')}`, 'error');
    }
  }

  // ---------- real-unlock visibility ----------

  // Real Futures now spans two tabs: the Real Trading tab (4 cards: portfolio/P&L/order
  // form/history) and the Watchlist tab's "Futures Watchlist — Real" card — both gated behind the
  // same single Real Trading unlock (ModeSwitcher.onRealUnlock below), so unlocking once reveals
  // everything real-futures-related across both tabs at once.
  function updateRealPanelVisibility() {
    const unlocked = ModeSwitcher.isRealUnlocked();
    document.getElementById('futures-real-portfolio-card').hidden = !unlocked;
    document.getElementById('futures-real-pnl-card').hidden = !unlocked;
    document.getElementById('futures-real-order-card').hidden = !unlocked;
    document.getElementById('futures-real-orders-card').hidden = !unlocked;
    document.getElementById('futures-real-watchlist-locked-hint').hidden = unlocked;
    document.getElementById('futures-real-watchlist-panel').hidden = !unlocked;
    document.getElementById('futures-add-real-watchlist-btn').hidden = !unlocked;
    if (unlocked) {
      refreshPortfolio('real');
      refreshWatchlist('real');
    }
  }

  // ---------- init ----------

  async function loadStrategyOptions() {
    try {
      strategiesCache = await Api.listStrategies();
    } catch {
      strategiesCache = [];
    }
  }

  function init() {
    const symbolInput = document.getElementById('futures-symbol-input');
    symbolInput.addEventListener('input', () => { showSymbolSuggestions(symbolInput.value); updateCurrentSymbolLabels(); });
    // Show the *full* list on focus rather than filtering by whatever's already in the field —
    // otherwise focusing the input with its pre-filled default value (e.g. "BTC/USDT:USDT")
    // filters the suggestions down to just that one exact match instead of letting the user
    // browse everything, which was the exact symptom of an earlier bug report (mirrors
    // dashboard.js's identical fix for the Spot symbol picker).
    symbolInput.addEventListener('focus', () => showSymbolSuggestions(''));
    symbolInput.addEventListener('blur', hideSymbolSuggestions);

    const suggestionsList = document.getElementById('futures-symbol-suggestions-list');
    suggestionsList.addEventListener('mousedown', (e) => e.preventDefault());
    suggestionsList.addEventListener('click', (e) => {
      if (e.target.tagName !== 'LI') return;
      symbolInput.value = e.target.textContent;
      hideSymbolSuggestions();
      updateCurrentSymbolLabels();
    });

    document.getElementById('futures-add-demo-watchlist-btn').addEventListener('click', () => addCurrentSymbolToWatchlist('demo'));
    document.getElementById('futures-add-real-watchlist-btn').addEventListener('click', () => addCurrentSymbolToWatchlist('real'));
    document.getElementById('futures-demo-enable-all-autotrade-btn').addEventListener('click', enableAutoTradeForAll);

    initOrderForm('demo', 'futures-demo-order-form');
    initOrderForm('real', 'futures-real-order-form');

    ModeSwitcher.onRealUnlock(updateRealPanelVisibility);

    loadStrategyOptions().then(() => refreshWatchlist('demo'));
    refreshSymbolSuggestions();
    updateCurrentSymbolLabels();
    refreshPortfolio('demo');
    updateRealPanelVisibility();

    // Light polling while the Demo/Real Trading tabs are visible, matching Spot dashboard's own
    // cadence — keeps unrealized P&L/liquidation distance from going stale during an open
    // session. Futures cards now live inside those tabs rather than their own, so this checks
    // both.
    setInterval(() => {
      const demoActive = document.getElementById('tab-demo')?.classList.contains('tab-panel--active');
      const realActive = document.getElementById('tab-real')?.classList.contains('tab-panel--active');
      if (demoActive || realActive) refreshBothPortfolios();
    }, 30_000);
  }

  return { init, refreshPortfolio, refreshBothPortfolios, refreshWatchlist, refreshBothWatchlists };
})();
