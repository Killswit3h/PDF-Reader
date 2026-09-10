'use strict';

/*
 * Generate deterministic PDF fixtures for the E2E smoke suite (test/e2e/run.js).
 * Run once with `npm run fixtures`; the outputs are committed so CI needs no
 * generation step. Uses pdf-lib (already a runtime dependency).
 *
 *   sample.pdf — 3 pages, a title + a border box per page (a "drawing" to
 *                measure/mark up).
 *   big.pdf    — 12 pages; named big.pdf because the SMOKE_WARM scenario asserts
 *                the second document's fileName switches to "big.pdf".
 *
 * Performance fixtures (bench/ + SMOKE_PERF; see docs/perf/BRIEF.md, Phase 0):
 *
 *   dense-plans.pdf  — 120 ANSI D sheets, each executing 30,000+ vector
 *                      segments: guardrail runs (rails as chained short
 *                      segments, posts, blockouts), stationing ticks and
 *                      labels, a border and a title block. The bulk linework
 *                      lives in shared form XObjects placed with per-page
 *                      transforms; the stationing, labels and title block are
 *                      unique inline content. PDF.js re-parses a form XObject
 *                      on every page it appears on and executes every segment
 *                      when rendering, so each page costs what an inline copy
 *                      would — but the file stays a few MB instead of ~40 MB.
 *                      (snap.js's CTM walk crosses form XObjects, so the
 *                      harvest path is exercised the way CAD exports do it.)
 *   scanned-set.pdf  — 40 ANSI D sheets of 300 DPI 1-bit raster (6600 x 10200
 *                      px each, unique per page so PDF.js cannot share one
 *                      decoded bitmap): border, title block, linework, speckle.
 *   heavy-markup.pdf — one ANSI D sheet carrying a FieldMark sidecar (the same
 *                      attachment pair save.js writes) with 2,000 markups —
 *                      ink, polyline, cloud, rect, text — plus 300 measurements
 *                      on a calibrated page scale.
 *
 * All three are deterministic: a seeded PRNG drives every coordinate, and the
 * document + attachment dates are pinned, so regenerating yields identical
 * bytes and a diff on these files always means a deliberate change.
 */
const { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFNumber, PDFString } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { serializeMarkupModel } = require('../../src/shared/markup-model');
const { computeValue, fmtMeasure } = require('../../src/shared/measure-math');

async function build(pages, title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792]); // US Letter
    page.drawText(`${title} — page ${i} of ${pages}`, { x: 72, y: 730, size: 20, font });
    page.drawRectangle({ x: 72, y: 90, width: 468, height: 610, borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 1 });
    page.drawText('Measure / mark up this box.', { x: 90, y: 660, size: 12, font, color: rgb(0.3, 0.3, 0.3) });
  }
  return doc.save();
}

// A one-page PDF with two prefilled AcroForm text fields (name, amount) for the
// SMOKE_FORM scenario: type into a field, save, and confirm the value persists.
async function buildForm() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Invoice form', { x: 50, y: 740, size: 18, font });
  page.drawText('Name:', { x: 50, y: 700, size: 12, font });
  page.drawText('Amount:', { x: 50, y: 660, size: 12, font });
  const form = doc.getForm();
  const name = form.createTextField('name'); name.setText('Prefilled Name');
  name.addToPage(page, { x: 120, y: 692, width: 200, height: 20 });
  const amt = form.createTextField('amount'); amt.setText('100.00');
  amt.addToPage(page, { x: 120, y: 652, width: 200, height: 20 });
  return doc.save();
}

