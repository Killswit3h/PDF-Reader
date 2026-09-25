import { describe, it, expect } from 'vitest';
import { annotImportable, annotToMarkups, pdfColorToHex } from '../../src/shared/annot-import.js';

// Scale-1 viewport transforms as pdf.js builds them for a 612x792 page with its
// MediaBox at the origin: unrotated flips Y; /Rotate 90 swaps the axes.
const H = 792;
const vp0 = (x, y) => ({ vx: x, vy: H - y });
const vp90 = (x, y) => ({ vx: y, vy: x });

const base = (o) => Object.assign({ flags: 4, measure: false, irt: false, it: null, color: [1, 0, 0], width: 2, ca: 1 }, o);

describe('annotImportable', () => {
  it('accepts the supported subtypes', () => {
    for (const s of ['Square', 'Circle', 'Line', 'PolyLine', 'Polygon', 'Ink', 'Highlight', 'Underline', 'StrikeOut', 'FreeText']) {
      expect(annotImportable(base({ subtype: s }))).toBe(true);
    }
  });
  it('leaves everything else native', () => {
    for (const s of ['Stamp', 'FileAttachment', 'Link', 'Widget', 'Popup', 'Redact', 'Sound', 'Text']) {
      expect(annotImportable(base({ subtype: s }))).toBe(false);
    }
  });
  it('leaves measurements, replies, and hidden or locked marks native', () => {
    expect(annotImportable(base({ subtype: 'Line', measure: true }))).toBe(false);
    expect(annotImportable(base({ subtype: 'PolyLine', it: 'PolyLineDimension' }))).toBe(false);
    expect(annotImportable(base({ subtype: 'Square', irt: true }))).toBe(false);
    for (const f of [2, 32, 64, 128]) expect(annotImportable(base({ subtype: 'Square', flags: 4 | f }))).toBe(false);
  });
});

describe('pdfColorToHex', () => {
  it('reads gray, RGB and CMYK', () => {
    expect(pdfColorToHex([0.5])).toBe('#808080');
    expect(pdfColorToHex([1, 0, 0])).toBe('#ff0000');
    expect(pdfColorToHex([0, 1, 1, 0])).toBe('#ff0000');
  });
  it('treats an empty or missing colour as none', () => {
    expect(pdfColorToHex([])).toBe(null);
    expect(pdfColorToHex(null)).toBe(null);
  });
});

