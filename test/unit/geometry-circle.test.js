import { describe, it, expect } from 'vitest';
import { Geom } from '../../src/shared/geometry.js';

const { circumcircle, angleOf, arcPoints, arcToBezier, dist } = Geom;

// A radius that is silently wrong is worse than one that refuses to draw: it
// prints on a sheet someone builds from. These are the guards for that.
describe('circumcircle', () => {
  it('recovers a known circle from three points on it', () => {
    const c = circumcircle({ vx: 100, vy: 0 }, { vx: 0, vy: 100 }, { vx: -100, vy: 0 });
    expect(c.vx).toBeCloseTo(0, 9);
    expect(c.vy).toBeCloseTo(0, 9);
    expect(c.r).toBeCloseTo(100, 9);
  });

  it('recovers an off-origin circle', () => {
    const centre = { vx: 250, vy: -80 }, r = 37.5;
    const at = (deg) => ({
      vx: centre.vx + r * Math.cos(deg * Math.PI / 180),
      vy: centre.vy + r * Math.sin(deg * Math.PI / 180)
    });
    const c = circumcircle(at(10), at(140), at(265));
    expect(c.vx).toBeCloseTo(centre.vx, 6);
    expect(c.vy).toBeCloseTo(centre.vy, 6);
    expect(c.r).toBeCloseTo(r, 6);
  });

  it('does not depend on the order the points were clicked', () => {
    const a = { vx: 3, vy: 4 }, b = { vx: -5, vy: 12 }, c = { vx: 13, vy: -1 };
    const ref = circumcircle(a, b, c);
    for (const [p, q, r] of [[b, c, a], [c, a, b], [c, b, a], [b, a, c]]) {
      const got = circumcircle(p, q, r);
      expect(got.vx).toBeCloseTo(ref.vx, 9);
      expect(got.vy).toBeCloseTo(ref.vy, 9);
      expect(got.r).toBeCloseTo(ref.r, 9);
    }
  });

  // The failure mode that can corrupt a saved file: an unguarded circumcircle
  // through collinear points divides by ~0 and yields Infinity/NaN, which would
  // be written into the round-trip model and the exported annotation.
  describe('degenerate input returns null rather than Infinity/NaN', () => {
    it('rejects exactly collinear points', () => {
      expect(circumcircle({ vx: 0, vy: 0 }, { vx: 10, vy: 10 }, { vx: 20, vy: 20 })).toBeNull();
    });

    it('rejects collinear points on a horizontal line', () => {
      expect(circumcircle({ vx: 0, vy: 5 }, { vx: 50, vy: 5 }, { vx: 120, vy: 5 })).toBeNull();
    });

    it('rejects three identical points', () => {
      const p = { vx: 7, vy: 7 };
      expect(circumcircle(p, p, p)).toBeNull();
    });

    it('rejects two coincident points', () => {
      expect(circumcircle({ vx: 0, vy: 0 }, { vx: 0, vy: 0 }, { vx: 9, vy: 3 })).toBeNull();
    });

    it('rejects a near-collinear click the user meant as a straight line', () => {
      // 200pt apart with a 1e-7pt bow -- far below anything clickable.
      expect(circumcircle({ vx: 0, vy: 0 }, { vx: 100, vy: 1e-7 }, { vx: 200, vy: 0 })).toBeNull();
    });

    it('returns null for missing points instead of throwing', () => {
      expect(circumcircle(null, { vx: 1, vy: 1 }, { vx: 2, vy: 5 })).toBeNull();
      expect(circumcircle(undefined, undefined, undefined)).toBeNull();
    });
  });

  // The tolerance is relative to the triangle, so a shallow-but-real curve is
  // kept at any drawing scale rather than being thrown away on a big sheet.
  it('keeps a shallow but genuine arc, at small and large scale alike', () => {
    for (const k of [1, 10, 1000]) {
      const c = circumcircle(
        { vx: 0, vy: 0 }, { vx: 100 * k, vy: 2 * k }, { vx: 200 * k, vy: 0 }
      );
      expect(c).not.toBeNull();
      expect(Number.isFinite(c.r)).toBe(true);
      expect(c.r).toBeGreaterThan(0);
    }
  });

  it('never returns a non-finite radius', () => {
    const cases = [
      [{ vx: 0, vy: 0 }, { vx: 1e-12, vy: 0 }, { vx: 2e-12, vy: 0 }],
      [{ vx: 0, vy: 0 }, { vx: 1e9, vy: 1 }, { vx: 2e9, vy: 0 }]
    ];
    for (const [a, b, c] of cases) {
      const got = circumcircle(a, b, c);
      if (got) expect(Number.isFinite(got.r)).toBe(true);
    }
  });
});

