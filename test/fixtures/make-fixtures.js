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

async function main() {
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, 'sample.pdf'), await build(3, 'Sample drawing'));
  fs.writeFileSync(path.join(dir, 'big.pdf'), await build(12, 'Big plan set'));
  console.log('Wrote test/fixtures/sample.pdf (3 pages) and big.pdf (12 pages).');
}

main().catch((e) => { console.error(e); process.exit(1); });
