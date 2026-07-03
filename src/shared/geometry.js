'use strict';

/*
 * Pure 2-D geometry helpers, shared by the renderer modules (measure/markup/
 * placement) AND unit-tested directly in Node. All points are {vx, vy} in
 * scale-1 viewport space (top-left origin), the app's canonical coordinate
 * model. Nothing here touches the DOM, pdf.js, or App.state — keep it that way
 * so the whole file stays trivially testable.
 *
 * Dual export: `require()` in Node returns { Geom }, and a <script> tag in the
 * browser assigns App.Geom. Load it before the renderer modules.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  // Distance between two points.
  const dist = (a, b) => Math.hypot(b.vx - a.vx, b.vy - a.vy);

  // Total length of an open polyline.
  function polyLen(pts) {
    let s = 0;
    for (let i = 0; i < pts.length - 1; i++) s += dist(pts[i], pts[i + 1]);
    return s;
  }

  // Unsigned polygon area (shoelace formula). Winding-order independent.
  function shoelace(pts) {
    let s = 0; const n = pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      s += pts[i].vx * pts[j].vy - pts[j].vx * pts[i].vy;
    }
    return Math.abs(s) / 2;
  }

  // Interior angle (degrees, 0–180) at vertex B formed by A-B-C.
  function angleAt(A, B, C) {
    const a = Math.atan2(A.vy - B.vy, A.vx - B.vx);
    const b = Math.atan2(C.vy - B.vy, C.vx - B.vx);
    let d = (b - a) * 180 / Math.PI;
    d = ((d % 360) + 360) % 360;
    return d > 180 ? 360 - d : d;
  }

  // Arithmetic mean point of a set.
  function centroid(pts) {
    let x = 0, y = 0;
    pts.forEach((p) => { x += p.vx; y += p.vy; });
    return { vx: x / pts.length, vy: y / pts.length };
  }

  // Axis-aligned bounding box: { x, y, w, h }.
  function bbox(pts) {
    const xs = pts.map((p) => p.vx), ys = pts.map((p) => p.vy);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }

  // Normalized rectangle from two opposite corners: { vx, vy, vw, vh }.
  function rectFrom(a, b) {
    return {
      vx: Math.min(a.vx, b.vx), vy: Math.min(a.vy, b.vy),
      vw: Math.abs(b.vx - a.vx), vh: Math.abs(b.vy - a.vy)
    };
  }

  // Snap `raw` onto the 45° ray from `anchor` (Shift-constrain while drawing).
  function ortho(anchor, raw) {
    const step = Math.PI / 4;
    const ang = Math.round(Math.atan2(raw.vy - anchor.vy, raw.vx - anchor.vx) / step) * step;
    const len = Math.hypot(raw.vx - anchor.vx, raw.vy - anchor.vy);
    return { vx: anchor.vx + Math.cos(ang) * len, vy: anchor.vy + Math.sin(ang) * len };
  }

  // Nearest candidate vertex to `raw` within `threshold`, else null.
  // `candidates` is a flat array of {vx, vy}.
  function nearestVertex(candidates, raw, threshold) {
    let best = null, bd = threshold;
    for (const pt of candidates) {
      const d = Math.hypot(pt.vx - raw.vx, pt.vy - raw.vy);
      if (d < bd) { bd = d; best = pt; }
    }
    return best;
  }

  // The two wing points of an arrow head pointing from `from` to `to`.
  // `width` widens the head with the stroke. Returns [{vx,vy},{vx,vy}].
  function arrowHeadPoints(from, to, width) {
    const ang = Math.atan2(to.vy - from.vy, to.vx - from.vx);
    const len = 10 + (width || 0) * 2;
    const spread = 0.4;
    const a1 = ang + Math.PI - spread, a2 = ang + Math.PI + spread;
    return [
      { vx: to.vx + Math.cos(a1) * len, vy: to.vy + Math.sin(a1) * len },
      { vx: to.vx + Math.cos(a2) * len, vy: to.vy + Math.sin(a2) * len }
    ];
  }

  return {
    Geom: {
      dist, polyLen, shoelace, angleAt, centroid, bbox,
      rectFrom, ortho, nearestVertex, arrowHeadPoints
    }
  };
});