// A 4-page ANSI D drawing set exercising every branch of automatic scale
// detection (SMOKE_AUTOSCALE), one branch per page:
//
//   1  an embedded ISO 32000 s12.9 /VP viewport, 1 in = 20 ft  -> tier A
//   2  a clean title-block note, SCALE: 1/4" = 1'-0"           -> tier B, applied
//   3  SCALE: AS NOTED plus two detail scales                  -> declared, unscaled
//   4  a bare "1:50" that the word SCALE never introduces      -> held for review
async function buildScaleSet() {
  const W = 22 * 72; const H = 34 * 72; // ANSI D
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const say = (pg, text, y, size) =>
    pg.drawText(text, { x: 60, y, size: size || 18, font, color: rgb(0, 0, 0) });

  // -- page 1: embedded measurement viewport --
  const p1 = doc.addPage([W, H]);
  say(p1, 'PLAN — embedded measurement viewport', H - 80);
  const nf = ctx.obj({});
  nf.set(PDFName.of('Type'), PDFName.of('NumberFormat'));
  nf.set(PDFName.of('U'), PDFString.of('ft'));
  nf.set(PDFName.of('C'), PDFNumber.of(20 / 72)); // 1 in = 20 ft
  const md = ctx.obj({});
  md.set(PDFName.of('Type'), PDFName.of('Measure'));
  md.set(PDFName.of('Subtype'), PDFName.of('RL'));
  md.set(PDFName.of('R'), PDFString.of('1 in = 20 ft'));
  const xa = PDFArray.withContext(ctx); xa.push(nf);
  md.set(PDFName.of('X'), xa);
  const vp = ctx.obj({});
  vp.set(PDFName.of('Type'), PDFName.of('Viewport'));
  const bb = PDFArray.withContext(ctx);
  [72, 72, W - 72, H - 200].forEach((n) => bb.push(PDFNumber.of(n)));
  vp.set(PDFName.of('BBox'), bb);
  vp.set(PDFName.of('Name'), PDFString.of('Site plan'));
  vp.set(PDFName.of('Measure'), md);
  const vpArr = PDFArray.withContext(ctx);
  vpArr.push(ctx.register(vp)); // indirect, so the reader must resolve it
  p1.node.set(PDFName.of('VP'), vpArr);

  // -- page 2: a clean title-block note --
  const p2 = doc.addPage([W, H]);
  say(p2, 'FLOOR PLAN', H - 80);
  say(p2, 'SCALE: 1/4" = 1\'-0"', 90, 14);

  // -- page 3: AS NOTED detail sheet --
  const p3 = doc.addPage([W, H]);
  say(p3, 'DETAILS', H - 80);
  say(p3, 'SCALE: AS NOTED', 90, 14);
  say(p3, '1  JAMB   SCALE: 1 1/2" = 1\'-0"', H - 200, 12);
  say(p3, '2  SILL   SCALE: 3" = 1\'-0"', H - 240, 12);

  // -- page 4: a bare ratio with no SCALE keyword --
  const p4 = doc.addPage([W, H]);
  say(p4, 'SITE', H - 80);
  say(p4, 'ratio 1:50 shown for reference', 90, 12);

  // -- page 5: an imperial note next to a plotting stamp --
  // The regression this guards: the note used to go unread, leaving the stamp
  // as the page's only candidate, and the sheet was auto-scaled in millimetres.
  // Written with a doubled apostrophe for inches, which is both a form this
  // module had to learn and one WinAnsi can encode -- the U+2032/U+2033 primes
  // that provoked the bug in the field are not encodable with a standard font,
  // so they are pinned in test/unit/scale-detect.test.js instead.
  const p5 = doc.addPage([W, H]);
  say(p5, 'PROFILE', H - 80);
  say(p5, "50.49'", H - 200, 12);
  say(p5, "SCALE: 1'' = 20'", 90, 14);
  say(p5, 'PLOT SCALE: 1:1', 70, 10);

  // -- page 6: a bare ratio on a sheet dimensioned in feet and inches --
  // Keyworded, so it used to auto-apply as millimetres. It is a review item.
  const p6 = doc.addPage([W, H]);
  say(p6, 'GRADING', H - 80);
  say(p6, 'POSTS AT 12\'-6" O.C. TYP', H - 200, 12);
  say(p6, 'SCALE 1:5', 90, 14);

  return doc.save();
}

