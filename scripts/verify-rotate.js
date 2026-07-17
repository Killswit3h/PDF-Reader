'use strict';

/*
 * Headless check that the "Rotate view" button keeps overlays pinned to the
 * page — in BOTH directions:
 *   1. Render: a tiny markup placed at a known unrotated scale-1 viewport point
 *      lands where PDF.js's own rotated viewport says it should.
 *   2. Input: a pointer synthesised at that same on-screen spot maps back —
 *      through App.Viewer.pointFromEvent — to the original unrotated point. This
 *      is the path every click/drag tool (highlighter, measure, placement, sign)
 *      uses, and the direction that was silently broken on rotated pages: the
 *      mark rendered correctly but the pen landed far from the cursor.
 * We rotate through 0/90/180/270 and check both at every step.
 *
 * Reuses the www/ bundle + Chromium harness from verify-web.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (_) {
  console.error('[verify-rotate] needs Playwright:\n  npm i --no-save playwright-core');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain', '.map': 'application/json' };

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
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  let result = {};
  try {
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.App && App.Viewer && App.state', null, { timeout: 15000 });

    const pdfB64 = fs.readFileSync(path.join(ROOT, 'test/fixtures/sample.pdf')).toString('base64');
    result = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await App.Viewer.load(u8.buffer, 'sample.pdf', null);
      for (let i = 0; i < 80 && !App.state.numPages; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 800));

      // Drop a 2pt marker at a known unrotated scale-1 viewport point on page 1.
      const P = { vx: 100, vy: 130 };            // marker's top-left
      const MID = { vx: P.vx + 1, vy: P.vy + 1 }; // its centre point
      App.state.annotations.push({
        id: 999, page: 1, type: 'rect',
        pts: [{ vx: P.vx, vy: P.vy }, { vx: P.vx + 2, vy: P.vy + 2 }],
        style: { stroke: '#e00', fill: 'none', width: 1, opacity: 1 }
      });
      App.Markup.repositionAll();

      const baseVp = App.state.baseViewports[0];
      const pdfPt = baseVp.convertToPdfPoint(MID.vx, MID.vy); // rotation-invariant page anchor

      const pageDiv = () => document.querySelector('#viewer .page[data-page-number="1"]');
      const canvasOf = () => pageDiv().querySelector('canvas');
      const markerRect = () => {
        // The drawn marker is the last <rect class="hit"> in page 1's markup svg.
        const rects = pageDiv().querySelectorAll('.markup-svg rect.hit');
        return rects.length ? rects[rects.length - 1].getBoundingClientRect() : null;
      };

      async function measure(rot) {
        const div = pageDiv(), cv = canvasOf();
        const pr = div.getBoundingClientRect(), cr = cv.getBoundingClientRect();
        const cw = parseFloat(cv.style.width), ch = parseFloat(cv.style.height);
        // Ground truth: PDF.js viewport at the same on-screen scale + rotation.
        const dispScale = cw / ((rot % 180) ? baseVp.height : baseVp.width);
        const vpR = baseVp.clone({ scale: dispScale, rotation: rot });
        const gt = vpR.convertToViewportPoint(pdfPt[0], pdfPt[1]); // page-relative CSS px
        const mr = markerRect();
        const mx = mr ? (mr.left + mr.width / 2 - pr.left) : NaN;   // marker centre, page-relative
        const my = mr ? (mr.top + mr.height / 2 - pr.top) : NaN;
        // Layer must also cover the canvas exactly (sizing/translate sanity).
        const layer = pageDiv().querySelector('.markup-layer');
        const lr = layer.getBoundingClientRect();
        const boxErr = Math.max(Math.abs(lr.left - cr.left), Math.abs(lr.top - cr.top),
          Math.abs(lr.width - cr.width), Math.abs(lr.height - cr.height));
        // Input round-trip: put a pointer at the marker's on-screen centre (page
        // ground truth gt, page-relative → client coords) and confirm the tool
        // input mapper recovers the original unrotated point MID.
        const evt = { clientX: pr.left + gt[0], clientY: pr.top + gt[1] };
        const back = App.Viewer.pointFromEvent(layer, evt);
        const inErr = Math.max(Math.abs(back.vx - MID.vx), Math.abs(back.vy - MID.vy));
        return { rot, dx: +(mx - gt[0]).toFixed(2), dy: +(my - gt[1]).toFixed(2),
          boxErr: +boxErr.toFixed(2), inErr: +inErr.toFixed(2) };
      }

      const steps = [];
      steps.push(await measure(0));
      for (const r of [90, 180, 270]) {
        App.Viewer.rotate(90);
        await new Promise((res) => setTimeout(res, 800));
        App.Markup.repositionAll();
        steps.push(await measure(r));
      }
      // back to 0
      App.Viewer.rotate(90);
      await new Promise((res) => setTimeout(res, 500));

      return { numPages: App.state.numPages || 0, steps };
    }, pdfB64);
  } finally {
    await browser.close();
    server.close();
  }

  const TOL = 2.5; // CSS px (viewport points at scale 1 here)
  const steps = result.steps || [];
  const bad = steps.filter((s) => !(Math.abs(s.dx) <= TOL && Math.abs(s.dy) <= TOL
    && s.boxErr <= TOL && Math.abs(s.inErr) <= TOL));
  const ok = !errors.length && steps.length === 4 && !bad.length;
  console.log('[verify-rotate] result:', JSON.stringify(result, null, 2));
  if (errors.length) console.log('[verify-rotate] page errors:\n' + errors.join('\n'));
  if (bad.length) console.log('[verify-rotate] misaligned rotations:', JSON.stringify(bad));
  console.log(ok ? '\n[verify-rotate] PASS — overlays stay pinned through rotation.' : '\n[verify-rotate] FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('[verify-rotate] harness error:', e); process.exit(1); });
