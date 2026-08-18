'use strict';

/*
 * Regenerate the README screenshots in docs/screenshots/.
 *
 * These are *real* screenshots of the app: the script builds a demo drawing
 * with pdf-lib, serves the assembled www/ bundle (the same renderer Windows,
 * macOS, Android and the PWA all run), drives it in headless Chromium at 2x,
 * and captures each scene.
 *
 *   npm run build:web && node scripts/make-screenshots.js
 *
 * Playwright is an optional harness dependency, same as scripts/verify-web.js:
 *   npm i --no-save playwright && npx playwright install chromium
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  console.error('[shots] needs Playwright. Install it, then re-run:\n' +
    '  npm i --no-save playwright && npx playwright install chromium\n' +
    '  npm run build:web && node scripts/make-screenshots.js');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const OUT = path.join(ROOT, 'docs', 'screenshots');

/* ------------------------------------------------------------------ *
 * 1. The demo drawing
 *
 * An 11x17 landscape architectural sheet — border, title block, grid
 * bubbles, wall poche, doors, dimension strings — so the screenshots show
 * the app doing the job it was built for instead of a blank test page.
 * PDF user space is bottom-left origin; the overlay coordinates used by the
 * scenes below are top-left viewport points (vy = PAGE_H - pdfY).
 * ------------------------------------------------------------------ */

const PAGE_W = 1224;
const PAGE_H = 792;
// 1/8" = 1'-0"  ->  one PDF point is 8/72 of a foot.
const FT_PER_PT = 8 / 72;

// Building envelope + partitions, in PDF user space.
const B = { x0: 110, x1: 900, y0: 150, y1: 660 };
const GRID_X = [110, 420, 650, 900];
const GRID_Y = [150, 380, 660];
const WALL = 7;

function feetInches(pts) {
  const ft = pts * FT_PER_PT;
  let f = Math.floor(ft);
  let i = Math.round((ft - f) * 12);
  if (i === 12) { f += 1; i = 0; }
  return `${f}'-${i}"`;
}