// Build one /VP viewport dictionary carrying a rectilinear /Measure of
// `perInch` feet to the inch, covering the whole page.
function measuredViewport(ctx, w, h, perInch, label) {
  const nf = ctx.obj({});
  nf.set(PDFName.of('Type'), PDFName.of('NumberFormat'));
  nf.set(PDFName.of('U'), PDFString.of('ft'));
  nf.set(PDFName.of('C'), PDFNumber.of(perInch / 72));
  const md = ctx.obj({});
  md.set(PDFName.of('Type'), PDFName.of('Measure'));
  md.set(PDFName.of('Subtype'), PDFName.of('RL'));
  md.set(PDFName.of('R'), PDFString.of(`1 in = ${perInch} ft`));
  const xa = PDFArray.withContext(ctx); xa.push(nf);
  md.set(PDFName.of('X'), xa);
  const vp = ctx.obj({});
  vp.set(PDFName.of('Type'), PDFName.of('Viewport'));
  const bb = PDFArray.withContext(ctx);
  [36, 36, w - 36, h - 36].forEach((n) => bb.push(PDFNumber.of(n)));
  vp.set(PDFName.of('BBox'), bb);
  vp.set(PDFName.of('Name'), PDFString.of(label));
  vp.set(PDFName.of('Measure'), md);
  return vp;
}

// A set plotted half size: every sheet 11x17, which is ANSI D (22x34) with both
// dimensions halved, and no full-size sheet anywhere in the document.
//
//   1  embedded /VP, 1 in = 20 ft  -> must be applied AS IS (FR-32 / AC-14):
//      the metadata already describes the plotted geometry, so doubling it
//      would count the reduction twice.
//   2  a title-block note           -> must be DOUBLED (FR-30 / AC-12): the
//      note describes the original sheet, not this reduced print.
async function buildHalfSizeSet() {
  const W = 11 * 72; const H = 17 * 72;
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const p1 = doc.addPage([W, H]);
  p1.drawText('HALF SIZE — embedded viewport', { x: 40, y: H - 60, size: 12, font });
  const vpArr = PDFArray.withContext(ctx);
  vpArr.push(ctx.register(measuredViewport(ctx, W, H, 20, 'Reduced plan')));
  p1.node.set(PDFName.of('VP'), vpArr);

  const p2 = doc.addPage([W, H]);
  p2.drawText('HALF SIZE — title block only', { x: 40, y: H - 60, size: 12, font });
  p2.drawText('SCALE: 1/4" = 1\'-0"', { x: 40, y: 40, size: 10, font });

  return doc.save();
}


/* ------------------------------------------------------------------------- */
/* Performance fixtures                                                      */
/* ------------------------------------------------------------------------- */

const ANSI_D = { w: 22 * 72, h: 34 * 72 }; // 1584 x 2448 pt
const PINNED_DATE = new Date('2026-01-01T00:00:00Z');

// mulberry32: small, fast, and deterministic across Node versions. Every
// coordinate in the perf fixtures comes from one of these, never Math.random.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f1 = (n) => (Math.round(n * 10) / 10).toString();

// Pin the metadata pdf-lib would otherwise stamp with "now".
function pinDates(doc) {
  doc.setCreationDate(PINNED_DATE);
  doc.setModificationDate(PINNED_DATE);
  doc.setProducer('FieldMark fixtures');
  doc.setCreator('test/fixtures/make-fixtures.js');
}

