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

// First existing "*.pdf" argument, or null. `existsFn` is injectable for tests.
function fileFromArgv(argv, existsFn) {
  const exists = existsFn || fs.existsSync;
  const candidate = (argv || []).find(
    (a) => a && a.toLowerCase().endsWith('.pdf') && exists(a)
  );
  return candidate || null;
}

module.exports = { repoSlug, semverCmp, fileFromArgv };