describe('annotToMarkups', () => {
  it('maps a Square to a rect, inset by half the border', () => {
    const [m] = annotToMarkups(base({ subtype: 'Square', rect: [99, 599, 201, 701], ic: [0, 0, 1], contents: 'Fix this' }), vp0);
    expect(m.type).toBe('rect');
    expect(m.pts).toEqual([{ vx: 100, vy: 92 }, { vx: 200, vy: 192 }]);
    expect(m.style).toMatchObject({ stroke: '#ff0000', fill: '#0000ff', width: 2, opacity: 1 });
    expect(m.text).toBe('Fix this');
  });
  it('uses /RD over the border width when present', () => {
    const [m] = annotToMarkups(base({ subtype: 'Circle', rect: [90, 590, 210, 710], rd: [10, 10, 10, 10] }), vp0);
    expect(m.type).toBe('ellipse');
    expect(m.pts).toEqual([{ vx: 100, vy: 92 }, { vx: 200, vy: 192 }]);
  });
  it('maps Line end heads to an arrow, and a start-only head to a reversed arrow', () => {
    expect(annotToMarkups(base({ subtype: 'Line', l: [0, 792, 10, 782], le: ['None', 'None'] }), vp0)[0].type).toBe('line');
    const [end] = annotToMarkups(base({ subtype: 'Line', l: [0, 792, 10, 782], le: ['None', 'OpenArrow'] }), vp0);
    expect(end).toMatchObject({ type: 'arrow', pts: [{ vx: 0, vy: 0 }, { vx: 10, vy: 10 }] });
    const [start] = annotToMarkups(base({ subtype: 'Line', l: [0, 792, 10, 782], le: ['ClosedArrow', 'None'] }), vp0);
    expect(start).toMatchObject({ type: 'arrow', pts: [{ vx: 10, vy: 10 }, { vx: 0, vy: 0 }] });
  });
  it('maps PolyLine, Polygon, and a cloud-bordered Polygon', () => {
    const v = [0, 792, 10, 782, 20, 792];
    expect(annotToMarkups(base({ subtype: 'PolyLine', vertices: v }), vp0)[0].type).toBe('polyline');
    expect(annotToMarkups(base({ subtype: 'Polygon', vertices: v }), vp0)[0].type).toBe('polygon');
    const [c] = annotToMarkups(base({ subtype: 'Polygon', vertices: v, be: 'C' }), vp0);
    expect(c.type).toBe('cloud');
    expect(c.pts).toEqual([{ vx: 0, vy: 0 }, { vx: 10, vy: 10 }, { vx: 20, vy: 0 }]);
  });
  it('rejects shapes with too few points', () => {
    expect(annotToMarkups(base({ subtype: 'Polygon', vertices: [0, 0, 1, 1] }), vp0)).toEqual([]);
    expect(annotToMarkups(base({ subtype: 'Line' }), vp0)).toEqual([]);
  });
  it('splits a multi-stroke Ink into one mark per stroke', () => {
    const out = annotToMarkups(base({ subtype: 'Ink', inkList: [[0, 792, 5, 787], [1, 1], [10, 792, 20, 782, 30, 792]], ca: 0.35 }), vp0);
    expect(out.map((m) => m.pts.length)).toEqual([2, 3]);
    expect(out[0].style.opacity).toBe(0.35);
  });
  it('maps text markups to viewport quads', () => {
    const q = [100, 700, 200, 700, 100, 690, 200, 690];
    const [h] = annotToMarkups(base({ subtype: 'Highlight', quadPoints: q, color: [1, 0.831, 0] }), vp0);
    expect(h).toMatchObject({ type: 'texthighlight', quads: [{ x: 100, y: 92, w: 100, h: 10 }] });
    expect(h.style.stroke).toBe('#ffd400');
    expect(annotToMarkups(base({ subtype: 'Underline', quadPoints: q }), vp0)[0].type).toBe('underline');
    expect(annotToMarkups(base({ subtype: 'StrikeOut', quadPoints: q }), vp0)[0].type).toBe('strikeout');
  });
  it('maps FreeText with its /DA font, size and colour', () => {
    const [t] = annotToMarkups(base({ subtype: 'FreeText', rect: [100, 600, 250, 644], contents: 'Note', da: '/TiRo 18 Tf 0 0 1 rg', color: null }), vp0);
    expect(t).toMatchObject({ type: 'text', text: 'Note', pts: [{ vx: 100, vy: 148 }, { vx: 250, vy: 192 }] });
    expect(t.style).toMatchObject({ stroke: '#0000ff', fontSize: 18, fontFamily: 'Times' });
  });
  it('maps a FreeText callout, box from /RD and tip from /CL', () => {
    const [c] = annotToMarkups(base({
      subtype: 'FreeText', it: 'FreeTextCallout', rect: [50, 550, 250, 700], rd: [50, 0, 0, 56],
      cl: [50, 700, 100, 644], contents: 'See detail'
    }), vp0);
    expect(c.type).toBe('callout');
    expect(c.pts).toEqual([{ vx: 100, vy: 148 }, { vx: 250, vy: 242 }, { vx: 50, vy: 92 }]);
  });
  it('keeps the author for display only', () => {
    const [m] = annotToMarkups(base({ subtype: 'Square', rect: [0, 0, 10, 10], author: 'J. Smith' }), vp0);
    expect(m.importedFrom).toBe('J. Smith');
  });
  it('lands boxes in the right place on a rotated page', () => {
    const [m] = annotToMarkups(base({ subtype: 'Square', rect: [99, 599, 201, 701] }), vp90);
    expect(m.pts).toEqual([{ vx: 600, vy: 100 }, { vx: 700, vy: 200 }]);
    const [h] = annotToMarkups(base({ subtype: 'Highlight', quadPoints: [100, 700, 200, 700, 100, 690, 200, 690] }), vp90);
    expect(h.quads).toEqual([{ x: 690, y: 100, w: 10, h: 100 }]);
  });
});