// A guardrail run as CAD exports draw it: two rails as chains of short
// segments (never one long line), W-beam ripples, a post + blockout every
// 6.25 ft, and a leave-out every so often. Returns { ops, segments } in a
// local space `len` points long and ~60 points tall.
function guardrailRun(rand, len, segLen) {
  const ops = [];
  let segments = 0;
  const seg = (x1, y1, x2, y2) => { ops.push(`${f1(x1)} ${f1(y1)} m ${f1(x2)} ${f1(y2)} l S`); segments++; };
  ops.push('0.6 w 0 J 0 j');
  // Two rails, each a chain of segLen-long pieces with a little CAD jitter.
  for (const yRail of [30, 34]) {
    for (let x = 0; x < len; x += segLen) {
      const x2 = Math.min(len, x + segLen);
      seg(x, yRail + (rand() - 0.5) * 0.2, x2, yRail + (rand() - 0.5) * 0.2);
    }
  }
  // Rub rail (a third chain at a finer pitch, as curve-fit CAD exports do).
  for (let x = 0; x < len; x += segLen * 0.7) {
    const x2 = Math.min(len, x + segLen * 0.7);
    seg(x, 20 + Math.sin(x / 40) * 0.3, x2, 20 + Math.sin(x2 / 40) * 0.3);
  }
  // Ripple (the W-beam profile hatching): short diagonal strokes.
  ops.push('0.25 w');
  for (let x = 2; x < len; x += 1.5) seg(x, 30.5, x + 1, 33.5);
  // Posts every 6.25 ft at 1 in = 20 ft => 22.5 pt; each a 4-side rectangle
  // plus a blockout rectangle and a bolt circle drawn as 4 Bezier arcs.
  ops.push('0.8 w');
  for (let x = 0; x < len; x += 22.5) {
    const px = x, pw = 2.2, ph = 22;
    seg(px, 8, px + pw, 8); seg(px + pw, 8, px + pw, 8 + ph); seg(px + pw, 8 + ph, px, 8 + ph); seg(px, 8 + ph, px, 8);
    const bx = px - 1.2, bw = 4.6, by = 28, bh = 8;
    seg(bx, by, bx + bw, by); seg(bx + bw, by, bx + bw, by + bh); seg(bx + bw, by + bh, bx, by + bh); seg(bx, by + bh, bx, by);
    const cx = px + pw / 2, cy = 32, r = 0.9, k = 0.5523 * r;
    ops.push(`${f1(cx + r)} ${f1(cy)} m ${f1(cx + r)} ${f1(cy + k)} ${f1(cx + k)} ${f1(cy + r)} ${f1(cx)} ${f1(cy + r)} c ` +
      `${f1(cx - k)} ${f1(cy + r)} ${f1(cx - r)} ${f1(cy + k)} ${f1(cx - r)} ${f1(cy)} c ` +
      `${f1(cx - r)} ${f1(cy - k)} ${f1(cx - k)} ${f1(cy - r)} ${f1(cx)} ${f1(cy - r)} c ` +
      `${f1(cx + k)} ${f1(cy - r)} ${f1(cx + r)} ${f1(cy - k)} ${f1(cx + r)} ${f1(cy)} c S`);
    segments += 4;
  }
  // Edge of pavement + shoulder as dashed chains below the rail.
  ops.push('[6 3] 0 d 0.4 w');
  for (let x = 0; x < len; x += 12) seg(x, 2, Math.min(len, x + 12), 2 + Math.sin(x / 90) * 0.6);
  ops.push('[] 0 d');
  return { ops, segments };
}

// Register a form XObject holding a guardrail run; the caller places it with a
// per-page transform so its geometry lands at different sheet coordinates on
// every page.
function guardrailForm(doc, rand, len, segLen) {
  const { ops, segments } = guardrailRun(rand, len, segLen);
  const dict = {
    Type: 'XObject', Subtype: 'Form',
    BBox: doc.context.obj([-10, -10, len + 10, 70])
  };
  const ref = doc.context.register(doc.context.flateStream(ops.join('\n'), dict));
  return { ref, segments };
}

function escapePdfText(s) { return s.replace(/[\\()]/g, (c) => '\\' + c); }

