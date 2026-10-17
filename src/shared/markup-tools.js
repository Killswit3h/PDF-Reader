'use strict';

/*
 * Pure helpers behind the Bluebeam-parity markup tools: the standard stamp
 * library, hyperlink target validation, the eraser's hit test, grid snapping
 * and line dash patterns. Kept out of the renderer so Node can unit-test them.
 *
 * Geometry is in scale-1 viewport points, top-left origin, like every other
 * mark in the app.
 *
 * Dual export → named functions in Node, or the same names on App in the
 * browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  /* ---------------- stamps ---------------- */
  // The standard review stamps construction users expect from Revu's stamp
  // list. `date` adds a second line with the date the stamp is placed. The
  // `name` is the PDF /Name written on export; Acrobat's own stamp names are
  // used where one exists so its stamp tools recognise them.
  const STAMPS = [
    { id: 'approved', text: 'APPROVED', color: '#15803d', date: true, name: 'Approved' },
    { id: 'approved-noted', text: 'APPROVED AS NOTED', color: '#15803d', date: true, name: 'Approved' },
    { id: 'revise', text: 'REVISE & RESUBMIT', color: '#c2410c', date: true, name: 'NotApproved' },
    { id: 'rejected', text: 'REJECTED', color: '#b91c1c', date: true, name: 'NotApproved' },
    { id: 'reviewed', text: 'REVIEWED', color: '#1d4ed8', date: true, name: 'Approved' },
    { id: 'for-review', text: 'FOR REVIEW', color: '#1d4ed8', date: true, name: 'Draft' },
    { id: 'as-built', text: 'AS-BUILT', color: '#7c3aed', date: true, name: 'Final' },
    { id: 'completed', text: 'COMPLETED', color: '#15803d', date: true, name: 'Final' },
    { id: 'void', text: 'VOID', color: '#b91c1c', date: false, name: 'Void' },
    { id: 'draft', text: 'DRAFT', color: '#b91c1c', date: false, name: 'Draft' },
    { id: 'preliminary', text: 'PRELIMINARY', color: '#c2410c', date: false, name: 'Draft' },
    { id: 'not-for-construction', text: 'NOT FOR CONSTRUCTION', color: '#b91c1c', date: false, name: 'NotForPublicRelease' },
    { id: 'confidential', text: 'CONFIDENTIAL', color: '#b91c1c', date: false, name: 'Confidential' },
    { id: 'received', text: 'RECEIVED', color: '#1d4ed8', date: true, name: 'Final' }
  ];

  function stampById(id) { return STAMPS.find((s) => s.id === id) || null; }

  function stampDate(d) {
    const x = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
    return `${x.getMonth() + 1}/${x.getDate()}/${x.getFullYear()}`;
  }

  // The lines of text a stamp shows: its label, and the date when it has one.
  function stampLines(stamp, when) {
    if (!stamp) return [];
    const lines = [String(stamp.text || '').trim() || 'STAMP'];
    if (stamp.date) lines.push(stampDate(when));
    return lines;
  }

  // Box size for a stamp in points, sized to its text. Helvetica-Bold capitals
  // average about 0.72 em; the date line is set smaller.
  function stampSize(lines, fontSize) {
    const fs = fontSize || 18;
    const main = lines[0] || '';
    const w = Math.max(60, main.length * fs * 0.74 + fs * 1.6);
    const h = fs * 1.6 + (lines.length > 1 ? fs * 0.75 : 0);
    return { w, h };
  }

  /* ---------------- hyperlinks ---------------- */
  // Only these schemes may leave the app. A PDF link (ours or one imported
  // from another file) is untrusted input: a file:, javascript: or custom
  // scheme handed to the OS can launch programs. Returns the normalised URL,
  // or null when the target must be refused.
  function safeLinkUrl(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^www\./i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch (_) { return null; }
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    if (u.protocol === 'mailto:') return u.href;
    return null;
  }

  // Parse what the user typed into the link box: a page number ("12", "p12",
  // "page 12") jumps inside the document; anything else must be a safe URL.
  function parseLinkTarget(raw, numPages) {
    const s = String(raw == null ? '' : raw).trim();
    const m = /^(?:p(?:age)?\s*)?(\d{1,5})$/i.exec(s);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && (!numPages || n <= numPages)) return { page: n };
      return null;
    }
    const url = safeLinkUrl(s);
    return url ? { url } : null;
  }

  /* ---------------- eraser hit test ---------------- */
  function segDist(p, a, b) {
    const dx = b.vx - a.vx, dy = b.vy - a.vy;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.vx - a.vx) * dx + (p.vy - a.vy) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.vx - (a.vx + t * dx), p.vy - (a.vy + t * dy));
  }
  function boxOf(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) {
      if (q.vx < x0) x0 = q.vx; if (q.vx > x1) x1 = q.vx;
      if (q.vy < y0) y0 = q.vy; if (q.vy > y1) y1 = q.vy;
    }
    return { x0, y0, x1, y1 };
  }
  function inBox(p, b, tol) {
    return p.vx >= b.x0 - tol && p.vx <= b.x1 + tol && p.vy >= b.y0 - tol && p.vy <= b.y1 + tol;
  }
  function pointInPoly(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.vy > p.vy) !== (b.vy > p.vy) &&
          p.vx < ((b.vx - a.vx) * (p.vy - a.vy)) / ((b.vy - a.vy) || 1e-9) + a.vx) inside = !inside;
    }
    return inside;
  }

  // Does point p (viewport points) touch markup `an` within `tol`? Filled and
  // boxed marks are hit anywhere inside; open strokes only near the line.
  function hitTestMarkup(an, p, tol) {
    const t = tol == null ? 6 : tol;
    if (!an || !p) return false;
    if (an.quads && an.quads.length) {
      return an.quads.some((q) => p.vx >= q.x - t && p.vx <= q.x + q.w + t && p.vy >= q.y - t && p.vy <= q.y + q.h + t);
    }
    const pts = an.pts || [];
    if (!pts.length) return false;
    const filled = an.style && an.style.fill && an.style.fill !== 'none';
    switch (an.type) {
      case 'text': case 'stamp': case 'link': case 'redact':
        return inBox(p, boxOf(pts.slice(0, 2)), t);
      case 'callout':
        return inBox(p, boxOf(pts.slice(0, 2)), t) || (pts[2] ? segDist(p, pts[2], pts[0]) <= t : false);
      case 'note':
        return inBox(p, { x0: pts[0].vx, y0: pts[0].vy, x1: pts[0].vx + 22, y1: pts[0].vy + 22 }, t);
      case 'rect': {
        const b = boxOf(pts);
        if (filled) return inBox(p, b, t);
        const c = [{ vx: b.x0, vy: b.y0 }, { vx: b.x1, vy: b.y0 }, { vx: b.x1, vy: b.y1 }, { vx: b.x0, vy: b.y1 }];
        return c.some((a, i) => segDist(p, a, c[(i + 1) % 4]) <= t);
      }
      case 'ellipse': {
        const b = boxOf(pts);
        const rx = (b.x1 - b.x0) / 2, ry = (b.y1 - b.y0) / 2;
        if (rx <= 0 || ry <= 0) return false;
        const nx = (p.vx - (b.x0 + rx)) / rx, ny = (p.vy - (b.y0 + ry)) / ry;
        const r = Math.hypot(nx, ny);
        if (filled) return r <= 1 + t / Math.min(rx, ry);
        return Math.abs(r - 1) * Math.min(rx, ry) <= t;
      }
      case 'polygon': case 'cloud':
        if (filled && pointInPoly(p, pts)) return true;
        for (let i = 0; i < pts.length; i++) if (segDist(p, pts[i], pts[(i + 1) % pts.length]) <= t) return true;
        return false;
      default: {
        // line, arrow, polyline, ink, highlight — an open stroke.
        const w = an.type === 'highlight' ? Math.max(10, ((an.style && an.style.width) || 2) * 6) / 2 : 0;
        if (pts.length === 1) return Math.hypot(p.vx - pts[0].vx, p.vy - pts[0].vy) <= t + w;
        for (let i = 0; i < pts.length - 1; i++) if (segDist(p, pts[i], pts[i + 1]) <= t + w) return true;
        return false;
      }
    }
  }

  // Topmost markup on `page` under p (last drawn wins, the way it renders).
  function topMarkupAt(list, page, p, tol) {
    for (let i = (list || []).length - 1; i >= 0; i--) {
      const an = list[i];
      if (an.page === page && hitTestMarkup(an, p, tol)) return an;
    }
    return null;
  }

  /* ---------------- grid ---------------- */
  function snapToGrid(p, spacing) {
    const s = +spacing;
    if (!p || !(s > 0)) return p;
    return { vx: Math.round(p.vx / s) * s, vy: Math.round(p.vy / s) * s };
  }

  /* ---------------- line styles ---------------- */
  // Dash patterns in multiples of the line width, so a dashed 6pt line looks
  // like a dashed 1pt line scaled up rather than a row of dots.
  const LINE_STYLES = [
    { id: 'solid', label: 'Solid', dash: null },
    { id: 'dashed', label: 'Dashed', dash: [4, 3] },
    { id: 'dotted', label: 'Dotted', dash: [1, 2] },
    { id: 'dashdot', label: 'Dash-dot', dash: [6, 2, 1, 2] }
  ];
  // Concrete dash array in points for a style id and line width, or null for
  // solid / unknown.
  function dashArray(styleId, width) {
    const st = LINE_STYLES.find((s) => s.id === styleId);
    if (!st || !st.dash) return null;
    const w = Math.max(1, +width || 1);
    return st.dash.map((n) => +(n * w).toFixed(2));
  }

  return {
    STAMPS, stampById, stampLines, stampSize, stampDate,
    safeLinkUrl, parseLinkTarget,
    hitTestMarkup, topMarkupAt,
    snapToGrid,
    LINE_STYLES, dashArray
  };
});
