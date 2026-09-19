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

// True when `codesign -dv --verbose=2` output describes a REAL Developer ID
// signature. codesign writes this to stderr, and the distinguishing line is the
// authority chain: a Developer ID build prints
//   Authority=Developer ID Application: Some Name (ABCDE12345)
// while the ad-hoc signature build/mac-adhoc-sign.js applies prints
//   Signature=adhoc
// with no Authority lines and `TeamIdentifier=not set`. Kept as a pure string
// parser so it is unit-testable off macOS, where `codesign` does not exist.
function isDeveloperIdSigned(codesignOutput) {
  return /^Authority\s*=\s*Developer ID Application\b/m.test(String(codesignOutput || ''));
}

// Can this build install an update in-app (electron-updater downloadUpdate +
// quitAndInstall)?
//
// Windows: yes, once packaged.
// macOS: only when the running app carries a real Developer ID signature.
//   electron-updater drives Squirrel.Mac there, and Squirrel verifies the
//   downloaded app's signature against the running app's, refusing anything it
//   cannot match. An ad-hoc signature has no stable identity to match, so an
//   ad-hoc build can never self-install however new the download is — it falls
//   back to opening the release page, as it always has.
// Elsewhere (Linux, and any unpackaged dev build, which has no app-update.yml)
//   there is nothing to self-install.
//
// `macSigned` is only consulted on darwin; callers off macOS may omit it.
function canInstallInApp(platform, isPackaged, macSigned) {
  if (isPackaged !== true) return false;
  if (platform === 'win32') return true;
  if (platform === 'darwin') return macSigned === true;
  return false;
}

module.exports = {
  repoSlug, semverCmp, fileFromArgv, filesFromArgv, canInstallInApp, isDeveloperIdSigned
};