async function buildDemoPdf() {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const INK = rgb(0.11, 0.12, 0.14);
  const POCHE = rgb(0.32, 0.34, 0.38);
  const THIN = rgb(0.55, 0.57, 0.6);
  const GHOST = rgb(0.78, 0.79, 0.81);

  const sheet = (name, number) => {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    // Sheet border
    page.drawRectangle({ x: 18, y: 18, width: PAGE_W - 36, height: PAGE_H - 36, borderColor: INK, borderWidth: 2 });
    page.drawRectangle({ x: 26, y: 26, width: PAGE_W - 52, height: PAGE_H - 52, borderColor: THIN, borderWidth: 0.6 });

    // Title block, right edge
    const tx = 940;
    page.drawLine({ start: { x: tx, y: 26 }, end: { x: tx, y: PAGE_H - 26 }, thickness: 1.2, color: INK });
    const rows = [700, 640, 560, 470, 380, 300, 210, 120];
    rows.forEach((y) => page.drawLine({
      start: { x: tx, y }, end: { x: PAGE_W - 26, y }, thickness: 0.6, color: THIN
    }));
    page.drawText('MERIDIAN', { x: tx + 16, y: 730, size: 22, font: bold, color: INK });
    page.drawText('DESIGN + BUILD', { x: tx + 16, y: 712, size: 8.5, font: reg, color: POCHE });
    page.drawText('PROJECT', { x: tx + 16, y: 668, size: 7, font: bold, color: POCHE });
    page.drawText('NORTHGATE OFFICE', { x: tx + 16, y: 652, size: 11, font: bold, color: INK });
    page.drawText('TENANT IMPROVEMENT', { x: tx + 16, y: 600, size: 9, font: reg, color: INK });
    page.drawText('1420 NORTHGATE BLVD', { x: tx + 16, y: 584, size: 8, font: reg, color: POCHE });
    page.drawText('ISSUED FOR CONSTRUCTION', { x: tx + 16, y: 520, size: 8, font: bold, color: INK });
    page.drawText('REV 3   -   RFI 042 INCORPORATED', { x: tx + 16, y: 504, size: 7.5, font: reg, color: POCHE });
    page.drawText('SCALE', { x: tx + 16, y: 440, size: 7, font: bold, color: POCHE });
    page.drawText('1/8" = 1\'-0"', { x: tx + 16, y: 424, size: 10, font: reg, color: INK });
    page.drawText('DRAWN BY', { x: tx + 16, y: 350, size: 7, font: bold, color: POCHE });
    page.drawText('J. ORTEGA', { x: tx + 16, y: 334, size: 10, font: reg, color: INK });
    page.drawText('SHEET TITLE', { x: tx + 16, y: 268, size: 7, font: bold, color: POCHE });
    page.drawText(name, { x: tx + 16, y: 248, size: 12, font: bold, color: INK });
    page.drawText('SHEET', { x: tx + 16, y: 178, size: 7, font: bold, color: POCHE });
    page.drawText(number, { x: tx + 16, y: 140, size: 30, font: bold, color: INK });
    page.drawText(name, { x: 40, y: PAGE_H - 52, size: 15, font: bold, color: INK });
    page.drawText('SCALE: 1/8" = 1\'-0"', { x: 40, y: PAGE_H - 68, size: 8, font: reg, color: POCHE });
    return page;
  };

  // --- helpers -----------------------------------------------------
  const wallH = (page, x0, x1, y, gaps = []) => {
    const segs = [[x0, x1]];
    gaps.forEach(([a, b]) => {
      for (let i = segs.length - 1; i >= 0; i--) {
        const [s, e] = segs[i];
        if (a > s && b < e) segs.splice(i, 1, [s, a], [b, e]);
      }
    });
    segs.forEach(([s, e]) => page.drawRectangle({
      x: s, y: y - WALL / 2, width: e - s, height: WALL, color: POCHE
    }));
  };
  const wallV = (page, y0, y1, x, gaps = []) => {
    const segs = [[y0, y1]];
    gaps.forEach(([a, b]) => {
      for (let i = segs.length - 1; i >= 0; i--) {
        const [s, e] = segs[i];
        if (a > s && b < e) segs.splice(i, 1, [s, a], [b, e]);
      }
    });
    segs.forEach(([s, e]) => page.drawRectangle({
      x: x - WALL / 2, y: s, width: WALL, height: e - s, color: POCHE
    }));
  };
  // A door leaf + its quarter-circle swing, drawn as short chords.
  const door = (page, x, y, r, dir) => {
    const [sx, sy] = dir === 'up' ? [0, 1] : dir === 'down' ? [0, -1] : dir === 'left' ? [-1, 0] : [1, 0];
    page.drawLine({ start: { x, y }, end: { x: x + sx * r, y: y + sy * r }, thickness: 1.2, color: INK });
    const a0 = Math.atan2(sy, sx);
    let prev = null;
    for (let t = 0; t <= 1.0001; t += 1 / 12) {
      const a = a0 - (Math.PI / 2) * t;
      const p = { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
      if (prev) page.drawLine({ start: prev, end: p, thickness: 0.7, color: THIN });
      prev = p;
    }
  };
  const dimH = (page, x0, x1, y, label) => {
    page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.7, color: INK });
    [x0, x1].forEach((x) => page.drawLine({
      start: { x: x - 4, y: y - 4 }, end: { x: x + 4, y: y + 4 }, thickness: 0.9, color: INK
    }));
    const w = reg.widthOfTextAtSize(label, 8);
    page.drawRectangle({ x: (x0 + x1) / 2 - w / 2 - 3, y: y - 3.5, width: w + 6, height: 11, color: rgb(1, 1, 1) });
    page.drawText(label, { x: (x0 + x1) / 2 - w / 2, y: y - 1, size: 8, font: reg, color: INK });
  };
  const dimV = (page, y0, y1, x, label) => {
    page.drawLine({ start: { x, y: y0 }, end: { x, y: y1 }, thickness: 0.7, color: INK });
    [y0, y1].forEach((y) => page.drawLine({
      start: { x: x - 4, y: y - 4 }, end: { x: x + 4, y: y + 4 }, thickness: 0.9, color: INK
    }));
    const w = reg.widthOfTextAtSize(label, 8);
    page.drawRectangle({ x: x - w / 2 - 3, y: (y0 + y1) / 2 - 6, width: w + 6, height: 11, color: rgb(1, 1, 1) });
    page.drawText(label, { x: x - w / 2, y: (y0 + y1) / 2 - 3, size: 8, font: reg, color: INK });
  };
  const bubble = (page, x, y, txt) => {
    page.drawCircle({ x, y, size: 11, borderColor: INK, borderWidth: 1, color: rgb(1, 1, 1) });
    const w = bold.widthOfTextAtSize(txt, 9);
    page.drawText(txt, { x: x - w / 2, y: y - 3, size: 9, font: bold, color: INK });
  };
  const room = (page, x, y, name, num, area) => {
    const w1 = bold.widthOfTextAtSize(name, 11);
    page.drawText(name, { x: x - w1 / 2, y, size: 11, font: bold, color: INK });
    const w2 = reg.widthOfTextAtSize(num, 9);
    page.drawText(num, { x: x - w2 / 2, y: y - 14, size: 9, font: reg, color: POCHE });
    if (area) {
      const w3 = reg.widthOfTextAtSize(area, 8);
      page.drawText(area, { x: x - w3 / 2, y: y - 27, size: 8, font: reg, color: POCHE });
    }
  };
  const north = (page, x, y) => {
    page.drawCircle({ x, y, size: 26, borderColor: THIN, borderWidth: 0.8 });
    page.drawLine({ start: { x, y: y - 18 }, end: { x, y: y + 18 }, thickness: 1, color: INK });
    page.drawLine({ start: { x: x - 7, y: y + 6 }, end: { x, y: y + 18 }, thickness: 1, color: INK });
    page.drawLine({ start: { x: x + 7, y: y + 6 }, end: { x, y: y + 18 }, thickness: 1, color: INK });
    page.drawText('N', { x: x - 3.5, y: y + 30, size: 9, font: bold, color: INK });
  };

  /* ---------------- Sheet 1: floor plan ---------------- */
  const p1 = sheet('LEVEL 1 - FLOOR PLAN', 'A-101');

  // Grid lines + bubbles
  GRID_X.forEach((x, i) => {
    p1.drawLine({ start: { x, y: B.y0 - 70 }, end: { x, y: B.y1 + 55 }, thickness: 0.5, color: GHOST, dashArray: [6, 4] });
    bubble(p1, x, B.y1 + 68, String(i + 1));
  });
  GRID_Y.forEach((y, i) => {
    p1.drawLine({ start: { x: B.x0 - 60, y }, end: { x: B.x1 + 40, y }, thickness: 0.5, color: GHOST, dashArray: [6, 4] });
    bubble(p1, B.x0 - 74, y, 'ABC'[i]);
  });

  // Envelope (door openings at the lobby entry)
  wallH(p1, B.x0, B.x1, B.y0, [[230, 290]]);
  wallH(p1, B.x0, B.x1, B.y1);
  wallV(p1, B.y0, B.y1, B.x0);
  wallV(p1, B.y0, B.y1, B.x1);
  // Partitions
  wallH(p1, B.x0, B.x1, 380, [[330, 375], [700, 745]]);
  wallV(p1, 380, B.y1, 420, [[470, 515]]);
  wallV(p1, 380, B.y1, 650, [[470, 515]]);
  wallV(p1, B.y0, 380, 500, [[210, 255]]);

  door(p1, 290, B.y0, 52, 'up');
  door(p1, 330, 380, 44, 'up');
  door(p1, 745, 380, 44, 'down');
  door(p1, 420, 515, 44, 'right');
  door(p1, 650, 470, 44, 'left');
  door(p1, 500, 255, 44, 'left');

  room(p1, 265, 600, 'OFFICE', '101', '2,410 SF');
  room(p1, 535, 600, 'CONFERENCE', '102', '1,780 SF');
  room(p1, 775, 600, 'MECH / IT', '103', '1,930 SF');
  room(p1, 300, 330, 'LOBBY', '100', '2,990 SF');
  room(p1, 700, 345, 'OPEN WORK AREA', '104', '4,120 SF');

  dimH(p1, GRID_X[0], GRID_X[1], B.y0 - 42, feetInches(GRID_X[1] - GRID_X[0]));
  dimH(p1, GRID_X[1], GRID_X[2], B.y0 - 42, feetInches(GRID_X[2] - GRID_X[1]));
  dimH(p1, GRID_X[2], GRID_X[3], B.y0 - 42, feetInches(GRID_X[3] - GRID_X[2]));
  dimH(p1, GRID_X[0], GRID_X[3], B.y0 - 72, feetInches(GRID_X[3] - GRID_X[0]));
  dimV(p1, GRID_Y[0], GRID_Y[1], B.x1 + 40, feetInches(GRID_Y[1] - GRID_Y[0]));
  dimV(p1, GRID_Y[1], GRID_Y[2], B.x1 + 40, feetInches(GRID_Y[2] - GRID_Y[1]));
  north(p1, 880, 720);

  /* ---------------- Sheet 2: power + lighting ---------------- */
  const p2 = sheet('LEVEL 1 - POWER + LIGHTING', 'E-201');
  wallH(p2, B.x0, B.x1, B.y0, [[230, 290]]);
  wallH(p2, B.x0, B.x1, B.y1);
  wallV(p2, B.y0, B.y1, B.x0);
  wallV(p2, B.y0, B.y1, B.x1);
  wallH(p2, B.x0, B.x1, 380, [[330, 375], [700, 745]]);
  wallV(p2, 380, B.y1, 420, [[470, 515]]);
  wallV(p2, 380, B.y1, 650, [[470, 515]]);
  wallV(p2, B.y0, 380, 500, [[210, 255]]);

  // Lighting grid: 2x4 troffers
  for (let x = 160; x < B.x1 - 40; x += 120) {
    for (let y = 205; y < B.y1 - 30; y += 105) {
      if (Math.abs(x - 420) < 26 || Math.abs(x - 650) < 26 || Math.abs(x - 500) < 26) continue;
      p2.drawRectangle({ x: x - 28, y: y - 10, width: 56, height: 20, borderColor: INK, borderWidth: 0.8 });
      p2.drawLine({ start: { x: x - 28, y }, end: { x: x + 28, y }, thickness: 0.5, color: THIN });
    }
  }
  // Receptacles along the walls
  for (let x = 150; x < B.x1 - 20; x += 95) {
    p2.drawCircle({ x, y: B.y0 + 14, size: 5, borderColor: INK, borderWidth: 1 });
    p2.drawLine({ start: { x, y: B.y0 + 4 }, end: { x, y: B.y0 }, thickness: 0.8, color: INK });
  }
  p2.drawText('TYP. 2x4 LED TROFFER - SEE FIXTURE SCHEDULE', { x: 130, y: B.y1 - 24, size: 8, font: reg, color: POCHE });

  /* ---------------- Sheet 3: partition types ---------------- */
  const p3 = sheet('PARTITION TYPES + DETAILS', 'A-501');
  const detail = (x, y, title, note) => {
    p3.drawRectangle({ x, y, width: 250, height: 200, borderColor: THIN, borderWidth: 0.8 });
    p3.drawText(title, { x: x + 12, y: y + 172, size: 11, font: bold, color: INK });
    p3.drawText(note, { x: x + 12, y: y + 156, size: 8, font: reg, color: POCHE });
    p3.drawRectangle({ x: x + 40, y: y + 40, width: 14, height: 100, color: POCHE });
    p3.drawRectangle({ x: x + 74, y: y + 40, width: 14, height: 100, color: POCHE });
    for (let i = 0; i < 9; i++) {
      p3.drawLine({
        start: { x: x + 54, y: y + 42 + i * 12 }, end: { x: x + 74, y: y + 52 + i * 12 },
        thickness: 0.6, color: THIN
      });
    }
    p3.drawLine({ start: { x: x + 110, y: y + 90 }, end: { x: x + 200, y: y + 90 }, thickness: 0.7, color: INK });
    p3.drawText('5/8" GWB EA. SIDE', { x: x + 110, y: y + 96, size: 7.5, font: reg, color: INK });
  };
  detail(80, 420, 'TYPE A - FULL HEIGHT', 'STC 45 / 1 HR RATED');
  detail(370, 420, 'TYPE B - TO CEILING', 'STC 38');
  detail(660, 420, 'TYPE C - LOW WALL', '42" A.F.F.');
  detail(80, 150, 'TYPE D - SHAFT WALL', '2 HR RATED');
  detail(370, 150, 'TYPE E - DEMISING', 'STC 55');
  detail(660, 150, 'TYPE F - FURRING', 'AT EXTERIOR');

  return doc.save();
}