// One D sheet: border, title block, a stationed baseline, and the guardrail
// runs. Returns the inline segment count for the page (the forms add theirs).
function densePageContent(rand, pageNo, totalPages, forms, fontTag) {
  const { w, h } = ANSI_D;
  const ops = [];
  let segments = 0;
  const seg = (x1, y1, x2, y2) => { ops.push(`${f1(x1)} ${f1(y1)} m ${f1(x2)} ${f1(y2)} l S`); segments++; };
  const text = (x, y, size, str) =>
    ops.push(`BT /${fontTag} ${size} Tf ${f1(x)} ${f1(y)} Td (${escapePdfText(str)}) Tj ET`);

  // Border (double line) and title block along the right edge, FDOT style.
  ops.push('0 0 0 RG 1.2 w');
  seg(36, 36, w - 36, 36); seg(w - 36, 36, w - 36, h - 36); seg(w - 36, h - 36, 36, h - 36); seg(36, h - 36, 36, 36);
  ops.push('0.5 w');
  seg(40, 40, w - 40, 40); seg(w - 40, 40, w - 40, h - 40); seg(w - 40, h - 40, 40, h - 40); seg(40, h - 40, 40, 40);
  const tbX = w - 36 - 140;
  seg(tbX, 36, tbX, h - 36);
  for (let y = 60; y < h - 36; y += 120) seg(tbX, y, w - 36, y);
  text(tbX + 8, h - 70, 9, 'GUARANTEED FENCE CORP');
  text(tbX + 8, h - 84, 7, 'FIN. PROJ. ID 441234-1-52-01');
  text(tbX + 8, h - 98, 7, `SHEET ${pageNo} OF ${totalPages}`);
  text(tbX + 8, h - 112, 7, `SHEET NO. ${100 + pageNo}`);
  text(tbX + 8, h - 126, 7, 'ROADWAY PLAN  SCALE: 1" = 20\'');
  text(tbX + 8, 120, 6, 'PAY ITEM 536-1-1 GUARDRAIL ROADWAY (TL-3)');
  text(tbX + 8, 108, 6, 'PAY ITEM 536-85-24 END TREATMENT');

  // Stationed baselines: several across the sheet, each with major ticks
  // every 100 ft (360 pt at 1" = 20') and minor ticks every 10 ft (36 pt),
  // labelled with the station. This is the unique-per-page linework.
  const startSta = 100 + pageNo * 15; // hundreds of feet
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const y = 140 + r * ((h - 320) / rows);
    const wobble = (rand() - 0.5) * 30;
    ops.push('0.9 w');
    seg(60, y + wobble, tbX - 40, y + wobble + (rand() - 0.5) * 20);
    ops.push('0.35 w');
    let sta = startSta + r * 4;
    for (let x = 60; x < tbX - 40; x += 3.6) {
      const major = Math.round((x - 60) / 3.6) % 100 === 0;
      const mid = Math.round((x - 60) / 3.6) % 10 === 0;
      const tl = major ? 10 : mid ? 5 : 2;
      seg(x, y + wobble - tl, x, y + wobble + tl);
      if (major) { text(x - 12, y + wobble + 14, 6, `STA ${sta}+00`); sta++; }
    }
  }
  // "Existing features" — a few free polylines (utility, R/W, ditch lines).
  ops.push('[3 2] 0 d 0.5 w');
  for (let k = 0; k < 24; k++) {
    let x = 60 + rand() * (tbX - 200), y = 100 + rand() * (h - 250);
    for (let n = 0; n < 40; n++) {
      const nx = x + 6 + rand() * 10, ny = y + (rand() - 0.5) * 8;
      if (nx > tbX - 40) break;
      seg(x, y, nx, ny); x = nx; y = ny;
    }
  }
  ops.push('[] 0 d');

  // Guardrail runs: place the shared forms with page-specific transforms
  // (translation + slight skew/rotation) so nothing repeats at the same
  // coordinates from sheet to sheet.
  let formSegments = 0;
  const placements = [
    { form: forms[0], x: 80, y: 180 }, { form: forms[1], x: 80, y: 540 },
    { form: forms[2], x: 80, y: 900 }, { form: forms[pageNo % 3], x: 80, y: 1260 },
    { form: forms[(pageNo + 1) % 3], x: 80, y: 1620 }, { form: forms[(pageNo + 2) % 3], x: 80, y: 1980 }
  ];
  placements.forEach((p, i) => {
    const ang = (rand() - 0.5) * 0.04;
    const c = Math.cos(ang), s = Math.sin(ang);
    const dx = p.x + rand() * 40, dy = p.y + rand() * 60 + (i >= 3 ? (pageNo % 2) * 60 : 0);
    ops.push(`q ${c.toFixed(5)} ${s.toFixed(5)} ${(-s).toFixed(5)} ${c.toFixed(5)} ${f1(dx)} ${f1(dy)} cm /${p.form.tag} Do Q`);
    formSegments += p.form.segments;
  });
  return { content: ops.join('\n'), inlineSegments: segments, formSegments };
}

async function buildDensePlans(pages) {
  const doc = await PDFDocument.create();
  pinDates(doc);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const rand = rng(0xD1E5E);
  const { w, h } = ANSI_D;
  // Three runs of different length / segment pitch; ~9k segments each.
  const runs = [[1240, 0.8], [1240, 0.9], [1240, 0.75]].map(([len, pitch]) => guardrailForm(doc, rand, len, pitch));
  let minSegments = Infinity;
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([w, h]);
    const fontTag = page.node.newFontDictionary('F1', font.ref).encodedName.slice(1);
    const forms = runs.map((r) => ({ ref: r.ref, segments: r.segments,
      tag: page.node.newXObject('GR', r.ref).encodedName.slice(1) }));
    const { content, inlineSegments, formSegments } = densePageContent(rand, i, pages, forms, fontTag);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
    minSegments = Math.min(minSegments, inlineSegments + formSegments);
  }
  const bytes = await doc.save();
  return { bytes, minSegments };
}

