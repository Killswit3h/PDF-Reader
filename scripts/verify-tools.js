'use strict';

/*
 * Per-tool export verification.
 *
 * verify-web.js proves the bundle *runs*; this proves each markup tool actually
 * lands in the exported PDF as the object it claims to be. It drives the real
 * renderer in headless Chromium (same engine as the Android WebView), creates
 * one annotation per tool, exports through the real pdf-lib path, then re-parses
 * the bytes with PDF.js and checks the annotation subtype each tool produced.
 *
 * Why subtypes matter: a Square/Circle/Ink/FreeText annotation stays selectable
 * and editable in Bluebeam Revu and Acrobat. Anything drawn into the page
 * content stream instead is flattened pixels — visually identical, but dead to
 * every other PDF tool. This script is the regression gate on that difference.
 *
 * Run after `npm run build:web`. Needs the same optional Playwright harness as
 * verify-web.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  console.error('[verify-tools] needs Playwright. Install it, then re-run:\n' +
    '  npm i --no-save playwright && npx playwright install chromium\n' +
    '  npm run verify:tools');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.map': 'application/json', '.wasm': 'application/wasm'
};

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
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

/*
 * The tool matrix. `expect` is the PDF annotation subtype the tool must produce
 * when "save editable annotations" is on. `null` means the tool is known to
 * flatten into page content and produce no annotation object — a real interop
 * gap against Bluebeam/Acrobat, pinned here so it cannot regress further and
 * so closing it shows up as a diff in this table.
 */
const TOOLS = [
  { type: 'rect', expect: 'Square', pts: [{ vx: 60, vy: 60 }, { vx: 200, vy: 140 }] },
  { type: 'ellipse', expect: 'Circle', pts: [{ vx: 230, vy: 60 }, { vx: 340, vy: 140 }] },
  { type: 'line', expect: 'Line', pts: [{ vx: 60, vy: 160 }, { vx: 200, vy: 200 }] },
  { type: 'arrow', expect: 'Line', pts: [{ vx: 230, vy: 160 }, { vx: 340, vy: 200 }] },
  { type: 'polyline', expect: 'PolyLine', pts: [{ vx: 60, vy: 220 }, { vx: 120, vy: 260 }, { vx: 180, vy: 220 }] },
  { type: 'polygon', expect: 'Polygon', pts: [{ vx: 230, vy: 220 }, { vx: 330, vy: 230 }, { vx: 280, vy: 300 }] },
  { type: 'cloud', expect: 'Polygon', pts: [{ vx: 60, vy: 320 }, { vx: 160, vy: 330 }, { vx: 110, vy: 400 }] },
  { type: 'ink', expect: 'Ink', pts: [{ vx: 230, vy: 320 }, { vx: 250, vy: 350 }, { vx: 290, vy: 320 }, { vx: 320, vy: 360 }] },
  { type: 'highlight', expect: 'Ink', pts: [{ vx: 60, vy: 430 }, { vx: 200, vy: 430 }] },
  { type: 'text', expect: 'FreeText', pts: [{ vx: 60, vy: 460 }, { vx: 220, vy: 504 }], text: 'Editable note' },
  { type: 'callout', expect: 'FreeText', pts: [{ vx: 240, vy: 460 }, { vx: 400, vy: 504 }, { vx: 450, vy: 540 }], text: 'Callout' },
  // Quad-based text markups: currently drawn into page content, not emitted as
  // Highlight/Underline/StrikeOut annotations. See docs/tool-parity.md.
  { type: 'texthighlight', expect: null, quads: [{ x: 60, y: 560, w: 120, h: 14 }] },
  { type: 'underline', expect: null, quads: [{ x: 60, y: 590, w: 120, h: 14 }] },
  { type: 'strikeout', expect: null, quads: [{ x: 60, y: 620, w: 120, h: 14 }] }
];