/* ------------------------------------------------------------------ *
 * 2. Static server for www/ (same shape as scripts/verify-web.js)
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
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

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (_) { /* none */ }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 3. Scenes
 * ------------------------------------------------------------------ */

// Overlay geometry, in top-left viewport points (vy = PAGE_H - pdfY).
const V = (x, y) => ({ vx: x, vy: PAGE_H - y });

const MARKUPS = [
  // Revision cloud around the conference room, the classic redline.
  { type: 'cloud', pts: [V(408, 668), V(662, 668), V(662, 392), V(408, 392)],
    style: { stroke: '#e5484d', fill: 'none', width: 2.5, opacity: 1 } },
  { type: 'callout', pts: [V(600, 762), V(895, 704), V(650, 648)], text: 'Revised per RFI 042 - confirm door swing',
    style: { stroke: '#e5484d', fill: '#ffffff', width: 2, opacity: 1, fontSize: 13 } },
  // Blue mark-up on the open work area.
  { type: 'rect', pts: [V(505, 372), V(895, 158)],
    style: { stroke: '#2f6fed', fill: '#2f6fed', width: 2, opacity: 0.14 } },
  { type: 'text', pts: [V(545, 250), V(830, 218)], text: 'Add 6 workstations',
    style: { stroke: '#2f6fed', fill: 'none', width: 2, opacity: 1, fontSize: 14 } },
  { type: 'arrow', pts: [V(250, 470), V(322, 392)],
    style: { stroke: '#f5a524', fill: 'none', width: 2.5, opacity: 1 } },
  { type: 'ink', pts: [V(180, 236), V(210, 252), V(246, 232), V(286, 254), V(320, 234)],
    style: { stroke: '#30a46c', fill: 'none', width: 3, opacity: 1 } }
];