// A 300 DPI bilevel "scan" of a D sheet: 1 = white, 0 = ink. Unique per page
// (seeded by page number) so PDF.js decodes 40 different bitmaps, as it would
// for a real scanned set.
function scanBitmap(pageNo) {
  const W = 6600, H = 10200, row = W / 8;
  const buf = Buffer.alloc(row * H, 0xff);
  const rand = rng(0x5CA4 + pageNo * 7919);
  const ink = (x, y) => { if (x >= 0 && x < W && y >= 0 && y < H) buf[y * row + (x >> 3)] &= ~(0x80 >> (x & 7)); };
  const hline = (x0, x1, y, t) => { for (let x = x0; x <= x1; x++) for (let k = 0; k < t; k++) ink(x, y + k); };
  const vline = (x, y0, y1, t) => { for (let y = y0; y <= y1; y++) for (let k = 0; k < t; k++) ink(x + k, y); };
  // Border + title block (slightly skewed, as a feed scanner leaves it).
  const skew = Math.floor(rand() * 12) - 6;
  hline(150, W - 150, 150 + skew, 4); hline(150, W - 150, H - 150 - skew, 4);
  vline(150, 150, H - 150, 4); vline(W - 150, 150, H - 150, 4);
  vline(W - 750, 150, H - 150, 3);
  for (let y = 400; y < H - 150; y += 500) hline(W - 750, W - 150, y, 2);
  // Linework: runs, ticks, a few rectangles.
  for (let k = 0; k < 220; k++) {
    const x0 = 300 + Math.floor(rand() * 4800), y0 = 300 + Math.floor(rand() * 9500);
    const len = 200 + Math.floor(rand() * 2400);
    if (rand() < 0.7) hline(x0, Math.min(W - 800, x0 + len), y0, 2 + Math.floor(rand() * 2));
    else vline(x0, y0, Math.min(H - 200, y0 + len), 2 + Math.floor(rand() * 2));
  }
  for (let k = 0; k < 40; k++) {
    const x0 = 300 + Math.floor(rand() * 4800), y0 = 300 + Math.floor(rand() * 9500);
    const bw = 40 + Math.floor(rand() * 300), bh = 30 + Math.floor(rand() * 200);
    hline(x0, x0 + bw, y0, 2); hline(x0, x0 + bw, y0 + bh, 2); vline(x0, y0, y0 + bh, 2); vline(x0 + bw, y0, y0 + bh, 2);
  }
  // "Text": rows of small dark blobs where a title and notes would be.
  for (let r = 0; r < 60; r++) {
    const y = 400 + r * 150, x0 = 400 + Math.floor(rand() * 200);
    const words = 6 + Math.floor(rand() * 10);
    let x = x0;
    for (let wI = 0; wI < words; wI++) {
      const wl = 60 + Math.floor(rand() * 220);
      for (let dx = 0; dx < wl; dx += 3) if (rand() < 0.55) { ink(x + dx, y); ink(x + dx, y + 1); ink(x + dx + 1, y + 1); ink(x + dx, y + 12); ink(x + dx, y + 24); }
      x += wl + 40;
      if (x > W - 900) break;
    }
  }
  // Scanner speckle: 0.02% of the sheet.
  const specks = Math.floor(W * H * 0.0002);
  for (let k = 0; k < specks; k++) ink(Math.floor(rand() * W), Math.floor(rand() * H));
  return { W, H, data: zlib.deflateSync(buf, { level: 9 }) };
}

async function buildScannedSet(pages) {
  const doc = await PDFDocument.create();
  pinDates(doc);
  const { w, h } = ANSI_D;
  for (let i = 1; i <= pages; i++) {
    const { W, H, data } = scanBitmap(i);
    const img = doc.context.register(doc.context.stream(data, {
      Type: 'XObject', Subtype: 'Image', Width: W, Height: H,
      ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'FlateDecode'
    }));
    const page = doc.addPage([w, h]);
    const tag = page.node.newXObject('Scan', img).encodedName.slice(1);
    page.node.set(PDFName.of('Contents'), doc.context.register(
      doc.context.flateStream(`q ${w} 0 0 ${h} 0 0 cm /${tag} Do Q`)));
  }
  return doc.save();
}

