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
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
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

async function main() {
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, 'sample.pdf'), await build(3, 'Sample drawing'));
  fs.writeFileSync(path.join(dir, 'big.pdf'), await build(12, 'Big plan set'));
  fs.writeFileSync(path.join(dir, 'form.pdf'), await buildForm());
  console.log('Wrote test/fixtures/sample.pdf (3 pages), big.pdf (12 pages), form.pdf (AcroForm).');
}

main().catch((e) => { console.error(e); process.exit(1); });