const MEASUREMENTS = [
  // Perimeter take-off of the open work area.
  { id: 1, page: 1, type: 'area', pts: [V(504, 376), V(896, 376), V(896, 154), V(504, 154)] },
  // Wall run down the corridor.
  { id: 2, page: 1, type: 'continuous', pts: [V(114, 656), V(416, 656), V(416, 384)] },
  { id: 3, page: 1, type: 'length', pts: [V(654, 656), V(896, 656)] },
  // Door count.
  { id: 4, page: 1, type: 'count', pts: [V(290, 152), V(330, 380), V(745, 380), V(420, 515), V(650, 470), V(500, 255)] }
];

const SCENE_SETUP = `
  window.__shot = {
    tick: (ms) => new Promise((r) => setTimeout(r, ms || 120)),
    reset() {
      const A = App.state;
      try { App.clearToasts(); } catch (e) {}
      try { App.Markup.cancelActive(); App.setMode(null); } catch (e) {}
      try { App.Tour && App.Tour.close && App.Tour.close(); } catch (e) {}
      document.querySelectorAll('.tour-host, #tour-host, #whatsnew').forEach((el) => el.classList.add('hidden'));
      document.body.classList.remove('tour-open');
      A.annotations.length = 0; A.measurements.length = 0; A.placements.length = 0;
      A.annoSeq = 0; A.selectedId = null; A.measureSelectedId = null; A.markupSelectedId = null;
      A.scales = {}; A.viewports = {};
      document.querySelectorAll('.tb-menu').forEach((m) => m.classList.add('hidden'));
      // Close dialogs by their backdrop; the inner .modal must stay visible, or
      // reopening it later shows nothing but the dim.
      document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
      ['#measure-panel', '#markup-panel'].forEach((s) => {
        const p = document.querySelector(s);
        if (p && !p.classList.contains('hidden')) p.classList.add('hidden');
      });
      document.body.classList.remove('has-mpanel', 'has-mkpanel');
      try { App.Markup.repositionAll(); } catch (e) {}
      try { App.Measure.recomputeAll(); } catch (e) {}
    },
    markups(list) {
      const A = App.state;
      list.forEach((m) => {
        A.annoSeq = (A.annoSeq || 0) + 1;
        A.annotations.push(Object.assign({ id: A.annoSeq, page: 1 }, m));
      });
      App.Markup.repositionAll();
    },
    measures(list, factor, unit, label) {
      const A = App.state;
      A.scales[1] = { factor, unit, ratioLabel: label };
      list.forEach((m) => A.measurements.push(Object.assign({}, m)));
      App.Measure.recomputeAll();
    },
    theme(mode) {
      document.documentElement.setAttribute('data-theme', mode);
      try { App.Prefs.set('theme', mode); } catch (e) {}
    }
  };
`;

