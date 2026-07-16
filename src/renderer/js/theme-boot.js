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

  // Tag the real macOS desktop app so the Liquid Glass material
  // (styles/liquid-glass.css) applies there and nowhere else. We trust only the
  // preload's `window.api.isMac`, which the Electron preload sets synchronously
  // before this head script runs — the frosted chrome is therefore present on
  // first paint, with no opaque → glass flash. We intentionally do NOT fall back
  // to the user agent: the glass relies on the native window vibrancy that only
  // the macOS Electron shell provides, so a Mac browser or an iPad WebView (no
  // vibrancy) must keep the standard opaque chrome.
  try {
    if (window.api && window.api.isMac === true) {
      document.documentElement.classList.add('platform-mac');
    }
  } catch (e) { /* leave chrome opaque if detection fails */ }
})();
