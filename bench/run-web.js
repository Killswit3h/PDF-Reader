'use strict';

/*
 * Desktop bench: drive the www/ build in headless Chromium — the engine the
 * Android WebView runs — through bench/probe.js and print the numbers every PR
 * reports against docs/perf/00-baseline.md.
 *
 *   npm run bench                       # build www/ then run (desktop shape)
 *   node bench/run-web.js --label x     # name the run (docs/perf/results/x-*.json)
 *   node bench/run-web.js --tablet      # iPad-shaped: 1024x1366, dpr 2, touch
 *   node bench/run-web.js --json out.json --md out.md
 *   node bench/run-web.js --pan 3000 --headed
 *
 * A --tablet run only shapes the viewport; it is not a device measurement.
 * The tablet rows in the baseline come from bench/serve.js on real hardware.
 * Needs the same optional Playwright harness as scripts/verify-web.js.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  console.error('[bench] needs Playwright. Install it, then re-run:\n' +
    '  npm i --no-save playwright && npx playwright install chromium\n  npm run bench');
  process.exit(2);
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('--') ? true : v;
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(base)) {
      if (/^chromium-\d+$/.test(d)) {
        const p = path.join(base, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* fall through */ }
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (_) { /* none */ }
  return undefined;
}

(async () => {
  const WWW = path.join(L.ROOT, 'www');
  if (!fs.existsSync(path.join(WWW, 'index.html'))) {
    console.error('[bench] no www/ bundle — run `npm run build:web` first (or `npm run bench`).');
    process.exit(2);
  }
  const tablet = !!arg('tablet', false);
  const label = arg('label', tablet ? 'chromium-tablet-shape' : 'chromium-desktop');
  const panMs = parseInt(arg('pan', '3000'), 10);
  const headed = !!arg('headed', false);

  const server = await L.serve(WWW, { host: '127.0.0.1' });
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: !headed,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext(tablet
    ? { viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  let result = null;
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.App && App.Viewer && App.Tabs && window.api', null, { timeout: 20000 });
    await page.evaluate(L.probeSource());
    await page.exposeFunction('__benchLog', (m) => console.log('[bench] ' + m));
    result = await page.evaluate(async (opts) => {
      const load = async (name) => {
        const r = await fetch('/fixtures/' + name);
        if (!r.ok) throw new Error('fixture ' + name + ' → ' + r.status);
        return r.arrayBuffer();
      };
      return window.__FMPerf.runAll(load, (m) => window.__benchLog(m), opts);
    }, { panMs });
  } catch (e) {
    console.error('[bench] harness error:', e && e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
  if (!result) process.exit(1);
  result.label = label;
  result.errors = errors;

  const md = L.markdown(result, label);
  console.log('\n' + md + '\n');
  if (errors.length) console.log('[bench] page errors during the run:\n  ' + errors.join('\n  '));
  const jsonOut = arg('json', null);
  if (jsonOut && jsonOut !== true) { fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2) + '\n'); console.log('[bench] wrote ' + jsonOut); }
  else console.log('[bench] wrote ' + L.writeResult(result, label));
  const mdOut = arg('md', null);
  if (mdOut && mdOut !== true) { fs.writeFileSync(mdOut, md + '\n'); console.log('[bench] wrote ' + mdOut); }
})();
