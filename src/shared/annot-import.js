'use strict';

/*
 * Foreign annotation import: turn a PDF annotation made in another app
 * (Bluebeam, Acrobat, Preview) into FieldMark markups. Pure mapping only; the
 * renderer (js/annotimport.js) reads the annotation dictionaries with pdf-lib,
 * flattens each into the plain descriptor below, and owns the document swap.
 *
 * Descriptor (all numbers in PDF user space, as stored in the file):
 *   { subtype, rect, color, ic, width, ca, contents, author, flags, measure,
 *     irt, it, be, rd, l, le, vertices, inkList, quadPoints, cl, da }
 *
 * `toVP(x, y)` maps a PDF point to a scale-1 viewport point {vx, vy}. The
 * renderer passes the page's viewport.convertToViewportPoint, the exact
 * inverse of the export path, so rotated pages land in the right place.
 *
 * Dual export -> { annotImportable, annotToMarkups, pdfColorToHex } in Node,
 * or the same names on App in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  const SUPPORTED = {
    Square: 1, Circle: 1, Line: 1, PolyLine: 1, Polygon: 1, Ink: 1,
    Highlight: 1, Underline: 1, StrikeOut: 1, FreeText: 1
  };
  // Annotation flags (ISO 32000 table 165). Hidden/NoView marks are not on the
  // sheet; ReadOnly/Locked marks were locked on purpose by whoever made them.
  const F_HIDDEN = 2, F_NOVIEW = 32, F_READONLY = 64, F_LOCKED = 128;
  const SKIP_FLAGS = F_HIDDEN | F_NOVIEW | F_READONLY | F_LOCKED;

  // Whether a descriptor is one we turn into an editable markup (FR-3).
  // Measurements (a /Measure dictionary, or a *Dimension intent) stay native:
  // importing one as a plain shape would drop the takeoff value (D3). Replies
  // stay native so a review thread is never split from its parent.
  function annotImportable(d) {
    if (!d || !SUPPORTED[d.subtype]) return false;
    if (d.measure || d.irt) return false;
    if ((d.flags || 0) & SKIP_FLAGS) return false;
    if (d.it && /Dimension$/.test(d.it)) return false;
    return true;
  }

  // PDF colour array (0..1; 1 = gray, 3 = RGB, 4 = CMYK) -> '#rrggbb'.
  // An empty array means transparent, returned as null.
  function pdfColorToHex(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    let r, g, b;
    if (arr.length === 1) { r = g = b = arr[0]; }
    else if (arr.length === 3) { [r, g, b] = arr; }
    else if (arr.length === 4) {
      const [c, m, y, k] = arr;
      r = (1 - c) * (1 - k); g = (1 - m) * (1 - k); b = (1 - y) * (1 - k);
    } else return null;
    const h = (v) => {
      const n = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
      return (n < 16 ? '0' : '') + n.toString(16);
    };
    return '#' + h(r) + h(g) + h(b);
  }

  // Axis-aligned viewport box of a set of PDF points. Page rotation is always a
  // multiple of 90 degrees, so a PDF rectangle stays a rectangle.
  function vpBox(toVP, xs, ys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      const p = toVP(xs[i], ys[i]);
      if (p.vx < x0) x0 = p.vx; if (p.vx > x1) x1 = p.vx;
      if (p.vy < y0) y0 = p.vy; if (p.vy > y1) y1 = p.vy;
    }
    return { x0, y0, x1, y1 };
  }
  function rectBox(toVP, r) {
    return vpBox(toVP, [r[0], r[2], r[0], r[2]], [r[1], r[1], r[3], r[3]]);
  }
  // Rect shrunk by /RD when present, else by half the border width: the shape
  // itself, without the stroke overhang every writer pads Rect with.
  function innerRect(d, width) {
    const r = d.rect;
    const rd = Array.isArray(d.rd) && d.rd.length === 4 ? d.rd : [width / 2, width / 2, width / 2, width / 2];
    const x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]);
    const x1 = Math.max(r[0], r[2]), y1 = Math.max(r[1], r[3]);
    const out = [x0 + rd[0], y0 + rd[1], x1 - rd[2], y1 - rd[3]];
    // A bogus /RD bigger than the box: fall back to the raw Rect.
    return out[2] > out[0] && out[3] > out[1] ? out : [x0, y0, x1, y1];
  }
  function pairs(flat) {
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  }
  const isHead = (n) => !!n && n !== 'None' && n !== 'Butt';

  // Font size, family and colour out of a FreeText /DA string.
  function parseDA(da) {
    const out = { size: null, family: null, color: null };
    if (typeof da !== 'string') return out;
    const tf = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da);
    if (tf) {
      const n = parseFloat(tf[2]);
      if (n > 0) out.size = n;
      const f = tf[1].toLowerCase();
      out.family = /^(tiro|times)/.test(f) ? 'Times' : /^(cour)/.test(f) ? 'Courier' : 'Helvetica';
    }
    const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
    const g = /([\d.]+)\s+g(?:\s|$)/.exec(da);
    if (rg) out.color = pdfColorToHex([+rg[1], +rg[2], +rg[3]]);
    else if (g) out.color = pdfColorToHex([+g[1]]);
    return out;
  }

  // One descriptor -> an array of markups without id/page (the caller assigns
  // both). Usually one; an Ink with several strokes gives one markup per
  // stroke, since a FieldMark ink mark is a single stroke. Empty when the
  // annotation is unsupported or has no usable geometry.
  function annotToMarkups(d, toVP) {
    if (!annotImportable(d)) return [];
    const width = typeof d.width === 'number' && d.width >= 0 ? d.width : 1;
    const style = {
      stroke: pdfColorToHex(d.color) || '#e5484d',
      fill: pdfColorToHex(d.ic) || 'none',
      width: width || 1,
      opacity: typeof d.ca === 'number' && d.ca >= 0 && d.ca <= 1 ? d.ca : 1,
      fontSize: 14,
      fontFamily: 'Helvetica'
    };
    const extra = {};
    if (d.author) extra.importedFrom = String(d.author);
    const note = d.contents ? String(d.contents) : '';
    const mk = (type, geom, withNote) => Object.assign(
      { type, style: Object.assign({}, style) }, geom,
      withNote && note ? { text: note } : {}, extra);

    switch (d.subtype) {
      case 'Square': case 'Circle': {
        if (!Array.isArray(d.rect) || d.rect.length !== 4) return [];
        const b = rectBox(toVP, innerRect(d, width));
        return [mk(d.subtype === 'Square' ? 'rect' : 'ellipse',
          { pts: [{ vx: b.x0, vy: b.y0 }, { vx: b.x1, vy: b.y1 }] }, true)];
      }
      case 'Line': {
        const L = d.l;
        if (!Array.isArray(L) || L.length !== 4) return [];
        let a = toVP(L[0], L[1]), c = toVP(L[2], L[3]);
        const le = Array.isArray(d.le) ? d.le : [];
        const startHead = isHead(le[0]), endHead = isHead(le[1]);
        // FieldMark's arrow has one head, at the end. A start-only head is the
        // same arrow drawn the other way round.
        if (startHead && !endHead) { const t = a; a = c; c = t; }
        return [mk(startHead || endHead ? 'arrow' : 'line',
          { pts: [{ vx: a.vx, vy: a.vy }, { vx: c.vx, vy: c.vy }] }, true)];
      }
      case 'PolyLine': case 'Polygon': {
        const P = pairs(Array.isArray(d.vertices) ? d.vertices : []);
        const poly = d.subtype === 'Polygon';
        if (P.length < (poly ? 3 : 2)) return [];
        const pts = P.map((p) => toVP(p[0], p[1]));
        const type = !poly ? 'polyline' : d.be === 'C' ? 'cloud' : 'polygon';
        return [mk(type, { pts }, true)];
      }
      case 'Ink': {
        const out = [];
        (Array.isArray(d.inkList) ? d.inkList : []).forEach((stroke, i) => {
          const P = pairs(Array.isArray(stroke) ? stroke : []);
          if (P.length < 2) return;
          out.push(mk('ink', { pts: P.map((p) => toVP(p[0], p[1])) }, i === 0));
        });
        return out;
      }
      case 'Highlight': case 'Underline': case 'StrikeOut': {
        const Q = Array.isArray(d.quadPoints) ? d.quadPoints : [];
        const quads = [];
        for (let i = 0; i + 7 < Q.length; i += 8) {
          const b = vpBox(toVP, [Q[i], Q[i + 2], Q[i + 4], Q[i + 6]], [Q[i + 1], Q[i + 3], Q[i + 5], Q[i + 7]]);
          if (b.x1 - b.x0 > 0 && b.y1 - b.y0 > 0) quads.push({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
        }
        if (!quads.length) return [];
        const type = d.subtype === 'Highlight' ? 'texthighlight' : d.subtype === 'Underline' ? 'underline' : 'strikeout';
        const m = mk(type, { quads }, true);
        m.style.fill = 'none';
        return [m];
      }
      case 'FreeText': {
        if (!Array.isArray(d.rect) || d.rect.length !== 4) return [];
        const da = parseDA(d.da);
        // FreeText /C is the box BACKGROUND, not the text; text colour rides
        // in /DA. Default to black type, the FieldMark text default.
        const tstyle = {
          stroke: da.color || '#000000', fill: 'none', width: width || 1,
          opacity: style.opacity, fontSize: da.size || 14, fontFamily: da.family || 'Helvetica'
        };
        const hasRD = Array.isArray(d.rd) && d.rd.length === 4;
        const b = rectBox(toVP, hasRD ? innerRect(d, 0) : d.rect);
        const box = [{ vx: b.x0, vy: b.y0 }, { vx: b.x1, vy: b.y1 }];
        const text = note || '';
        const callout = d.it === 'FreeTextCallout' && Array.isArray(d.cl) && d.cl.length >= 4;
        if (callout) {
          const tip = toVP(d.cl[0], d.cl[1]);
          return [Object.assign({ type: 'callout', style: tstyle, text, pts: box.concat([{ vx: tip.vx, vy: tip.vy }]) }, extra)];
        }
        return [Object.assign({ type: 'text', style: tstyle, text, pts: box }, extra)];
      }
      default: return [];
    }
  }

  return { annotImportable, annotToMarkups, pdfColorToHex, ANNOT_IMPORT_SUBTYPES: Object.keys(SUPPORTED) };
});
