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
  // Quad-based text markups, exported with a generated /AP appearance stream.
  { type: 'texthighlight', expect: 'Highlight', quads: [{ x: 60, y: 560, w: 120, h: 14 }] },
  { type: 'underline', expect: 'Underline', quads: [{ x: 60, y: 590, w: 120, h: 14 }] },
  { type: 'strikeout', expect: 'StrikeOut', quads: [{ x: 60, y: 620, w: 120, h: 14 }] }
];

/*
 * Measurement matrix. `it` is the /IT dimension intent the annotation must
 * carry; `measure` is whether it must hold a /Measure dictionary. Angle and
 * count are scale-independent — degrees and tallies — so they keep live
 * geometry but no calibration.
 */
const MEASURES = [
  { type: 'length', it: 'LineDimension', measure: true, pts: [{ vx: 400, vy: 60 }, { vx: 520, vy: 60 }] },
  { type: 'perimeter', it: 'PolyLineDimension', measure: true, pts: [{ vx: 400, vy: 100 }, { vx: 520, vy: 100 }, { vx: 520, vy: 160 }] },
  { type: 'area', it: 'PolygonDimension', measure: true, pts: [{ vx: 400, vy: 200 }, { vx: 520, vy: 200 }, { vx: 520, vy: 280 }] },
  { type: 'angle', it: null, measure: false, pts: [{ vx: 400, vy: 320 }, { vx: 400, vy: 380 }, { vx: 470, vy: 380 }] },
  { type: 'count', it: null, measure: false, pts: [{ vx: 400, vy: 420 }, { vx: 430, vy: 420 }, { vx: 460, vy: 420 }] },
  // Radius: 72 points of paper at 20ft/inch is exactly 20.00 ft, so a drift
  // shows up as a round number changing rather than a rounding argument.
  { type: 'radiusCenter', it: 'LineDimension', measure: true, radius: 20,
    pts: [{ vx: 400, vy: 480 }, { vx: 400, vy: 552 }] },
  { type: 'radius3', it: 'LineDimension', measure: true, radius: 20,
    pts: [{ vx: 322, vy: 500 }, { vx: 250, vy: 428 }, { vx: 178, vy: 500 }] },
  // A half circle of radius 72pt at 20ft/inch: r*theta = 72*PI points, which is
  // exactly 20*PI = 62.8319 ft. The exported polyline must sum to that, not to
  // the chord and not to the radius.
  { type: 'arcLength', it: 'PolyLineDimension', measure: true, arcLen: 20 * Math.PI,
    pts: [{ vx: 322, vy: 620 }, { vx: 250, vy: 692 }, { vx: 178, vy: 620 }] }
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
    out = await page.evaluate(async ({ b64, tools, measures }) => {
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

      // A calibrated page scale, so measurements have a real factor to encode.
      // 1 inch of paper = 20 ft, i.e. 20/72 real feet per PDF user-space unit.
      A.scales = A.scales || {};
      A.scales[1] = { factor: 20 / 72, unit: 'ft' };
      for (const mm of measures) {
        A.measureSeq = (A.measureSeq || 0) + 1;
        A.measurements.push({
          id: A.measureSeq, page: 1, type: mm.type, pts: mm.pts,
          value: 1, unit: 'ft', color: '#2f6fed', width: 1.4,
          label: `${mm.type} 1.00 ft`
        });
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

      return {
        annCount: A.annotations.length, measCount: A.measurements.length,
        bytesLen, err, b64out, flatLen, flatErr
      };
    }, { b64: pdfB64, tools: TOOLS, measures: MEASURES });

    // A correct subtype is not enough: a text markup whose /AP is missing or
    // malformed parses perfectly and renders as NOTHING in viewers that don't
    // synthesise appearances. Render the exported page twice — annotations on,
    // then off — and require the pixels inside each markup's own rect to
    // actually differ. That is the difference between "a Highlight exists" and
    // "the user can see their highlight".
    if (out.b64out) {
      out.render = await page.evaluate(async (b64) => {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const doc = await pdfjsLib.getDocument({ data: u8 }).promise;
        const p = await doc.getPage(1);
        const scale = 2;
        const vp = p.getViewport({ scale });
        const draw = async (mode) => {
          const c = document.createElement('canvas');
          c.width = vp.width; c.height = vp.height;
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          await p.render({ canvasContext: g, viewport: vp, annotationMode: mode }).promise;
          return g.getImageData(0, 0, c.width, c.height).data;
        };
        const on = await draw(pdfjsLib.AnnotationMode.ENABLE);
        const off = await draw(pdfjsLib.AnnotationMode.DISABLE);
        const want = { Highlight: 0, Underline: 0, StrikeOut: 0 };
        for (const a of await p.getAnnotations()) {
          if (!(a.subtype in want)) continue;
          const [x0, y0, x1, y1] = vp.convertToViewportRectangle(a.rect);
          const lo = { x: Math.max(0, Math.floor(Math.min(x0, x1))), y: Math.max(0, Math.floor(Math.min(y0, y1))) };
          const hi = { x: Math.min(vp.width, Math.ceil(Math.max(x0, x1))), y: Math.min(vp.height, Math.ceil(Math.max(y0, y1))) };
          let diff = 0;
          for (let py = lo.y; py < hi.y; py++) {
            for (let px = lo.x; px < hi.x; px++) {
              const i = (py * Math.floor(vp.width) + px) * 4;
              if (on[i] !== off[i] || on[i + 1] !== off[i + 1] || on[i + 2] !== off[i + 2]) diff++;
            }
          }
          want[a.subtype] = Math.max(want[a.subtype], diff);
        }
        return want;
      }, out.b64out);
    }
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
  const dated = { total: 0, creation: 0, mod: 0, sample: null };
  let parseErr = '';
  if (out.b64out) {
    try {
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
      const data = new Uint8Array(Buffer.from(out.b64out, 'base64'));
      const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
      const p1 = await doc.getPage(1);
      for (const a of await p1.getAnnotations()) {
        found[a.subtype] = (found[a.subtype] || 0) + 1;
        // /CreationDate + /M: without them Acrobat and Bluebeam show a blank
        // date column and cannot sort a markup list by when things were drawn.
        dated.total++;
        if (a.creationDate) dated.creation++;
        if (a.modificationDate) dated.mod++;
        if (!dated.sample) dated.sample = a.creationDate || a.modificationDate || null;
      }
    } catch (e) { parseErr = e.message; }
  }

  // pdf.js does not surface /Measure or /IT, so read the raw annotation
  // dictionaries. This is what proves a measurement exported as a *calibrated*
  // dimension rather than merely a polyline that happens to look right.
  const dicts = [];
  let structErr = '';
  if (out.b64out) {
    try {
      const { PDFDocument, PDFName } = require(path.join(ROOT, 'node_modules/pdf-lib/cjs/index.js'));
      const doc = await PDFDocument.load(Buffer.from(out.b64out, 'base64'), { updateMetadata: false });
      const arr = doc.getPage(0).node.Annots();
      const nm = (d, k) => { const v = d.get(PDFName.of(k)); return v ? String(v).replace(/^\//, '') : null; };
      for (let i = 0; arr && i < arr.size(); i++) {
        const a = arr.lookup(i);
        // Resolve AP -> /N -> /Resources -> /Font -> /Helv. A measurement label
        // is drawn with a Tj against that name; if the reference does not
        // resolve to a real font the label silently renders as nothing while
        // everything else about the annotation still looks correct.
        let labelFont = null;
        try {
          const ap = a.get(PDFName.of('AP'));
          const n = ap && doc.context.lookup(ap.get(PDFName.of('N')));
          const res = n && doc.context.lookup(n.dict.get(PDFName.of('Resources')));
          const fonts = res && doc.context.lookup(res.get(PDFName.of('Font')));
          const helv = fonts && doc.context.lookup(fonts.get(PDFName.of('Helv')));
          if (helv) labelFont = String(helv.get(PDFName.of('BaseFont')) || 'present').replace(/^\//, '');
        } catch (_) { /* leave null */ }
        dicts.push({
          subtype: nm(a, 'Subtype'),
          it: nm(a, 'IT'),
          measure: !!a.get(PDFName.of('Measure')),
          ap: !!a.get(PDFName.of('AP')),
          // /L is what a recipient's viewer measures. For a radius annotation it
          // must be the radius segment itself -- see FR-13.
          L: (() => {
            try {
              const arr = a.get(PDFName.of('L'));
              return arr ? arr.asArray().map((n) => n.asNumber()) : null;
            } catch (_) { return null; }
          })(),
          // /Vertices is what a viewer sums for a polyline dimension. For arc
          // length that sum IS the reported value -- see FR-7.
          V: (() => {
            try {
              const arr = a.get(PDFName.of('Vertices'));
              return arr ? arr.asArray().map((n) => n.asNumber()) : null;
            } catch (_) { return null; }
          })(),
          labelFont
        });
      }
    } catch (e) { structErr = e.message; }
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
  // Every exported annotation must carry both dates, and in the PDF wire format.
  const datesOk = dated.total > 0 && dated.creation === dated.total && dated.mod === dated.total;
  const fmtOk = !dated.sample || /^D:\d{14}(Z|[+-]\d{2}')/.test(dated.sample);
  if (!datesOk) bad++;
  if (!fmtOk) bad++;
  rows.push(`  ${datesOk ? 'OK  ' : 'FAIL'}  ${'dates'.padEnd(10)} /CreationDate ${dated.creation}/${dated.total}, /M ${dated.mod}/${dated.total}`);
  rows.push(`  ${fmtOk ? 'OK  ' : 'FAIL'}  ${'date fmt'.padEnd(10)} ${dated.sample || '(none)'}`);

  const flattened = TOOLS.filter((t) => !t.expect).map((t) => t.type);

  console.log(`[verify-tools] ${TOOLS.length} tools exported; annotations on page 1: ${JSON.stringify(found)}`);
  console.log(rows.join('\n'));
  if (flattened.length) {
    console.log(`  --  flattened by design (no annotation object): ${flattened.join(', ')}`);
    console.log(`      ^ interop gap vs Bluebeam/Acrobat — see docs/tool-parity.md`);
  }
  if (parseErr) console.log('[verify-tools] re-parse failed: ' + parseErr);
  if (errors.length) console.log('[verify-tools] page errors:\n' + errors.join('\n'));

  // Visibility: every text markup must change real pixels when annotations are
  // rendered. A generous floor — a thin underline over a short quad is only a
  // few dozen pixels — but zero means the mark is invisible.
  const rend = out.render || {};
  const invisible = Object.keys(rend).filter((k) => !(rend[k] > 20));
  console.log(`  --  appearance streams render (changed pixels): ${JSON.stringify(rend)}`);
  if (invisible.length) console.log(`  FAIL  invisible text markup: ${invisible.join(', ')}`);

  // ---- measurements: dimension intent + calibration ----
  // A polyline that merely looks right is not a takeoff. What makes it one is
  // /IT naming it a dimension and /Measure carrying the calibration, so the
  // recipient can read the scaled value and keep measuring on it.
  const mrows = [];
  let mbad = 0;
  for (const mm of MEASURES) {
    if (!mm.it) continue;                       // angle/count are scale-independent
    if (mm.radius != null || mm.arcLen != null) continue; // checked by value below
    const hit = dicts.find((d) => d.it === mm.it);
    const okM = !!hit && hit.measure === mm.measure && hit.ap && !!hit.labelFont;
    if (!okM) mbad++;
    mrows.push(`  ${okM ? 'OK  ' : 'FAIL'}  ${mm.type.padEnd(10)} /IT ${(mm.it || '-').padEnd(19)}` +
      ` measure=${hit ? hit.measure : 'ABSENT'} ap=${hit ? hit.ap : 'ABSENT'}` +
      ` labelFont=${hit ? (hit.labelFont || 'UNRESOLVED') : 'ABSENT'}`);
  }
  // ---- FR-13 / AC-6: the exported number equals the radius ----
  // The point of the radius export. A recipient's viewer recomputes the value
  // from /L, so /L has to BE the radius segment; if it ever drifts back to the
  // drawn arc, Bluebeam starts reporting the arc length while FieldMark reports
  // the radius, and the two sides disagree. That is what this catches.
  const FACTOR = 20 / 72; // the calibration the harness set: 1in = 20ft
  const lineVals = dicts
    .filter((d) => d.it === 'LineDimension' && d.L && d.L.length === 4)
    .map((d) => Math.hypot(d.L[2] - d.L[0], d.L[3] - d.L[1]) * FACTOR);
  for (const mm of MEASURES) {
    if (mm.radius == null) continue;
    const got = lineVals.find((v) => Math.abs(v - mm.radius) < 0.01);
    const okR = got != null;
    if (!okR) mbad++;
    mrows.push(`  ${okR ? 'OK  ' : 'FAIL'}  ${mm.type.padEnd(10)} /L measures ` +
      `${got != null ? got.toFixed(2) : '—'} ft, FieldMark reports R ${mm.radius.toFixed(2)} ft`);
  }
  // ---- FR-7 / AC-3: the exported polyline sums to the reported arc length ----
  // A chord polyline always under-measures a curve. This asserts the tessellation
  // is fine enough that a recipient summing /Vertices lands on the same number
  // FieldMark printed, rather than a quietly short one.
  const polyVals = dicts
    .filter((d) => d.it === 'PolyLineDimension' && d.V && d.V.length >= 4)
    .map((d) => {
      let sum = 0;
      for (let i = 2; i < d.V.length; i += 2) {
        sum += Math.hypot(d.V[i] - d.V[i - 2], d.V[i + 1] - d.V[i - 1]);
      }
      return sum * FACTOR;
    });
  for (const mm of MEASURES) {
    if (mm.arcLen == null) continue;
    const got = polyVals.find((v) => Math.abs(v - mm.arcLen) < 0.01);
    const okA = got != null;
    if (!okA) mbad++;
    const near = polyVals.length ? polyVals.map((v) => v.toFixed(2)).join(', ') : 'none';
    mrows.push(`  ${okA ? 'OK  ' : 'FAIL'}  ${mm.type.padEnd(10)} polyline sums to ` +
      `${got != null ? got.toFixed(4) : '— (saw ' + near + ')'} ft, FieldMark reports ` +
      `${mm.arcLen.toFixed(4)} ft`);
  }
  console.log(`[verify-tools] ${out.measCount} measurements exported`);
  console.log(mrows.join('\n'));
  if (structErr) console.log('[verify-tools] structural read failed: ' + structErr);

  const ok = !errors.length && !parseErr && !structErr && bad === 0 &&
    invisible.length === 0 && mbad === 0 &&
    out.annCount === TOOLS.length && out.measCount === MEASURES.length &&
    out.bytesLen > 0 && out.flatLen > 0;
  console.log(ok ? '\n[verify-tools] PASS — every tool exports the object it claims.'
    : '\n[verify-tools] FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('[verify-tools] harness error:', e); process.exit(1); });