// 2,000 annotations + 300 measurements on one D sheet, spread over the sheet
// so a fit-width view holds all of them. Shapes match what markup.js /
// measure.js create (finalize()), and the sidecar is built by the real
// serializeMarkupModel so the fixture tracks the round-trip contract.
function heavyMarkupState(rand) {
  const { w, h } = ANSI_D;
  const style = (i) => ({
    stroke: ['#e5484d', '#2f6fed', '#1a9c5b', '#f5a524'][i % 4], fill: 'none',
    width: 1 + (i % 3), opacity: 1, fontSize: 12, fontFamily: 'Helvetica'
  });
  const annotations = [];
  let annoSeq = 0;
  const push = (an) => { an.id = ++annoSeq; an.page = 1; annotations.push(an); };
  const at = () => ({ vx: 60 + rand() * (w - 260), vy: 60 + rand() * (h - 160) });
  // 500 ink strokes of 40-80 points (curve-fit on every redraw today).
  for (let i = 0; i < 500; i++) {
    const p = at(); const pts = [];
    const n = 40 + Math.floor(rand() * 41);
    let ang = rand() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      ang += (rand() - 0.5) * 0.6;
      p.vx += Math.cos(ang) * 3; p.vy += Math.sin(ang) * 3;
      pts.push({ vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2) });
    }
    push({ type: 'ink', pts, style: style(i) });
  }
  // 500 polylines, 3-8 vertices.
  for (let i = 0; i < 500; i++) {
    const p = at(); const pts = [];
    const n = 3 + Math.floor(rand() * 6);
    for (let k = 0; k < n; k++) { pts.push({ vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2) }); p.vx += rand() * 40; p.vy += (rand() - 0.5) * 40; }
    push({ type: 'polyline', pts, style: style(i) });
  }
  // 300 clouds, 4-6 vertices.
  for (let i = 0; i < 300; i++) {
    const c = at(); const pts = [];
    const n = 4 + Math.floor(rand() * 3), r = 20 + rand() * 40;
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; pts.push({ vx: +(c.vx + Math.cos(a) * r).toFixed(2), vy: +(c.vy + Math.sin(a) * r * 0.7).toFixed(2) }); }
    push({ type: 'cloud', pts, style: style(i) });
  }
  // 400 rectangles.
  for (let i = 0; i < 400; i++) {
    const p = at();
    push({ type: 'rect', pts: [{ vx: p.vx, vy: p.vy }, { vx: +(p.vx + 20 + rand() * 60).toFixed(2), vy: +(p.vy + 15 + rand() * 40).toFixed(2) }], style: style(i) });
  }
  // 300 text boxes.
  for (let i = 0; i < 300; i++) {
    const p = at();
    push({ type: 'text', pts: [{ vx: p.vx, vy: p.vy }, { vx: +(p.vx + 90).toFixed(2), vy: +(p.vy + 24).toFixed(2) }],
      style: style(i), text: `NOTE ${i + 1}: post spacing 6\'-3"` });
  }
  // 300 measurements on a 1" = 20' page scale: 180 lengths, 60 perimeters,
  // 60 areas. Values/labels come from the shared math, as finalize() does it.
  const scale = { factor: 20 / 72, unit: 'ft' };
  const measurements = [];
  let measureSeq = 0;
  const addM = (type, pts) => {
    const { value, unit } = computeValue(type, pts, scale);
    measurements.push({ id: ++measureSeq, page: 1, type, pts, value, unit,
      color: '#2f6fed', width: 1.4, label: fmtMeasure(type, value, unit) });
  };
  for (let i = 0; i < 180; i++) { const p = at(); addM('length', [{ vx: p.vx, vy: p.vy }, { vx: +(p.vx + 30 + rand() * 120).toFixed(2), vy: +(p.vy + (rand() - 0.5) * 20).toFixed(2) }]); }
  for (let i = 0; i < 60; i++) {
    const p = at(); const pts = [];
    for (let k = 0; k < 4; k++) { pts.push({ vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2) }); p.vx += rand() * 60; p.vy += (rand() - 0.5) * 60; }
    addM('perimeter', pts);
  }
  for (let i = 0; i < 60; i++) {
    const p = at(), bw = 30 + rand() * 60, bh = 30 + rand() * 60;
    addM('area', [{ vx: p.vx, vy: p.vy }, { vx: +(p.vx + bw).toFixed(2), vy: p.vy }, { vx: +(p.vx + bw).toFixed(2), vy: +(p.vy + bh).toFixed(2) }, { vx: p.vx, vy: +(p.vy + bh).toFixed(2) }]);
  }
  return {
    placementSeq: 0, measureSeq, viewportSeq: 0, annoSeq, saveAnnots: true,
    scales: { 1: scale }, viewports: {}, placements: [], measurements, annotations, bookmarks: []
  };
}

