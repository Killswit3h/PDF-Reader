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
 */
const { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFNumber, PDFString } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

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

  return doc.save();
}

async function main() {
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, 'sample.pdf'), await build(3, 'Sample drawing'));
  fs.writeFileSync(path.join(dir, 'big.pdf'), await build(12, 'Big plan set'));
  fs.writeFileSync(path.join(dir, 'form.pdf'), await buildForm());
  fs.writeFileSync(path.join(dir, 'scale-detect.pdf'), await buildScaleSet());
  console.log('Wrote test/fixtures/sample.pdf (3 pages), big.pdf (12 pages), form.pdf (AcroForm), scale-detect.pdf (4 pages).');
}

main().catch((e) => { console.error(e); process.exit(1); });
