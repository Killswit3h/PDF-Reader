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

  // Tag the two Apple hosts so the Liquid Glass material
  // (styles/liquid-glass.css) applies there and nowhere else. html.lg-glass is
  // the material; html.platform-mac / html.platform-ios carry what differs.
  // Both signals exist synchronously before this head script runs, so the
  // frosted chrome is present on first paint, with no opaque -> glass flash:
  //
  //  - macOS: the Electron preload sets window.api.isMac. The glass there frosts
  //    the desktop through the window's native vibrancy.
  //  - iOS/iPadOS: Capacitor injects window.Capacitor as a WKUserScript at
  //    document start (before any page script). A WebView has no vibrancy, so
  //    the iOS scope frosts the app's own content instead.
  //
  // We intentionally do NOT fall back to the user agent: a Mac or iPad *browser*
  // running the web build is neither host, and keeps the standard opaque chrome.
  try {
    var root = document.documentElement;
    if (window.api && window.api.isMac === true) {
      root.classList.add('lg-glass', 'platform-mac');
    } else {
      var cap = window.Capacitor;
      if (cap && typeof cap.getPlatform === 'function' && cap.getPlatform() === 'ios') {
        root.classList.add('lg-glass', 'platform-ios');
      }
    }
  } catch (e) { /* leave chrome opaque if detection fails */ }
})();
