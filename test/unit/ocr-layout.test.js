import { describe, it, expect } from 'vitest';
import { OcrLayout } from '../../src/shared/ocr-layout.js';

const {
  DPI_PER_SCALE, MAX_DPI, MAX_PIXELS, MIN_SCALE, MIN_CONFIDENCE,
  rasterScale, dpiOf, wordToViewport, baselineY, fontSizeFor, squeeze, usableWord
} = OcrLayout;

// US Letter and ANSI D, in scale-1 viewport points (== PDF points).
const LETTER = { w: 612, h: 792 };
const DSIZE = { w: 34 * 72, h: 44 * 72 };

describe('rasterScale — FR-A-7 caps', () => {
  it('a letter page is limited by DPI, not pixels', () => {
    const s = rasterScale(LETTER.w, LETTER.h);
    expect(dpiOf(s)).toBeCloseTo(MAX_DPI, 6);
    // Sanity: that raster is well under the pixel cap.
    expect(LETTER.w * s * LETTER.h * s).toBeLessThan(MAX_PIXELS);
  });

  it('never exceeds the DPI cap', () => {
    for (const p of [LETTER, DSIZE, { w: 100, h: 100 }]) {
      expect(dpiOf(rasterScale(p.w, p.h))).toBeLessThanOrEqual(MAX_DPI + 1e-9);
    }
  });

  it('never exceeds the pixel cap', () => {
    for (const p of [LETTER, DSIZE, { w: 5000, h: 5000 }]) {
      const s = rasterScale(p.w, p.h);
      expect(p.w * s * p.h * s).toBeLessThanOrEqual(MAX_PIXELS + 1);
    }
  });

  it('a D-size sheet is limited by pixels, so it drops below 300 DPI', () => {
    const s = rasterScale(DSIZE.w, DSIZE.h);
    // The whole point of the pixel cap: a big plan sheet must be scaled down.
    expect(dpiOf(s)).toBeLessThan(MAX_DPI);
    expect(DSIZE.w * s * DSIZE.h * s).toBeCloseTo(MAX_PIXELS, -3);
  });

  it('a D-size sheet still clears the usable-resolution floor', () => {
    expect(rasterScale(DSIZE.w, DSIZE.h)).toBeGreaterThan(MIN_SCALE);
  });

  it('an absurdly large page falls under the floor, so it can be rejected', () => {
    // 200 x 200 inches — past what is worth rasterizing at any useful DPI.
    expect(rasterScale(200 * 72, 200 * 72)).toBeLessThan(MIN_SCALE);
  });

  it('honours explicit caps', () => {
    expect(dpiOf(rasterScale(LETTER.w, LETTER.h, 150, 1e9))).toBeCloseTo(150, 6);
  });

  it('a degenerate page size falls back to the DPI cap instead of NaN', () => {
    expect(rasterScale(0, 0)).toBeCloseTo(MAX_DPI / DPI_PER_SCALE, 6);
    expect(Number.isFinite(rasterScale(0, 0))).toBe(true);
  });
});

describe('wordToViewport — raster px to scale-1 points', () => {
  it('divides by the render scale', () => {
    const box = wordToViewport({ x0: 300, y0: 600, x1: 600, y1: 690 }, 3);
    expect(box).toEqual({ vx: 100, vy: 200, vw: 100, vh: 30 });
  });

  it('scale 1 is identity', () => {
    expect(wordToViewport({ x0: 10, y0: 20, x1: 40, y1: 35 }, 1))
      .toEqual({ vx: 10, vy: 20, vw: 30, vh: 15 });
  });

  it('normalizes an inverted box rather than emitting negative sizes', () => {
    const box = wordToViewport({ x0: 40, y0: 35, x1: 10, y1: 20 }, 1);
    expect(box).toEqual({ vx: 10, vy: 20, vw: 30, vh: 15 });
  });

  it('a missing scale is treated as 1', () => {
    expect(wordToViewport({ x0: 0, y0: 0, x1: 8, y1: 4 }).vw).toBe(8);
  });
});

describe('baselineY', () => {
  const box = { vx: 0, vy: 100, vw: 50, vh: 10 };

  it('sits inside the word box, near the bottom', () => {
    const y = baselineY(box);
    expect(y).toBeGreaterThan(box.vy + box.vh * 0.5);
    expect(y).toBeLessThanOrEqual(box.vy + box.vh);
  });

  it('is configurable', () => {
    expect(baselineY(box, 1)).toBe(110);
    expect(baselineY(box, 0)).toBe(100);
  });
});

describe('fontSizeFor', () => {
  it('matches the word box height so selection height matches the word', () => {
    expect(fontSizeFor({ vh: 12 })).toBe(12);
  });

  it('never returns zero or negative, which would emit a degenerate run', () => {
    expect(fontSizeFor({ vh: 0 })).toBeGreaterThan(0);
    expect(fontSizeFor({ vh: -5 })).toBeGreaterThan(0);
  });
});

describe('squeeze — the Tz factor that keeps glyphs under the ink', () => {
  it('is 100% when the natural width already fits', () => {
    expect(squeeze(50, 50)).toBe(100);
  });

  it('stretches a narrow run to span a wider box', () => {
    expect(squeeze(100, 50)).toBe(200);
  });

  it('compresses a wide run into a narrower box', () => {
    expect(squeeze(50, 100)).toBe(50);
  });

  it('falls back to 100% on a zero or missing measurement', () => {
    expect(squeeze(50, 0)).toBe(100);
    expect(squeeze(0, 50)).toBe(100);
  });

  it('clamps pathological values', () => {
    expect(squeeze(1e6, 0.001)).toBeLessThanOrEqual(1000);
    expect(squeeze(0.001, 1e6)).toBeGreaterThanOrEqual(1);
  });
});

describe('usableWord — FR-A-9 filtering', () => {
  const ok = { text: 'DRAWING', confidence: 92, bbox: { x0: 0, y0: 0, x1: 60, y1: 12 } };

  it('keeps a confident word with a real box', () => {
    expect(usableWord(ok)).toBe(true);
  });

  it('drops words below the confidence threshold', () => {
    expect(usableWord({ ...ok, confidence: MIN_CONFIDENCE - 1 })).toBe(false);
    expect(usableWord({ ...ok, confidence: MIN_CONFIDENCE })).toBe(true);
  });

  it('drops empty and whitespace-only text', () => {
    expect(usableWord({ ...ok, text: '' })).toBe(false);
    expect(usableWord({ ...ok, text: '   ' })).toBe(false);
  });

  it('drops zero-area boxes, which would catch selections over blank paper', () => {
    expect(usableWord({ ...ok, bbox: { x0: 5, y0: 5, x1: 5, y1: 20 } })).toBe(false);
    expect(usableWord({ ...ok, bbox: { x0: 5, y0: 5, x1: 30, y1: 5 } })).toBe(false);
  });

  it('survives malformed input instead of throwing', () => {
    expect(usableWord(null)).toBe(false);
    expect(usableWord({})).toBe(false);
    expect(usableWord({ text: 'x', confidence: 99 })).toBe(false);
  });

  it('honours an explicit threshold', () => {
    expect(usableWord({ ...ok, confidence: 10 }, 5)).toBe(true);
  });
});
