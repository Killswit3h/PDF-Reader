import { describe, it, expect } from 'vitest';
import {
  isLandscape, orientationForSizes,
  paperSize, orientPaper, fitOnPaper, layoutForPage, ptToMicrons, pageSizeMicrons
} from '../../src/shared/print-layout.js';

const TABLOID_LANDSCAPE = { w: 1224, h: 792 };  // 17 x 11 in
const LETTER_LANDSCAPE = { w: 792, h: 612 };    // 11 x 8.5 in

describe('paperSize', () => {
  it('knows tabloid in points', () => {
    expect(paperSize('tabloid')).toEqual({ width: 792, height: 1224 });
  });
  it('is case- and whitespace-insensitive', () => {
    expect(paperSize('  TabLoid ')).toEqual({ width: 792, height: 1224 });
  });
  it('returns null for unknown or empty names (meaning "keep the PDF size")', () => {
    expect(paperSize('foolscap')).toBeNull();
    expect(paperSize('')).toBeNull();
    expect(paperSize(null)).toBeNull();
  });
});

describe('orientPaper', () => {
  it('turns tabloid landscape for a wide plan sheet', () => {
    expect(orientPaper(TABLOID_LANDSCAPE.w, TABLOID_LANDSCAPE.h, paperSize('tabloid')))
      .toEqual({ width: 1224, height: 792 });
  });
  it('keeps tabloid portrait for a tall page', () => {
    expect(orientPaper(612, 792, paperSize('tabloid'))).toEqual({ width: 792, height: 1224 });
  });
  it('does not mutate the shared PAPER_SIZES entry', () => {
    orientPaper(1224, 792, paperSize('tabloid'));
    expect(paperSize('tabloid')).toEqual({ width: 792, height: 1224 });
  });
});

describe('fitOnPaper', () => {
  it('is 1:1 and flush when the page already matches the paper', () => {
    const f = fitOnPaper(1224, 792, 1224, 792);
    expect(f.scale).toBe(1);
    expect(f).toMatchObject({ dx: 0, dy: 0, width: 1224, height: 792 });
  });

  // The reported bug: a tabloid sheet printed at ~0.75 in the corner. Filling
  // the sheet must be scale 1 and centred, never 0.75 and top-left.
  it('does not shrink a tabloid sheet onto tabloid paper (the reported defect)', () => {
    const f = fitOnPaper(1224, 792, 1224, 792);
    expect(f.scale).not.toBeCloseTo(0.75, 2);
    expect(f.scale).toBe(1);
  });

  it('scales a letter sheet UP to fill tabloid, preserving aspect', () => {
    const f = fitOnPaper(LETTER_LANDSCAPE.w, LETTER_LANDSCAPE.h, TABLOID_LANDSCAPE.w, TABLOID_LANDSCAPE.h);
    // min(1224/792, 792/612) = min(1.5455, 1.2941) -> height-limited
    expect(f.scale).toBeCloseTo(792 / 612, 6);
    expect(f.height).toBeCloseTo(792, 6);
    expect(f.dy).toBeCloseTo(0, 6);
    expect(f.dx).toBeGreaterThan(0);            // centred horizontally
  });

  it('scales a tabloid sheet DOWN to fit letter without cropping', () => {
    const f = fitOnPaper(TABLOID_LANDSCAPE.w, TABLOID_LANDSCAPE.h, LETTER_LANDSCAPE.w, LETTER_LANDSCAPE.h);
    expect(f.width).toBeLessThanOrEqual(LETTER_LANDSCAPE.w + 1e-9);
    expect(f.height).toBeLessThanOrEqual(LETTER_LANDSCAPE.h + 1e-9);
    expect(f.scale).toBeCloseTo(792 / 1224, 6);
  });

  it('centres what it scales', () => {
    const f = fitOnPaper(100, 100, 400, 200);
    expect(f.scale).toBe(2);                     // height-limited
    expect(f.dx).toBeCloseTo(100, 6);            // (400 - 200) / 2
    expect(f.dy).toBeCloseTo(0, 6);
  });

  it('never distorts the aspect ratio', () => {
    const f = fitOnPaper(1224, 792, 792, 1224);
    expect(f.width / f.height).toBeCloseTo(1224 / 792, 6);
  });

  it('falls back to 1:1 on degenerate input instead of NaN', () => {
    expect(fitOnPaper(0, 100, 500, 500)).toMatchObject({ scale: 1, dx: 0, dy: 0 });
    expect(fitOnPaper(100, 100, 0, 500)).toMatchObject({ scale: 1 });
    expect(Number.isNaN(fitOnPaper(NaN, NaN, NaN, NaN).scale)).toBe(false);
  });
});

