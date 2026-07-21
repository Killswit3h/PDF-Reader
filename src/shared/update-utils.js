'use strict';

/*
 * Pure main-process helpers: version comparison, repo-slug parsing, and picking
 * a launch file out of argv. No Electron, no global state — `main.js` requires
 * these and unit tests exercise them directly. `fileFromArgv` takes an injected
 * `existsFn` (defaults to fs.existsSync) so tests need no real files.
 */
const fs = require('fs');

// Parse "owner/repo" from a GitHub repository URL, or null.
function repoSlug(url) {
  const m = String(url || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Numeric compare of "x.y.z" (a leading "v" is tolerated). >0 if a is newer.
function semverCmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Every existing "*.pdf" argument, in argv order. `existsFn` is injectable for
// tests. Selecting several PDFs in Explorer/Finder and choosing "Open" can hand
// the app all of them at once (via argv, or a batched second-instance), so the
// launch path must be able to open more than one.
function filesFromArgv(argv, existsFn) {
  const exists = existsFn || fs.existsSync;
  return (argv || []).filter(
    (a) => a && a.toLowerCase().endsWith('.pdf') && exists(a)
  );
}

// First existing "*.pdf" argument, or null. `existsFn` is injectable for tests.
function fileFromArgv(argv, existsFn) {
  return filesFromArgv(argv, existsFn)[0] || null;
}

// Can this build install an update in-app (electron-updater downloadUpdate +
// quitAndInstall)? Only when packaged, and — for now — only on Windows: our
// macOS artifacts are unsigned (release.yml sets CSC_IDENTITY_AUTO_DISCOVERY
// false), and electron-updater's mac installer rejects an unsigned update, so
// mac falls back to opening the download page until signing lands. In dev
// (unpackaged) there is no app-update.yml, so it also can't self-update.
function canInstallInApp(platform, isPackaged) {
  return isPackaged === true && platform === 'win32';
}

module.exports = { repoSlug, semverCmp, fileFromArgv, filesFromArgv, canInstallInApp };
