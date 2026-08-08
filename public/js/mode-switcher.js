'use strict';

/**
 * Tracks the active Demo/Real context (used when generating signals) and the separate
 * Real Trading "unlock" state, which is deliberately independent of the header switcher —
 * switching the header to Real does not itself enable order placement; the Real tab's own
 * typed-confirmation unlock does. Both are session-only (reset on page reload) by design.
 */
const ModeSwitcher = (() => {
  let currentMode = 'demo';
  let realUnlocked = false;
  const listeners = [];
  const realUnlockListeners = [];

  function onChange(fn) {
    listeners.push(fn);
  }

  // Lets other modules (e.g. futures.js) react to the Real Trading unlock without this module
  // needing to know about their DOM — mirrors onChange()'s pattern.
  function onRealUnlock(fn) {
    realUnlockListeners.push(fn);
  }

  function notify() {
    listeners.forEach((fn) => fn(currentMode));
  }

  function setMode(mode) {
    if (mode !== 'demo' && mode !== 'real') return;
    currentMode = mode;

    document.getElementById('mode-demo-btn').classList.toggle('mode-btn--active', mode === 'demo');
    document.getElementById('mode-real-btn').classList.toggle('mode-btn--active', mode === 'real');

    const badge = document.getElementById('mode-badge');
    badge.textContent = mode === 'demo' ? 'DEMO MODE' : 'REAL MODE';
    badge.className = `mode-badge mode-badge--${mode}`;

    notify();
  }

  function getMode() {
    return currentMode;
  }

  function isRealUnlocked() {
    return realUnlocked;
  }

  function unlockReal(phrase) {
    if (phrase.trim() !== 'I UNDERSTAND THE RISK') {
      return { ok: false, message: 'Phrase does not match. Type it exactly as shown.' };
    }
    realUnlocked = true;
    document.getElementById('real-locked-panel').hidden = true;
    document.getElementById('real-unlocked-panel').hidden = false;
    document.getElementById('real-portfolio-card').hidden = false;
    document.getElementById('real-pnl-card').hidden = false;
    document.getElementById('real-order-card').hidden = false;
    document.getElementById('real-pending-orders-card').hidden = false;
    document.getElementById('real-orders-card').hidden = false;
    realUnlockListeners.forEach((fn) => fn());
    return { ok: true };
  }

  function init() {
    document.getElementById('mode-demo-btn').addEventListener('click', () => setMode('demo'));
    document.getElementById('mode-real-btn').addEventListener('click', () => setMode('real'));
    setMode('demo');
  }

  return { init, setMode, getMode, onChange, isRealUnlocked, unlockReal, onRealUnlock };
})();