async function buildHeavyMarkup() {
  const { w, h } = ANSI_D;
  // The base: one sheet with a border and light linework, exactly what a
  // sidecar's pristine copy holds.
  const base = await PDFDocument.create();
  pinDates(base);
  const font = await base.embedFont(StandardFonts.Helvetica);
  const page = base.addPage([w, h]);
  page.drawRectangle({ x: 36, y: 36, width: w - 72, height: h - 72, borderColor: rgb(0, 0, 0), borderWidth: 1.2 });
  page.drawText('HEAVY MARKUP FIXTURE — 2,000 markups + 300 measurements in the sidecar', { x: 60, y: h - 80, size: 14, font });
  for (let i = 0; i < 40; i++) {
    page.drawLine({ start: { x: 60, y: 120 + i * 55 }, end: { x: w - 200, y: 120 + i * 55 }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) });
  }
  const baseBytes = await base.save();

  const model = serializeMarkupModel(heavyMarkupState(rng(0x4EA5)));
  delete model.__count;
  const doc = await PDFDocument.load(baseBytes);
  pinDates(doc);
  const stamp = { creationDate: PINNED_DATE, modificationDate: PINNED_DATE };
  await doc.attach(Buffer.from(JSON.stringify(model)), 'pdfsigner-model.json',
    Object.assign({ mimeType: 'application/json', description: 'FieldMark editable markups' }, stamp));
  await doc.attach(baseBytes, 'pdfsigner-base.pdf',
    Object.assign({ mimeType: 'application/pdf', description: 'FieldMark base document' }, stamp));
  return { bytes: await doc.save(), annotations: model.annotations.length, measurements: model.measurements.length };
}

async function main() {
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, 'sample.pdf'), await build(3, 'Sample drawing'));
  fs.writeFileSync(path.join(dir, 'big.pdf'), await build(12, 'Big plan set'));
  fs.writeFileSync(path.join(dir, 'form.pdf'), await buildForm());
  fs.writeFileSync(path.join(dir, 'scale-detect.pdf'), await buildScaleSet());
  fs.writeFileSync(path.join(dir, 'scale-half.pdf'), await buildHalfSizeSet());
  console.log('Wrote test/fixtures/sample.pdf (3 pages), big.pdf (12 pages), form.pdf (AcroForm), '
    + 'scale-detect.pdf (6 pages), scale-half.pdf (2 pages, half-size).');

  // Performance fixtures (slower to build — the scan set deflates 40 x 8 MB).
  const dense = await buildDensePlans(120);
  fs.writeFileSync(path.join(dir, 'dense-plans.pdf'), dense.bytes);
  const scanned = await buildScannedSet(40);
  fs.writeFileSync(path.join(dir, 'scanned-set.pdf'), scanned);
  const heavy = await buildHeavyMarkup();
  fs.writeFileSync(path.join(dir, 'heavy-markup.pdf'), heavy.bytes);
  const kb = (b) => Math.round(b.length / 1024);
  console.log(`Wrote dense-plans.pdf (120 pages, >=${dense.minSegments} segments/page, ${kb(dense.bytes)} KB), `
    + `scanned-set.pdf (40 pages, 300 DPI 1-bit, ${kb(scanned)} KB), `
    + `heavy-markup.pdf (${heavy.annotations} markups + ${heavy.measurements} measurements, ${kb(heavy.bytes)} KB).`);
}

module.exports = { rng, buildDensePlans, buildScannedSet, buildHeavyMarkup, heavyMarkupState };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
