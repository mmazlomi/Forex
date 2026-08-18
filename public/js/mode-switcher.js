'use strict';

/**
 * Tracks the active Demo/Real context (used when generating signals) and the separate
 * Real Trading "unlock" state, which is deliberately independent of the header switcher —
 * switching the header to Real does not itself enable order placement; the Real tab's own
 * typed-confirmation unlock does. `currentMode` is session-only (reset on page reload) by
 * design. The Real Trading unlock, however, persists across page reloads for the duration of
 * the login session — stored in sessionStorage (tab-scoped, cleared automatically when the tab
 * closes) rather than re-requiring the typed confirmation phrase after every reload. It is NOT
 * tied to which account happens to be logged in, so `clearRealUnlock()` MUST be called on
 * logout — otherwise a second account logging into the same tab would inherit the previous
 * account's unlocked state without ever typing the confirmation phrase themselves. See auth.js's
 * logout handler.
 */
const ModeSwitcher = (() => {
  const REAL_UNLOCK_STORAGE_KEY = 'realTradingUnlocked';
  let currentMode = 'demo';
  let realUnlocked = false;
  const listeners = [];
  const realUnlockListeners = [];

  // sessionStorage can throw (e.g. private browsing in some browsers) — fail silently, same
  // defensive pattern charts.js uses for localStorage. Losing persistence just means the unlock
  // reverts to the original session-only behavior, never a correctness/security problem.
  function persistRealUnlocked(unlocked) {
    try {
      if (unlocked) sessionStorage.setItem(REAL_UNLOCK_STORAGE_KEY, 'true');
      else sessionStorage.removeItem(REAL_UNLOCK_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function readPersistedRealUnlocked() {
    try {
      return sessionStorage.getItem(REAL_UNLOCK_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }

  // Shared by unlockReal() (phrase just typed) and init() (restoring a persisted unlock) so the
  // two paths can never drift out of sync with each other.
  function applyRealUnlockedUI() {
    realUnlocked = true;
    document.getElementById('real-locked-panel').hidden = true;
    document.getElementById('real-unlocked-panel').hidden = false;
    document.getElementById('real-portfolio-card').hidden = false;
    document.getElementById('real-pnl-card').hidden = false;
    document.getElementById('real-order-card').hidden = false;
    document.getElementById('real-pending-orders-card').hidden = false;
    document.getElementById('real-orders-card').hidden = false;
    document.getElementById('real-trade-history-card').hidden = false;
    realUnlockListeners.forEach((fn) => fn());
  }

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
    applyRealUnlockedUI();
    persistRealUnlocked(true);
    return { ok: true };
  }

  // Must be called on logout (see auth.js) — otherwise a different account logging into the same
  // browser tab afterward would inherit this account's unlocked state. Deliberately only clears
  // the persisted flag, not the in-memory UI: the logout flow reloads the page immediately after,
  // which resets all in-memory state anyway.
  function clearRealUnlock() {
    persistRealUnlocked(false);
  }

  function init() {
    document.getElementById('mode-demo-btn').addEventListener('click', () => setMode('demo'));
    document.getElementById('mode-real-btn').addEventListener('click', () => setMode('real'));
    setMode('demo');

    // Restores the unlock across a page reload within the same login session — see this file's
    // header comment. Only ever reached after AuthGate confirms an authenticated session (see
    // app.js), so this can't restore a stale unlock for someone who isn't actually logged in.
    if (readPersistedRealUnlocked()) applyRealUnlockedUI();
  }

  return { init, setMode, getMode, onChange, isRealUnlocked, unlockReal, onRealUnlock, clearRealUnlock };
})();
