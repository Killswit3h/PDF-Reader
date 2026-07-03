'use strict';

/*
 * Runs synchronously in <head> before the body paints: apply the saved (or
 * OS-preferred) theme to <html data-theme> so there is no dark/light flash on
 * launch. Kept as a separate file (not inline) to satisfy the strict CSP,
 * which forbids inline scripts. Mirrors the key used by src/shared/prefs.js.
 */
(function () {
  try {
    var raw = localStorage.getItem('pdfsigner.prefs.v1');
    var t = raw ? (JSON.parse(raw) || {}).theme : null;
    if (t !== 'light' && t !== 'dark') {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
