#!/usr/bin/env node
'use strict';

/**
 * electron-guard.js — cross-platform wrapper around scripts/fix-electron-signing.sh.
 *
 * npm runs lifecycle scripts through cmd.exe on Windows, where `bash` and
 * `uname` do not exist, so the shell script cannot be invoked directly from
 * package.json. This shim is the platform gate: on anything other than macOS
 * it is a silent no-op, and it never propagates a non-zero exit from the fix
 * script, so `npm install` can't be broken by it.
 *
 * Modes:
 *   --fix        de-quarantine + ad-hoc sign the Electron bundle (postinstall)
 *   --fix --force  same, but ignore the CI skip (manual `npm run fix:electron`)
 *   --preflight  verify the Electron binary is on disk before launching it
 *   --ensure     --fix followed by --preflight (predev / prestart)
 *
 * See the "Electron on macOS: XProtect false positives" section of README.md.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIX_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fix-electron-signing.sh');

/**
 * Path to the Electron executable, or null if the package isn't installed.
 * `require('electron')` returns the path string when running under plain Node;
 * it throws if the install never completed.
 */
function electronExecutablePath() {
  try {
    return require('electron');
  } catch (_) {
    // The package may exist with a broken/absent path.txt. Fall back to the
    // conventional layout so we can still report a useful path to the user.
    try {
      const pkgDir = path.dirname(require.resolve('electron/package.json', { paths: [REPO_ROOT] }));
      const rel =
        process.platform === 'darwin'
          ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
          : process.platform === 'win32'
            ? 'electron.exe'
            : 'electron';
      return path.join(pkgDir, 'dist', rel);
    } catch (_e) {
      return null;
    }
  }
}

function runFix({ force }) {
  if (process.platform !== 'darwin') return; // Linux / Windows: nothing to do.
  if (process.env.CI && !force) return; // CI installs aren't XProtect-affected.
  if (!fs.existsSync(FIX_SCRIPT)) return;

  const res = spawnSync('bash', [FIX_SCRIPT], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (res.error) {
    console.warn(`electron-guard: could not run ${path.relative(REPO_ROOT, FIX_SCRIPT)}: ${res.error.message}`);
  }
  // Intentionally ignore res.status — this must never fail an install.
}

function preflight() {
  const exe = electronExecutablePath();

  if (!exe || !fs.existsSync(exe)) {
    const where = exe ? `\n    ${exe}\n` : '\n';
    if (process.platform === 'darwin') {
      console.error(
        `\nThe Electron binary is missing:${where}` +
          '\nOn macOS this is almost always Apple\'s XProtect scanner false-positiving on\n' +
          'the unsigned Electron binary in node_modules and moving it to the Trash.\n' +
          '\nRepair it with:\n' +
          '\n    npm install && npm run fix:electron\n'
      );
    } else {
      console.error(
        `\nThe Electron binary is missing:${where}` + '\nRepair it with:\n\n    npm install\n'
      );
    }
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const mode = args.find((a) => a === '--fix' || a === '--preflight' || a === '--ensure') || '--ensure';

if (mode === '--fix' || mode === '--ensure') runFix({ force });
if (mode === '--preflight' || mode === '--ensure') preflight();
