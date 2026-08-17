'use strict';

/*
 * Headless verification that the assembled www/ bundle actually runs in a real
 * browser engine (the same Chromium the Android WebView is built on): boots
 * without CSP/JS errors, loads a PDF through PDF.js, renders pages, and exports
 * bytes through pdf-lib. Run after `npm run build:web`.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Playwright is an optional harness dependency (not needed to build the app or
// the APK), so give a clear hint instead of a raw MODULE_NOT_FOUND if it's absent.
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  console.error('[verify-web] needs Playwright. Install it, then re-run:\n' +
    '  npm i --no-save playwright && npx playwright install chromium\n' +
    '  npm run verify:web');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.map': 'application/json'
};

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
  // Fall back to Playwright's own browser resolution (e.g. installed via
  // `npx playwright install chromium` in CI).
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (_) { /* none */ }
  return undefined;
}

function serve(dir) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

(async () => {
  const server = await serve(WWW);
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();

  const errors = [];
  // The generic "Failed to load resource" console line carries no URL; track
  // real resource failures via response/requestfailed and ignore the browser's
  // automatic /favicon.ico probe (not part of the app).
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    if (!/favicon\.ico$/.test(r.url())) errors.push('requestfailed: ' + r.url());
  });

  let result = {};
  try {
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });

    // Wait for the app modules to wire up.
    await page.waitForFunction('window.App && App.Viewer && App.Save && window.api', null, { timeout: 15000 });

    // Confirm the adapter is the web one (window.api present, no Electron preload).
    const apiOk = await page.evaluate(() => typeof window.api.openPdfDialog === 'function' &&
      typeof window.api.savePdfDialog === 'function');

    // Load a fixture PDF the same way Viewer.load receives it (an ArrayBuffer).
    const pdfB64 = fs.readFileSync(path.join(ROOT, 'test/fixtures/sample.pdf')).toString('base64');
    result = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await App.Viewer.load(u8.buffer, 'sample.pdf', null);
      for (let i = 0; i < 80 && !App.state.numPages; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 800));

      // Exercise the export path (pdf-lib) with a placed stamp.
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAvyQP9vYaMtwAAAABJRU5ErkJggg==';
      App.state.placements.push({ id: 1, type: 'image', page: 1, vx: 60, vy: 60, vw: 120, vh: 40, dataUrl: png, aspect: 3 });
      let bytesLen = 0, saveErr = '';
      try { bytesLen = (await App.Save.buildBytes()).length; } catch (e) { saveErr = e.message; }

      return {
        numPages: App.state.numPages || 0,
        canvases: document.querySelectorAll('#viewer .page canvas').length,
        emptyHidden: document.querySelector('#empty-state').classList.contains('hidden'),
        fileName: App.state.fileName,
        filePath: App.state.filePath,
        bytesLen, saveErr
      };
    }, pdfB64);
    result.apiOk = apiOk;

    // Rail/header flyouts are renderer-only, so the WebView gets the same wiring
    // as Electron: only one may be open at a time (opening a second used to leave
    // the first stacked behind it), and the Measure menu's inline controls must
    // NOT dismiss it.
    result.dropdowns = await page.evaluate(async () => {
      const $ = (s) => document.querySelector(s);
      const tick = () => new Promise((r) => setTimeout(r, 60));
      const shown = (s) => !$(s).classList.contains('hidden');
      const openCount = () => document.querySelectorAll('.tb-menu:not(.hidden)').length;
      let maxOpen = 0;
      const gauge = () => { maxOpen = Math.max(maxOpen, openCount()); };

      $('#btn-measure').click(); await tick(); gauge();
      const measureAlone = shown('#measure-menu') && openCount() === 1;
      $('#btn-markup').click(); await tick(); gauge();
      const swapped = shown('#markup-menu') && !shown('#measure-menu');
      $('#btn-document').click(); await tick(); gauge();
      const swapped2 = shown('#document-menu') && !shown('#markup-menu');
      $('#btn-document').click(); await tick(); gauge();
      const selfClosed = openCount() === 0;

      $('#btn-measure').click(); await tick(); gauge();
      $('#measure-snap').click(); await tick(); gauge();
      const stickyOpen = shown('#measure-menu');
      $('#measure-snap').click(); await tick();

      const modeBefore = App.state.mode;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick(); gauge();
      const escClosed = !shown('#measure-menu') && App.state.mode === modeBefore;

      $('#btn-markup').click(); await tick(); gauge();
      $('#viewerContainer').click(); await tick(); gauge();
      const outsideClosed = openCount() === 0;

      return { measureAlone, swapped, swapped2, selfClosed, stickyOpen, escClosed, outsideClosed, maxOpen };
    });
  } finally {
    await browser.close();
    server.close();
  }

  const d = result.dropdowns || {};
  const dropdownsOk = d.measureAlone && d.swapped && d.swapped2 && d.selfClosed &&
    d.stickyOpen && d.escClosed && d.outsideClosed && d.maxOpen <= 1;
  const ok = !errors.length && result.apiOk && result.numPages > 0 &&
    result.canvases > 0 && result.emptyHidden && result.bytesLen > 0 && !result.saveErr &&
    dropdownsOk;
  console.log('[verify-web] result:', JSON.stringify(result, null, 2));
  if (errors.length) console.log('[verify-web] page errors:\n' + errors.join('\n'));
  if (!dropdownsOk) console.log('[verify-web] dropdown exclusivity FAILED:', JSON.stringify(d));
  console.log(ok ? '\n[verify-web] PASS — bundle runs in a browser engine.' : '\n[verify-web] FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('[verify-web] harness error:', e); process.exit(1); });
