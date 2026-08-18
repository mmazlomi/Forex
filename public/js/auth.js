'use strict';

/**
 * Login/signup gate. The rest of the app (Dashboard.init()) only starts once a valid session is
 * confirmed — see app.js. Logging out reloads the page rather than trying to reset the
 * dashboard's in-memory state by hand, which is simpler and guaranteed not to leak stale data
 * from the previous session into the UI.
 */
const AuthGate = (() => {
  function showError(elId, message) {
    const node = document.getElementById(elId);
    node.textContent = message;
    node.hidden = false;
  }

  function hideError(elId) {
    document.getElementById(elId).hidden = true;
  }

  function showGate() {
    document.getElementById('auth-gate-backdrop').hidden = false;
  }

  function hideGate(username) {
    document.getElementById('auth-gate-backdrop').hidden = true;
    document.getElementById('account-username').textContent = username;
  }

  function switchTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('auth-tab-login').classList.toggle('tab-btn--active', isLogin);
    document.getElementById('auth-tab-signup').classList.toggle('tab-btn--active', !isLogin);
    document.getElementById('login-form').hidden = !isLogin;
    document.getElementById('signup-form').hidden = isLogin;
  }

  function init(onAuthenticated) {
    document.getElementById('auth-tab-login').addEventListener('click', () => switchTab('login'));
    document.getElementById('auth-tab-signup').addEventListener('click', () => switchTab('signup'));

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError('login-error');
      const form = e.target;
      try {
        const user = await Api.login(form.username.value, form.password.value);
        hideGate(user.username);
        onAuthenticated();
      } catch (err) {
        showError('login-error', err.message);
      }
    });

    document.getElementById('signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError('signup-error');
      const form = e.target;
      try {
        const user = await Api.signup(form.username.value, form.password.value);
        hideGate(user.username);
        onAuthenticated();
      } catch (err) {
        showError('signup-error', err.message);
      }
    });

    document.getElementById('logout-btn').addEventListener('click', async () => {
      // Must happen before the reload regardless of whether Api.logout() itself succeeds —
      // otherwise a different account logging into this same browser tab afterward would
      // inherit this account's persisted Real Trading unlock. See mode-switcher.js.
      ModeSwitcher.clearRealUnlock();
      try {
        await Api.logout();
      } finally {
        window.location.reload();
      }
    });

    Api.me()
      .then((result) => {
        if (result.authenticated) {
          hideGate(result.username);
          onAuthenticated();
        } else {
          showGate();
        }
      })
      .catch(() => showGate()); // network/server error: fail closed, show the login gate
  }

  return { init };
})();
