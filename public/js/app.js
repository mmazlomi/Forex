'use strict';

// Surfaces otherwise-silent script failures as a visible on-page banner. Without this, a single
// thrown error anywhere in Dashboard.init() (which runs synchronously top-to-bottom, wiring one
// button's event listener after another) aborts every listener registration *after* the failing
// line — several unrelated buttons quietly stop working with zero visible symptom, which is very
// hard to diagnose from a bug report alone (especially on a device/browser this project has no
// way to test directly). This does not fix the underlying error; it makes it reportable.
function showFatalErrorBanner(message) {
  let banner = document.getElementById('fatal-error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatal-error-banner';
    banner.className = 'fatal-error-banner';
    document.body.prepend(banner);
  }
  banner.textContent = `A script error occurred and some features may not work: ${message}`;
}

window.addEventListener('error', (e) => {
  showFatalErrorBanner(e.message || 'unknown error');
});
window.addEventListener('unhandledrejection', (e) => {
  showFatalErrorBanner(e.reason && e.reason.message ? e.reason.message : String(e.reason));
});

document.addEventListener('DOMContentLoaded', () => {
  try {
    AuthGate.init(() => {
      try {
        Dashboard.init();
        Futures.init();
      } catch (err) {
        showFatalErrorBanner(err.message);
        throw err;
      }
    });
  } catch (err) {
    showFatalErrorBanner(err.message);
    throw err;
  }
});
