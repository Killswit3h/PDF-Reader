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
  '.map': 'application/json', '.wasm': 'application/wasm'
};
// NOTE: .traineddata.gz is served as application/octet-stream (the fallback)
// and deliberately WITHOUT Content-Encoding: gzip. With that header the browser
// would transparently inflate the body, and tesseract — which gunzips the bytes
// itself after sniffing the gzip magic number — would then fail on them.

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
  // The app is offline by contract, so any request that leaves localhost is a
  // failure, not a warning. OCR is the feature most able to regress this: the
  // engine falls back to a CDN for its worker, WASM cores and language data the
  // moment one of those paths is wrong.
  const offsite = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!/^https?:\/\/localhost:/.test(u) && !/^(data|blob):/.test(u)) offsite.push(u);
  });
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

    // ---- OCR (AC-A-15): recognition must work in this engine, offline ----
    // Builds its own "scan" — a page whose only content is a bitmap of a word —
    // so the check is hermetic and needs no fixture. Then asserts the word is
    // real text afterwards, that it sits on top of the ink it was read from,
    // and that the user's marks survived the rebuild.
    result.ocr = await page.evaluate(async () => {
      const cv = document.createElement('canvas');
      cv.width = 1400; cv.height = 400;
      const c = cv.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = '#000';
      c.font = 'bold 150px Helvetica, Arial, sans-serif';
      c.fillText('DRAWING', 40, 200);
      const dataUrl = cv.toDataURL('image/png');

      const { PDFDocument } = window.PDFLib;
      const doc = await PDFDocument.create();
      const png = await doc.embedPng(dataUrl);
      const pg = doc.addPage([612, 792]);
      const IMG = { x: 56, y: 480, w: 500, h: 143 };
      pg.drawImage(png, { x: IMG.x, y: IMG.y, width: IMG.w, height: IMG.h });
      const bytes = await doc.save();

      await App.Viewer.load(bytes.buffer, 'scan.pdf', null);
      for (let i = 0; i < 100 && !App.state.numPages; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));

      const items = async () => {
        const p = await App.state.pdfDoc.getPage(1);
        const tc = await p.getTextContent();
        return (tc.items || []).filter((i) => i.str && i.str.trim())
          .map((i) => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5] }));
      };
      const before = (await items()).map((i) => i.str).join(' ');

      // a mark that must survive the OCR rebuild (FR-A-12)
      App.state.measurements.push({
        id: 1, page: 1, type: 'length', pts: [{ vx: 10, vy: 10 }, { vx: 90, vy: 10 }],
        value: 80, unit: 'in', label: '80 in'
      });

      const summary = await App.OCR.run({ scope: 'page', force: false });
      const after = await items();
      const inside = after.filter((i) =>
        i.x >= IMG.x - 20 && i.x <= IMG.x + IMG.w + 20 &&
        i.y >= IMG.y - 20 && i.y <= IMG.y + IMG.h + 20);

      return {
        before,
        after: after.map((i) => i.str).join(' '),
        recognized: summary.recognized,
        words: summary.words,
        failed: summary.failed,
        found: /DRAWING/i.test(after.map((i) => i.str).join(' ')),
        positioned: after.length > 0 && inside.length === after.length,
        measurementsKept: App.state.measurements.length,
        dirty: App.state.dirty
      };
    });
  } finally {
    await browser.close();
    server.close();
  }

  const o = result.ocr || {};
  const ocrOk = o.recognized === 1 && o.words > 0 && !o.failed &&
    !o.before && o.found && o.positioned && o.measurementsKept === 1 && o.dirty;

  const ok = !errors.length && !offsite.length && result.apiOk && result.numPages > 0 &&
    result.canvases > 0 && result.emptyHidden && result.bytesLen > 0 && !result.saveErr &&
    ocrOk;
  console.log('[verify-web] result:', JSON.stringify(result, null, 2));
  if (errors.length) console.log('[verify-web] page errors:\n' + errors.join('\n'));
  if (offsite.length) {
    console.log('[verify-web] OFFLINE VIOLATION — requests left the machine:\n' +
      offsite.join('\n'));
  }
  if (!ocrOk) console.log('[verify-web] OCR check failed:', JSON.stringify(o, null, 2));
  console.log(ok ? '\n[verify-web] PASS — bundle runs in a browser engine.' : '\n[verify-web] FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('[verify-web] harness error:', e); process.exit(1); });
