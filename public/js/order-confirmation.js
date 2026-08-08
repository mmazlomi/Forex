'use strict';

/**
 * Shared order-confirmation dialog for both Demo and Real. Real orders additionally require
 * typing the literal word CONFIRM before the Submit button will do anything — this matches
 * the backend's own requirement (real-orders.js only proceeds when confirmationText === 'CONFIRM'),
 * so the UI can't accidentally let a click through that the server would reject anyway.
 */
const OrderConfirmation = (() => {
  const backdrop = document.getElementById('confirm-dialog-backdrop');
  const title = document.getElementById('confirm-dialog-title');
  const details = document.getElementById('confirm-dialog-details');
  const realExtra = document.getElementById('confirm-dialog-real-extra');
  const textInput = document.getElementById('confirm-dialog-text-input');
  const errorText = document.getElementById('confirm-dialog-error');
  const cancelBtn = document.getElementById('confirm-dialog-cancel');
  const submitBtn = document.getElementById('confirm-dialog-submit');

  function row(label, value) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    div.append(dt, dd);
    return div;
  }

  function show({ mode, symbol, exchange, side, price, stopLoss, takeProfit, estimatedValue, orderType, limitPrice, triggerPrice, leverage, liquidationPrice }) {
    return new Promise((resolve) => {
      const isPending = orderType && orderType !== 'market';
      title.textContent = mode === 'real' ? 'Confirm REAL Order' : 'Confirm Demo Order';
      details.innerHTML = '';
      const rows = [
        row('Symbol', `${symbol} (${exchange})`),
        row('Side', side.toUpperCase()),
      ];
      if (leverage != null) rows.push(row('Leverage', `${leverage}x`));
      rows.push(row('Order Type', (orderType || 'market').replace('_', '-').toUpperCase()));
      // A non-market order won't fill at today's price, so label it as a reference only rather
      // than implying that's what the order will execute at.
      rows.push(row(isPending ? 'Current market price (reference only)' : 'Price (approx.)', String(price)));
      if (limitPrice != null) rows.push(row('Limit Price', String(limitPrice)));
      if (triggerPrice != null) rows.push(row('Trigger (Stop) Price', String(triggerPrice)));
      rows.push(
        row('Stop-loss', stopLoss != null ? String(stopLoss) : 'n/a (closing order)'),
        row('Take-profit', takeProfit != null ? String(takeProfit) : 'n/a (closing order)')
      );
      // Only known before submit for Demo (estimated, see liquidation-estimate.js) — Real's
      // liquidation price comes from KuCoin itself only after the position is actually opened, so
      // there is nothing exact to show here yet for a Real leveraged order.
      if (liquidationPrice != null) rows.push(row('Est. liquidation price', String(liquidationPrice)));
      rows.push(row('Estimated value', estimatedValue != null ? `~${estimatedValue}` : 'sized by risk engine on submit'));
      if (orderType === 'oco') {
        rows.push(row('Note', 'Places TWO linked orders (take-profit + stop-loss) against your existing position — whichever fills first cancels the other.'));
      } else if (isPending) {
        rows.push(row('Note', 'Sits pending until price crosses your limit/trigger — checked periodically, not instant.'));
      }
      if (leverage != null && mode === 'real') {
        rows.push(row('Note', 'Real leveraged position — liquidation risk applies. The exact liquidation price is set by KuCoin once the position opens.'));
      }
      details.append(...rows);

      errorText.hidden = true;
      textInput.value = '';
      realExtra.hidden = mode !== 'real';
      backdrop.hidden = false;

      function cleanup(result) {
        backdrop.hidden = true;
        cancelBtn.removeEventListener('click', onCancel);
        submitBtn.removeEventListener('click', onSubmit);
        resolve(result);
      }

      function onCancel() {
        cleanup({ confirmed: false });
      }

      function onSubmit() {
        if (mode === 'real' && textInput.value !== 'CONFIRM') {
          errorText.textContent = 'Type CONFIRM exactly to proceed with a real order.';
          errorText.hidden = false;
          return;
        }
        cleanup({ confirmed: true, confirmationText: mode === 'real' ? textInput.value : undefined });
      }

      cancelBtn.addEventListener('click', onCancel);
      submitBtn.addEventListener('click', onSubmit);
    });
  }

  return { show };
})();