async function main() {
  if (!fs.existsSync(path.join(WWW, 'index.html'))) {
    console.error('[shots] www/ is missing — run `npm run build:web` first.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const pdfBytes = await buildDemoPdf();
  const pdfB64 = Buffer.from(pdfBytes).toString('base64');
  console.log(`[shots] demo drawing built (${(pdfBytes.length / 1024).toFixed(0)} KB, 3 sheets)`);

  const server = await serve(WWW);
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });

  const shots = [];
  const openApp = async (width, height, mobile) => {
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      isMobile: !!mobile,
      hasTouch: !!mobile,
      colorScheme: 'light'
    });
    // Pre-seed prefs so the first-run guided tour and the What's-New note (both
    // correct behaviour for a real first launch) don't cover the screenshots.
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('pdfsigner.prefs.v1',
          JSON.stringify({ seenWelcome: true, whatsNewRev: 999999, theme: 'light' }));
      } catch (e) { /* storage disabled */ }
    });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.App && App.Viewer && App.Markup && App.Measure', null, { timeout: 20000 });
    // The bundle ships a strict CSP (no inline <script>), so install the scene
    // helpers through the debugger rather than addScriptTag.
    await page.evaluate('(() => {' + SCENE_SETUP + '})()');
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await App.Viewer.load(u8.buffer, 'A-101 Northgate Office.pdf', '/Projects/Northgate/A-101 Northgate Office.pdf');
      for (let i = 0; i < 100 && !App.state.numPages; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 900));
    }, pdfB64);
    return { ctx, page };
  };

  const snap = async (page, name) => {
    await page.evaluate(() => { try { App.clearToasts(); } catch (e) {} });
    await page.waitForTimeout(250);
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file });
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    shots.push(`${name}.png (${kb} KB)`);
    console.log(`[shots] ${name}.png  ${kb} KB`);
  };

  /* ---- desktop scenes ---- */
  const { ctx, page } = await openApp(1600, 1000);

  // Hero — dark theme, redlines + take-off together.
  await page.evaluate(async ([mk, ms]) => {
    window.__shot.reset();
    window.__shot.theme('dark');
    document.querySelector('#btn-fit-width').click();
    await window.__shot.tick(500);
    window.__shot.markups(mk);
    window.__shot.measures(ms, 8 / 72, 'ft', '1/8" = 1\'-0"');
    await window.__shot.tick(400);
  }, [MARKUPS, MEASUREMENTS]);
  await page.waitForTimeout(900);
  await snap(page, 'hero');

  // Light theme, same view — the other half of the theme strip (hero.png is
  // the dark half, so there's no third near-identical file to keep in sync).
  await page.evaluate(async () => { window.__shot.theme('light'); await window.__shot.tick(300); });
  await page.waitForTimeout(500);
  await snap(page, 'theme-light');

  await page.evaluate(async () => { window.__shot.theme('dark'); await window.__shot.tick(300); });
  await page.waitForTimeout(400);

  // Markup — light theme, properties bar + Markups List panel.
  await page.evaluate(async (mk) => {
    window.__shot.reset();
    window.__shot.theme('light');
    window.__shot.markups(mk);
    await window.__shot.tick(200);
    App.Markup.startTool('cloud');
    App.MarkupPanel.toggle();
    await window.__shot.tick(300);
  }, MARKUPS);
  await page.waitForTimeout(800);
  await snap(page, 'markup');

  // Measure — take-off with the Measurements List open and its totals.
  await page.evaluate(async (ms) => {
    window.__shot.reset();
    window.__shot.theme('light');
    window.__shot.measures(ms, 8 / 72, 'ft', '1/8" = 1\'-0"');
    await window.__shot.tick(200);
    App.Measure.togglePanel();
    await window.__shot.tick(300);
  }, MEASUREMENTS);
  await page.waitForTimeout(800);
  await snap(page, 'measure');

  // Signature modal — typed signature with a live preview.
  await page.evaluate(async () => {
    window.__shot.reset();
    window.__shot.theme('light');
    await window.__shot.tick(150);
    document.querySelector('#btn-sign').click();
    await window.__shot.tick(400);
    const input = document.querySelector('#sig-type-input');
    if (input) {
      input.value = 'Jordan Ortega';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await window.__shot.tick(500);
  });
  await page.waitForTimeout(800);
  await snap(page, 'signature');

  // Page organizer — thumbnails, reorder / rotate / extract.
  const organized = await page.evaluate(async () => {
    window.__shot.reset();
    window.__shot.theme('light');
    await window.__shot.tick(150);
    const btn = document.querySelector('#btn-organize') ||
      [...document.querySelectorAll('#document-menu button, #document-menu .tb-mi')]
        .find((b) => /organize/i.test(b.textContent || ''));
    if (!btn) return false;
    document.querySelector('#btn-document').click();
    await window.__shot.tick(150);
    btn.click();
    await window.__shot.tick(1400);
    document.querySelectorAll('.tb-menu').forEach((m) => m.classList.add('hidden'));
    return !!document.querySelector('#organize-panel:not(.hidden), #org-panel:not(.hidden), .org-grid');
  });
  await page.waitForTimeout(1400);
  if (organized) await snap(page, 'organize');
  else console.log('[shots] organize panel not found — skipped');

  await ctx.close();

  /* ---- mobile scene (the Android / iPad WebView runs this same bundle) ---- */
  const m = await openApp(430, 932, true);
  await m.page.evaluate(async (mk) => {
    window.__shot.reset();
    window.__shot.theme('light');
    App.Viewer.fitWidth();
    await window.__shot.tick(500);
    window.__shot.markups(mk);
    await window.__shot.tick(400);
    // Zoom in on the redlined rooms — a phone screenshot of the whole 11x17
    // sheet is honest but unreadable at README size.
    App.Viewer.setZoom(0.44);
    await window.__shot.tick(500);
    App.Markup.repositionAll();
    const vc = document.querySelector('#viewerContainer');
    vc.scrollTop = 8; vc.scrollLeft = 40;
    await window.__shot.tick(500);
  }, MARKUPS);
  await m.page.waitForTimeout(900);
  await snap(m.page, 'mobile');
  await m.ctx.close();

  await browser.close();
  server.close();
  console.log('\n[shots] wrote ' + shots.length + ' screenshots to docs/screenshots/');
}

main().catch((e) => { console.error('[shots] failed:', e); process.exit(1); });