describe('layoutForPage', () => {
  it('puts a wide plan sheet on landscape tabloid at 1:1', () => {
    const { paper, fit } = layoutForPage(TABLOID_LANDSCAPE.w, TABLOID_LANDSCAPE.h, 'tabloid');
    expect(paper).toEqual({ width: 1224, height: 792 });
    expect(fit.scale).toBe(1);
  });
  it('blows a letter sheet up onto landscape tabloid', () => {
    const { paper, fit } = layoutForPage(LETTER_LANDSCAPE.w, LETTER_LANDSCAPE.h, 'tabloid');
    expect(paper).toEqual({ width: 1224, height: 792 });
    expect(fit.scale).toBeGreaterThan(1);
  });
  it('keeps the PDF\'s own size when no paper is named', () => {
    const { paper, fit } = layoutForPage(1000, 500, '');
    expect(paper).toEqual({ width: 1000, height: 500 });
    expect(fit).toMatchObject({ scale: 1, dx: 0, dy: 0 });
  });
});

describe('ptToMicrons / pageSizeMicrons', () => {
  it('converts inches-worth of points exactly', () => {
    expect(ptToMicrons(72)).toBe(25400);          // 1 inch
    expect(ptToMicrons(792)).toBe(279400);        // 11 in
    expect(ptToMicrons(1224)).toBe(431800);       // 17 in
  });
  it('rounds, since Chromium rejects fractional page sizes', () => {
    expect(Number.isInteger(ptToMicrons(595.28))).toBe(true);
  });
  it('builds a tabloid-landscape pageSize for webContents.print', () => {
    expect(pageSizeMicrons({ width: 1224, height: 792 })).toEqual({ width: 431800, height: 279400 });
  });
  it('returns null for degenerate paper so the option can be omitted', () => {
    expect(pageSizeMicrons({ width: 0, height: 100 })).toBeNull();
    expect(pageSizeMicrons(null)).toBeNull();
  });
});

describe('isLandscape', () => {
  it('is true for a wider-than-tall sheet (tabloid 17x11)', () => {
    expect(isLandscape(1224, 792)).toBe(true);
  });
  it('is false for a taller-than-wide sheet (letter 8.5x11)', () => {
    expect(isLandscape(612, 792)).toBe(false);
  });
  it('treats a square-ish page as portrait (within tolerance)', () => {
    expect(isLandscape(800, 792)).toBe(false);
  });
  it('flips to landscape once clearly wider than the tolerance', () => {
    expect(isLandscape(820, 792)).toBe(true);
  });
  it('is false for degenerate / zero sizes', () => {
    expect(isLandscape(0, 100)).toBe(false);
    expect(isLandscape(100, 0)).toBe(false);
    expect(isLandscape(NaN, NaN)).toBe(false);
  });
});

describe('orientationForSizes', () => {
  it('requests landscape for a single wide plan sheet', () => {
    expect(orientationForSizes([{ width: 1224, height: 792 }])).toEqual({ landscape: true });
  });
  it('requests portrait for a single tall page', () => {
    expect(orientationForSizes([{ width: 612, height: 792 }])).toEqual({ landscape: false });
  });
  it('follows the majority across mixed pages', () => {
    const sizes = [
      { width: 1224, height: 792 }, // landscape
      { width: 1224, height: 792 }, // landscape
      { width: 612, height: 792 },  // portrait
    ];
    expect(orientationForSizes(sizes)).toEqual({ landscape: true });
  });
  it('stays portrait when portrait pages are the majority', () => {
    const sizes = [
      { width: 1224, height: 792 }, // landscape
      { width: 612, height: 792 },  // portrait
      { width: 612, height: 792 },  // portrait
    ];
    expect(orientationForSizes(sizes)).toEqual({ landscape: false });
  });
  it('breaks a tie in favour of landscape (wide sheets need it most)', () => {
    const sizes = [
      { width: 1224, height: 792 }, // landscape
      { width: 612, height: 792 },  // portrait
    ];
    expect(orientationForSizes(sizes)).toEqual({ landscape: true });
  });
  it('defaults to portrait for an empty or invalid set', () => {
    expect(orientationForSizes([])).toEqual({ landscape: false });
    expect(orientationForSizes(null)).toEqual({ landscape: false });
  });
});