describe('angleOf', () => {
  it('measures from the centre, east = 0', () => {
    const c = { vx: 10, vy: 10 };
    expect(angleOf(c, { vx: 20, vy: 10 })).toBeCloseTo(0, 9);
    expect(angleOf(c, { vx: 10, vy: 20 })).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('arcPoints', () => {
  it('starts and ends on the arc endpoints', () => {
    const c = { vx: 5, vy: -5 }, r = 12;
    const pts = arcPoints(c, r, 0, Math.PI / 2, 16);
    expect(pts).toHaveLength(17);
    expect(pts[0].vx).toBeCloseTo(c.vx + r, 9);
    expect(pts[pts.length - 1].vy).toBeCloseTo(c.vy + r, 9);
  });

  it('keeps every sample on the circle', () => {
    const c = { vx: 0, vy: 0 }, r = 40;
    for (const p of arcPoints(c, r, 0.3, 4.2, 12)) expect(dist(c, p)).toBeCloseTo(r, 9);
  });
});

// PDF content streams have no arc operator, so the exported curve is Bezier.
describe('arcToBezier', () => {
  it('splits at 90 degrees so no segment is over-stretched', () => {
    const c = { vx: 0, vy: 0 };
    expect(arcToBezier(c, 10, 0, Math.PI / 2)).toHaveLength(1);
    expect(arcToBezier(c, 10, 0, Math.PI)).toHaveLength(2);
    expect(arcToBezier(c, 10, 0, Math.PI * 2)).toHaveLength(4);
    expect(arcToBezier(c, 10, 0, Math.PI / 4)).toHaveLength(1);
  });

  it('lands its final endpoint exactly on the circle', () => {
    const c = { vx: 3, vy: 8 }, r = 25, a1 = 2.1;
    const segs = arcToBezier(c, r, 0.2, a1);
    const last = segs[segs.length - 1];
    expect(last.x).toBeCloseTo(c.vx + r * Math.cos(a1), 9);
    expect(last.y).toBeCloseTo(c.vy + r * Math.sin(a1), 9);
  });

  it('stays within a hair of the true circle at the segment midpoint', () => {
    // Worst-case error for a Bezier arc sits mid-segment; a quarter circle
    // should be accurate to far better than a printer dot.
    const c = { vx: 0, vy: 0 }, r = 100;
    const [s] = arcToBezier(c, r, 0, Math.PI / 2);
    const t = 0.5;
    const p0 = { x: r, y: 0 };
    const mt = 1 - t;
    const x = mt * mt * mt * p0.x + 3 * mt * mt * t * s.x1 + 3 * mt * t * t * s.x2 + t * t * t * s.x;
    const y = mt * mt * mt * p0.y + 3 * mt * mt * t * s.y1 + 3 * mt * t * t * s.y2 + t * t * t * s.y;
    expect(Math.hypot(x, y)).toBeCloseTo(r, 2);
  });

  it('returns nothing for a zero-span arc or a zero radius', () => {
    expect(arcToBezier({ vx: 0, vy: 0 }, 10, 1, 1)).toEqual([]);
    expect(arcToBezier({ vx: 0, vy: 0 }, 0, 0, Math.PI)).toEqual([]);
  });
});

// A chord polyline always under-measures the curve it approximates. This is the
// density rule that keeps that shortfall invisible in an exported measurement,
// and the numbers below are why the rule is 1 degree rather than something
// chosen by eye.
describe('arcTessellationSegments', () => {
  const { arcTessellationSegments } = Geom;
  const polylineLen = (r, theta, n) => 2 * n * r * Math.sin(Math.abs(theta) / (2 * n));

  it('splits at about half a degree per segment', () => {
    expect(arcTessellationSegments(Math.PI)).toBe(360);
    expect(arcTessellationSegments(Math.PI * 2)).toBe(720);
  });

  it('floors short arcs so they still look smooth', () => {
    expect(arcTessellationSegments(0.001)).toBe(24);
    expect(arcTessellationSegments(0)).toBe(24);
  });

  it('caps long sweeps so a file cannot bloat without bound', () => {
    expect(arcTessellationSegments(Math.PI * 20)).toBe(1440);
  });

  it('is sign-agnostic — a clockwise sweep tessellates like a counter-clockwise one', () => {
    expect(arcTessellationSegments(-Math.PI)).toBe(arcTessellationSegments(Math.PI));
  });

  // The case from the plan sheet that prompted the tool: a ~292 degree
  // cul-de-sac run at R42, whose drawing calls out 214 LF of guardrail.
  it('keeps a 214ft run inside a hundredth of a foot', () => {
    const r = 42, theta = 292 * Math.PI / 180;
    const n = arcTessellationSegments(theta);
    const shortfall = r * theta - polylineLen(r, theta, n);
    expect(shortfall).toBeLessThan(0.01);
    expect(r * theta).toBeCloseTo(214.05, 1);
  });

  // The guarantee is RELATIVE, because the helper knows the arc in points and
  // has no idea what a point is worth in feet. This is the bound everything
  // else follows from, and it holds at any radius and any sweep.
  it('holds a relative shortfall of a few parts per million at any size', () => {
    for (const r of [5, 42, 200, 1000]) {
      for (const deg of [15, 90, 180, 292, 359]) {
        const theta = deg * Math.PI / 180;
        const n = arcTessellationSegments(theta);
        const arc = r * theta;
        expect((arc - polylineLen(r, theta, n)) / arc).toBeLessThan(5e-6);
      }
    }
  });

  // What that relative bound buys in absolute terms for runs the size a plan
  // sheet actually carries: comfortably inside the hundredth of a foot the
  // label displays. A 1000ft-radius full sweep is 6000ft of arc and does drift
  // past that -- it is also not a curved run anyone takes off a drawing.
  it('keeps runs up to about 3000ft inside a hundredth of a foot', () => {
    for (const r of [5, 42, 200]) {
      for (const deg of [15, 90, 180, 292, 359]) {
        const theta = deg * Math.PI / 180;
        const n = arcTessellationSegments(theta);
        const arc = r * theta;
        expect(arc).toBeLessThan(3200);
        expect(arc - polylineLen(r, theta, n)).toBeLessThan(0.01);
      }
    }
  });
});
