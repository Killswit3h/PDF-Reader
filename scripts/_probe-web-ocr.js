'use strict';
/* TEMPORARY probe — deleted before the PR. Isolates tesseract itself from the
 * ocr.js pipeline so a zero-word result can be attributed to one or the other. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.map': 'application/json', '.wasm': 'application/wasm'
};

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
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();

  const reqs = [];
  const errors = [];
  page.on('request', (r) => reqs.push(r.url()));
  page.on('console', (m) => errors.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });

  let out = {};
  try {
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.App && App.OCR && window.PDFLib', null, { timeout: 20000 });

    out = await page.evaluate(async () => {
      const r = {};

      // ---- draw a high-contrast word on a canvas ----
      const cv = document.createElement('canvas');
      cv.width = 1100; cv.height = 300;
      const c = cv.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = '#000';
      c.font = 'bold 130px Helvetica, Arial, sans-serif';
      c.fillText('DRAWING', 40, 190);

      // how much ink is actually on it?
      const d = c.getImageData(0, 0, cv.width, cv.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      r.canvasDarkPx = dark;

      // ---- direct tesseract, bypassing ocr.js ----
      const t0 = Date.now();
      try {
        const T = await App.ensureLib('tesseract');
        r.tesseractType = typeof T;
        r.hasCreateWorker = typeof T.createWorker;
        const p = App.OCR._assetPaths();
        r.paths = p;

        const logs = [];
        const worker = await T.createWorker('eng', 1, {
          workerPath: p.worker, corePath: p.core, langPath: p.lang,
          cacheMethod: 'none', legacyCore: false, legacyLang: false,
          logger: (m) => { if (logs.length < 40) logs.push(m.status + ' ' + (m.progress || 0).toFixed(2)); }
        });
        r.workerCreatedMs = Date.now() - t0;
        const res = await worker.recognize(cv);
        r.recognizeMs = Date.now() - t0;
        r.rawText = (res.data.text || '').trim();
        r.rawWordCount = (res.data.words || []).length;
        r.rawWordsSample = (res.data.words || []).slice(0, 5)
          .map((w) => ({ text: w.text, conf: w.confidence, bbox: w.bbox }));
        r.hasBlocks = !!(res.data.blocks && res.data.blocks.length);
        r.logs = logs;
        await worker.terminate();
      } catch (e) {
        r.directError = e && (e.message || String(e));
      }
      return r;
    });
  } catch (e) {
    out.harnessError = e.message;
  } finally {
    await browser.close();
    server.close();
  }

  const tess = reqs.filter((u) => /tesseract|traineddata/.test(u));
  console.log('TESSERACT_REQUESTS: ' + JSON.stringify(tess, null, 2));
  console.log('ERRORS: ' + JSON.stringify(errors.slice(0, 25), null, 2));
  console.log('RESULT: ' + JSON.stringify(out, null, 2));
})();