(async () => {
  if (!fs.existsSync(path.join(WWW, 'index.html'))) {
    console.error('[verify-tools] no www/ bundle — run `npm run build:web` first.');
    process.exit(2);
  }
  const server = await serve(WWW);
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  // The generic "Failed to load resource" console line carries no URL, so real
  // failures are tracked via response/requestfailed instead — ignoring the
  // browser's automatic /favicon.ico probe, which is not part of the app.
  // Same policy as verify-web.js.
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    if (!/favicon\.ico$/.test(r.url())) errors.push('requestfailed: ' + r.url());
  });

  let out = {};
  try {
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.App && App.Viewer && App.Save && window.api', null, { timeout: 20000 });

    const pdfB64 = fs.readFileSync(path.join(ROOT, 'test/fixtures/sample.pdf')).toString('base64');
    out = await page.evaluate(async ({ b64, tools }) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await App.Viewer.load(u8.buffer, 'sample.pdf', null);
      for (let i = 0; i < 80 && !App.state.numPages; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 800));

      const A = App.state;
      const style = () => ({ stroke: '#e5484d', fill: 'none', width: 2, opacity: 1, fontSize: 14 });
      const ids = {};
      for (const t of tools) {
        A.annoSeq = (A.annoSeq || 0) + 1;
        ids[t.type] = A.annoSeq;
        const an = { id: A.annoSeq, page: 1, style: style(), type: t.type };
        if (t.pts) an.pts = t.pts;
        if (t.quads) an.quads = t.quads;
        if (t.text) an.text = t.text;
        A.annotations.push(an);
      }

      // Export with editable annotations ON — the interop mode.
      A.saveAnnots = true;
      let b64out = '', err = '', bytesLen = 0;
      try {
        const b = await App.Save.buildBytes();
        bytesLen = b.length;
        let s = '';
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        b64out = btoa(s);
      } catch (e) { err = e.message; }

      // Export with annotations OFF — the fully flattened mode must also work.
      A.saveAnnots = false;
      let flatLen = 0, flatErr = '';
      try { flatLen = (await App.Save.buildBytes()).length; } catch (e) { flatErr = e.message; }

      return { annCount: A.annotations.length, bytesLen, err, b64out, flatLen, flatErr };
    }, { b64: pdfB64, tools: TOOLS });
  } catch (e) {
    errors.push('harness: ' + e.message);
  } finally {
    await browser.close();
    server.close();
  }

  if (out.err) errors.push('buildBytes(saveAnnots=true) threw: ' + out.err);
  if (out.flatErr) errors.push('buildBytes(saveAnnots=false) threw: ' + out.flatErr);

  // ---- re-parse the exported bytes and tally annotation subtypes ----
  const found = {};
  let parseErr = '';
  if (out.b64out) {
    try {
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
      const data = new Uint8Array(Buffer.from(out.b64out, 'base64'));
      const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
      const p1 = await doc.getPage(1);
      for (const a of await p1.getAnnotations()) {
        found[a.subtype] = (found[a.subtype] || 0) + 1;
      }
    } catch (e) { parseErr = e.message; }
  }

  // Expected subtype counts from the matrix.
  const want = {};
  for (const t of TOOLS) if (t.expect) want[t.expect] = (want[t.expect] || 0) + 1;

  const rows = [];
  let bad = 0;
  for (const sub of Object.keys(want)) {
    const ok = (found[sub] || 0) >= want[sub];
    if (!ok) bad++;
    rows.push(`  ${ok ? 'OK  ' : 'FAIL'}  ${sub.padEnd(10)} expected >=${want[sub]}, found ${found[sub] || 0}`);
  }
  const flattened = TOOLS.filter((t) => !t.expect).map((t) => t.type);

  console.log(`[verify-tools] ${TOOLS.length} tools exported; annotations on page 1: ${JSON.stringify(found)}`);
  console.log(rows.join('\n'));
  console.log(`  --  flattened by design (no annotation object): ${flattened.join(', ')}`);
  console.log(`      ^ interop gap vs Bluebeam/Acrobat — see docs/tool-parity.md`);
  if (parseErr) console.log('[verify-tools] re-parse failed: ' + parseErr);
  if (errors.length) console.log('[verify-tools] page errors:\n' + errors.join('\n'));

  const ok = !errors.length && !parseErr && bad === 0 &&
    out.annCount === TOOLS.length && out.bytesLen > 0 && out.flatLen > 0;
  console.log(ok ? '\n[verify-tools] PASS — every tool exports the object it claims.'
    : '\n[verify-tools] FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('[verify-tools] harness error:', e); process.exit(1); });
