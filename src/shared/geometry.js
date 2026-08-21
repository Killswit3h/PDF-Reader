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

  // Arithmetic mean point of a set. An empty set returns the origin rather than
  // {NaN, NaN}, which would otherwise flow into a measurement label's transform
  // and drop it off-page with no visible error.
  function centroid(pts) {
    if (!pts || !pts.length) return { vx: 0, vy: 0 };
    let x = 0, y = 0;
    pts.forEach((p) => { x += p.vx; y += p.vy; });
    return { vx: x / pts.length, vy: y / pts.length };
  }

  // Axis-aligned bounding box: { x, y, w, h }.
  // Scanned with a loop rather than Math.min(...xs): a long freehand stroke can
  // hold more points than the engine's argument limit, and spreading it there
  // throws RangeError mid-draw. Same reason simplify() is iterative.
  function bbox(pts) {
    if (!pts || !pts.length) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.vx < minX) minX = p.vx;
      if (p.vx > maxX) maxX = p.vx;
      if (p.vy < minY) minY = p.vy;
      if (p.vy > maxY) maxY = p.vy;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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

  // Ramer–Douglas–Peucker: drop points that lie within `eps` of the line through
  // their neighbours, killing hand tremor before we smooth. Iterative (no
  // recursion) so a very long freehand stroke can't blow the stack.
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      let idx = -1, maxD = eps;
      const a = pts[lo], b = pts[hi];
      const dx = b.vx - a.vx, dy = b.vy - a.vy;
      const len = Math.hypot(dx, dy) || 1;
      for (let i = lo + 1; i < hi; i++) {
        // perpendicular distance of pts[i] to segment a-b
        const d = Math.abs((pts[i].vx - a.vx) * dy - (pts[i].vy - a.vy) * dx) / len;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx !== -1) { keep[idx] = true; stack.push([lo, idx], [idx, hi]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // Turn a raw freehand stroke into a silky one: simplify away jitter, then
  // resample through the survivors with a centripetal-ish Catmull-Rom spline so
  // the curve passes through every kept point with rounded, flowing joins.
  // `samples` sub-segments per span (higher = smoother). Returns {vx,vy}[] in the
  // same scale-1 space, so renderer and PDF export can share one curve.
  function smoothStroke(pts, opts) {
    opts = opts || {};
    const eps = opts.eps == null ? 1 : opts.eps;
    const samples = opts.samples == null ? 8 : opts.samples;
    const p = simplify(pts, eps);
    if (p.length < 3) return p.map((q) => ({ vx: q.vx, vy: q.vy }));
    const out = [{ vx: p[0].vx, vy: p[0].vy }];
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p[i + 1];
      for (let s = 1; s <= samples; s++) {
        const t = s / samples, t2 = t * t, t3 = t2 * t;
        out.push({
          vx: 0.5 * ((2 * p1.vx) + (-p0.vx + p2.vx) * t + (2 * p0.vx - 5 * p1.vx + 4 * p2.vx - p3.vx) * t2 + (-p0.vx + 3 * p1.vx - 3 * p2.vx + p3.vx) * t3),
          vy: 0.5 * ((2 * p1.vy) + (-p0.vy + p2.vy) * t + (2 * p0.vy - 5 * p1.vy + 4 * p2.vy - p3.vy) * t2 + (-p0.vy + 3 * p1.vy - 3 * p2.vy + p3.vy) * t3)
        });
      }
    }
    return out;
  }

  // Compose two affine matrices [a,b,c,d,e,f] the PDF.js way: the result applied
  // to a point equals m1(m2(point)) — i.e. `m2` acts first. Used to accumulate a
  // content stream's current transform (CTM) while harvesting path geometry.
  function matMul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  // Apply an affine matrix [a,b,c,d,e,f] to (x, y) → [x', y'].
  function matApply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  // Extract the on-path anchor vertices (segment endpoints + rectangle corners)
  // from a PDF.js `constructPath` operator's `(ops, args)`. Bezier control points
  // are skipped — only points the pen actually lands on, which are the useful
  // snap targets. `codes` maps op names → this PDF.js build's numeric OPS values
  // (moveTo/lineTo/curveTo/curveTo2/curveTo3/rectangle/closePath), so this stays
  // pure and dependency-free (unit-tested without pdf.js). Returns [[x,y], …] in
  // the path's local user space; apply the CTM separately.
  function constructPathVertices(ops, args, codes) {
    const out = [];
    let j = 0;
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k] | 0;
      if (op === codes.rectangle) {
        const x = args[j], y = args[j + 1], w = args[j + 2], h = args[j + 3]; j += 4;
        out.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
      } else if (op === codes.moveTo || op === codes.lineTo) {
        out.push([args[j], args[j + 1]]); j += 2;
      } else if (op === codes.curveTo) {
        out.push([args[j + 4], args[j + 5]]); j += 6;   // cubic: land on the 3rd point
      } else if (op === codes.curveTo2 || op === codes.curveTo3) {
        out.push([args[j + 2], args[j + 3]]); j += 4;   // shorthand cubics: 2 arg-pairs
      } // closePath carries no coordinates
    }
    return out;
  }

  // Map a pointer's on-screen offset within a page's markup layer back into the
  // layer's UNROTATED scale-1 viewport point {vx, vy}. Overlays are drawn in
  // unrotated page space and the whole layer is then rigid-rotated by `rot`
  // (0/90/180/270) with a CSS transform to sit on the rotated canvas (see
  // viewer.js syncPageEls). getBoundingClientRect() returns the axis-aligned box
  // of that *rotated* layer, so the naive `(dx, dy) / zoom` only lands correctly
  // at rot 0 — for 90/180/270 the axes are swapped and/or flipped, which is what
  // makes a click land far from the pen on a rotated page. `dx, dy` are the
  // offset from that bounding box's top-left; `lw, lh` are the layer's UNROTATED
  // CSS size (its layout box, e.g. offsetWidth/offsetHeight). Inverse of the
  // rigid rotation, so on-screen click == on-page point at every orientation.
  function unrotatePoint(dx, dy, lw, lh, rot, z) {
    const r = (((rot || 0) % 360) + 360) % 360;
    let lx, ly;
    if (r === 90)       { lx = dy;      ly = lh - dx; }
    else if (r === 180) { lx = lw - dx; ly = lh - dy; }
    else if (r === 270) { lx = lw - dy; ly = dx; }
    else                { lx = dx;      ly = dy; }
    return { vx: lx / z, vy: ly / z };
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

  /* ---------------- circles and arcs (radius measurement) ---------------- */

  // Circle through three points, or null when they do not define one.
  //
  // Three collinear points have no circumcircle: the perpendicular bisectors
  // are parallel and the centre runs off to infinity. Unguarded that yields
  // Infinity/NaN coordinates, which would be stored in the measurement model
  // and written into the saved PDF -- so this returns null and the caller
  // refuses the measurement instead.
  //
  // Collinearity is judged RELATIVE to the size of the triangle rather than
  // against a fixed epsilon, so the same tolerance behaves correctly on a 1:20
  // detail and a 1:2000 key sheet.
  function circumcircle(a, b, c) {
    if (!a || !b || !c) return null;
    const ax = a.vx, ay = a.vy, bx = b.vx, by = b.vy, cx = c.vx, cy = c.vy;
    // Twice the signed area of the triangle; zero exactly when collinear.
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    // Scale the tolerance by the triangle's extent squared: |d| is an area, so
    // comparing it to a length would be dimensionally wrong and would change
    // behaviour with zoom.
    const scale = Math.max(dist(a, b), dist(b, c), dist(a, c));
    if (!scale || Math.abs(d) < 1e-9 * scale * scale) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    const centre = { vx: ux, vy: uy };
    const r = dist(centre, a);
    if (!isFinite(r) || r <= 0) return null;
    return { vx: ux, vy: uy, r };
  }

  // Angle of a point on a circle, measured from the centre.
  function angleOf(centre, pt) { return Math.atan2(pt.vy - centre.vy, pt.vx - centre.vx); }

  // Sample points along an arc. For bounding boxes only -- drawing uses a real
  // curve (SVG arc on screen, Bezier in the PDF) so nothing is ever faceted.
  function arcPoints(centre, r, a0, a1, n) {
    const steps = Math.max(2, n || 24);
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (a1 - a0) * (i / steps);
      out.push({ vx: centre.vx + r * Math.cos(t), vy: centre.vy + r * Math.sin(t) });
    }
    return out;
  }

  // The arc from p0 to p2 that passes through pmid, as a signed angular span.
  // Three points on a circle leave two possible arcs between the outer two; the
  // middle click is what picks which. Returns { a0, a1 } where a1 - a0 is signed
  // (negative = clockwise), so drawing and export sweep the same way.
  function arcSpanThrough(centre, p0, pmid, p2) {
    const TAU = Math.PI * 2;
    const a0 = angleOf(centre, p0);
    const norm = (t) => { let x = t % TAU; if (x < 0) x += TAU; return x; };
    const dm = norm(angleOf(centre, pmid) - a0);
    const d2 = norm(angleOf(centre, p2) - a0);
    // Counter-clockwise only if the middle point is reached before the end.
    return (dm <= d2) ? { a0, a1: a0 + d2 } : { a0, a1: a0 - (TAU - d2) };
  }

  // Approximate an arc with cubic Bezier segments, each spanning at most 90
  // degrees -- the standard construction, and accurate to well under a printer
  // dot at that span. PDF content streams have no arc operator, only 'c', so
  // this is how a true curve reaches the exported appearance stream.
  // Returns [{ x1,y1, x2,y2, x,y }] control points, following a move to the
  // arc's start point.
  function arcToBezier(centre, r, a0, a1) {
    const total = a1 - a0;
    if (!isFinite(total) || total === 0 || !(r > 0)) return [];
    const count = Math.ceil(Math.abs(total) / (Math.PI / 2));
    const step = total / count;
    // Control-point offset for a circular arc of this span.
    const k = (4 / 3) * Math.tan(step / 4);
    const segs = [];
    for (let i = 0; i < count; i++) {
      const s = a0 + step * i, e = s + step;
      const cs = Math.cos(s), ss = Math.sin(s), ce = Math.cos(e), se = Math.sin(e);
      segs.push({
        x1: centre.vx + r * (cs - k * ss), y1: centre.vy + r * (ss + k * cs),
        x2: centre.vx + r * (ce + k * se), y2: centre.vy + r * (se - k * ce),
        x: centre.vx + r * ce, y: centre.vy + r * se
      });
    }
    return segs;
  }

  return {
    Geom: {
      dist, polyLen, shoelace, angleAt, centroid, bbox,
      rectFrom, ortho, nearestVertex, arrowHeadPoints, unrotatePoint,
      simplify, smoothStroke,
      circumcircle, angleOf, arcPoints, arcToBezier, arcSpanThrough,
      matMul, matApply, constructPathVertices
    }
  };
});
