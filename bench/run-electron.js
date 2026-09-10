'use strict';

/*
 * Electron bench: spawn the real app under the SMOKE_PERF harness (the same
 * scenario test/e2e/run.js asserts), capture its `[perf] {json}` line, and
 * write the result next to the Chromium runs in docs/perf/results/.
 *
 *   npm run bench:electron
 *   node bench/run-electron.js --label electron-mac-m2
 *
 * On Linux CI or a headless box wrap it in xvfb-run, as the e2e suite is.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const electronPath = require('electron');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('--') ? true : v;
}

const env = Object.assign({}, process.env, {
  SMOKE_TEST: '1',
  SMOKE_PERF: L.fixturePath('dense-plans.pdf'),
  SMOKE_PERF_HEAVY: L.fixturePath('heavy-markup.pdf')
});
delete env.ELECTRON_RUN_AS_NODE;
const profile = path.join(os.tmpdir(), `fieldmark-bench-${process.pid}`);
const res = spawnSync(electronPath, ['.', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`], {
  cwd: L.ROOT, env, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024
});
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* ignore */ }
const out = (res.stdout || '') + (res.stderr || '');
const line = out.split('\n').find((l) => l.includes('[perf] '));
if (!line || line.indexOf('{') < 0) {
  console.error('[bench:electron] no [perf] result. Output tail:\n' + out.slice(-1500));
  process.exit(1);
}
const result = JSON.parse(line.slice(line.indexOf('{')));
const label = arg('label', result.label || 'electron');
result.label = label;
console.log('\n' + L.markdown(result, label) + '\n');
const jsonOut = arg('json', null);
if (jsonOut && jsonOut !== true) { fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2) + '\n'); console.log('[bench:electron] wrote ' + jsonOut); }
else console.log('[bench:electron] wrote ' + L.writeResult(result, label));
