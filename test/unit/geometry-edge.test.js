import { describe, it, expect } from 'vitest';
import geom from '../../src/shared/geometry.js';

const { Geom } = geom;
const P = (vx, vy) => ({ vx, vy });

// A freehand stroke long enough to exceed the engine's spread-argument limit.
// Geom.bbox used to do Math.min(...xs) and threw RangeError here mid-draw.
const HUGE = 250000;
const hugeStroke = Array.from({ length: HUGE }, (_, i) => P(i % 1000, (i * 7) % 800));

describe('Geom.bbox', () => {
  it('returns the origin box for an empty set', () => {
    expect(Geom.bbox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
  it('returns a zero-size box for a single point', () => {
    expect(Geom.bbox([P(5, 9)])).toEqual({ x: 5, y: 9, w: 0, h: 0 });
  });
  it('spans negative coordinates', () => {
    expect(Geom.bbox([P(-10, -4), P(6, 2)])).toEqual({ x: -10, y: -4, w: 16, h: 6 });
  });
  it('ignores point order', () => {
    expect(Geom.bbox([P(3, 3), P(0, 0), P(1, 9)])).toEqual({ x: 0, y: 0, w: 3, h: 9 });
  });
  // Regression: long ink strokes used to blow the argument limit on draw + save.
  it('handles a stroke larger than the spread-argument limit', () => {
    expect(() => Geom.bbox(hugeStroke)).not.toThrow();
    const b = Geom.bbox(hugeStroke);
    expect(b.x).toBe(0);
    expect(b.w).toBe(999);
  });
});

describe('Geom.centroid', () => {
  it('returns the origin for an empty set instead of NaN', () => {
    expect(Geom.centroid([])).toEqual({ vx: 0, vy: 0 });
  });
  it('returns the point itself for a single point', () => {
    expect(Geom.centroid([P(4, 8)])).toEqual({ vx: 4, vy: 8 });
  });
  it('averages a square to its middle', () => {
    expect(Geom.centroid([P(0, 0), P(10, 0), P(10, 10), P(0, 10)])).toEqual({ vx: 5, vy: 5 });
  });
});

describe('Geom.ortho', () => {
  const anchor = P(0, 0);
  it('snaps a near-horizontal drag to exactly horizontal', () => {
    const r = Geom.ortho(anchor, P(100, 8));
    expect(r.vy).toBeCloseTo(0, 6);
    expect(r.vx).toBeCloseTo(Math.hypot(100, 8), 6);
  });
  it('snaps a near-45 drag onto the diagonal', () => {
    const r = Geom.ortho(anchor, P(100, 92));
    expect(r.vx).toBeCloseTo(r.vy, 6);
  });
  it('preserves the drag length', () => {
    const r = Geom.ortho(anchor, P(30, 70));
    expect(Math.hypot(r.vx, r.vy)).toBeCloseTo(Math.hypot(30, 70), 6);
  });
});

describe('Geom.nearestVertex', () => {
  const cands = [P(0, 0), P(10, 10), P(50, 50)];
  it('finds the closest candidate inside the threshold', () => {
    expect(Geom.nearestVertex(cands, P(11, 11), 5)).toEqual(P(10, 10));
  });
  it('returns null when everything is beyond the threshold', () => {
    expect(Geom.nearestVertex(cands, P(200, 200), 5)).toBeNull();
  });
  it('returns null for no candidates', () => {
    expect(Geom.nearestVertex([], P(1, 1), 10)).toBeNull();
  });
  it('excludes a candidate sitting exactly at the threshold', () => {
    expect(Geom.nearestVertex([P(0, 0)], P(5, 0), 5)).toBeNull();
  });
});

describe('Geom.simplify', () => {
  it('passes through fewer than three points untouched', () => {
    const pts = [P(0, 0), P(5, 5)];
    expect(Geom.simplify(pts, 1)).toEqual(pts);
  });
  it('drops collinear midpoints', () => {
    expect(Geom.simplify([P(0, 0), P(5, 0), P(10, 0)], 1)).toEqual([P(0, 0), P(10, 0)]);
  });
  it('keeps a vertex that deviates beyond eps', () => {
    expect(Geom.simplify([P(0, 0), P(5, 20), P(10, 0)], 1)).toHaveLength(3);
  });
  it('always keeps both endpoints', () => {
    const src = hugeStroke.slice(0, 5000);
    const out = Geom.simplify(src, 2);
    expect(out[0]).toEqual(src[0]);
    expect(out[out.length - 1]).toEqual(src[4999]);
  });
  it('does not overflow the stack on a very long stroke', () => {
    expect(() => Geom.simplify(hugeStroke, 2)).not.toThrow();
  });
});

describe('Geom.smoothStroke', () => {
  it('returns a copy for fewer than three points', () => {
    expect(Geom.smoothStroke([P(0, 0), P(3, 3)], {})).toEqual([P(0, 0), P(3, 3)]);
  });
  it('starts at the original first point', () => {
    const pts = [P(0, 0), P(10, 5), P(20, 0), P(30, 8)];
    expect(Geom.smoothStroke(pts, { eps: 0 })[0]).toEqual(P(0, 0));
  });
  it('emits more points than it was given', () => {
    const pts = [P(0, 0), P(10, 5), P(20, 0), P(30, 8)];
    expect(Geom.smoothStroke(pts, { eps: 0 }).length).toBeGreaterThan(pts.length);
  });
  it('honours the samples option', () => {
    const pts = [P(0, 0), P(10, 5), P(20, 0)];
    const few = Geom.smoothStroke(pts, { eps: 0, samples: 2 });
    const many = Geom.smoothStroke(pts, { eps: 0, samples: 16 });
    expect(many.length).toBeGreaterThan(few.length);
  });
});

describe('Geom.unrotatePoint', () => {
  const lw = 100, lh = 200;
  it('is a plain divide at rotation 0', () => {
    expect(Geom.unrotatePoint(10, 20, lw, lh, 0, 1)).toEqual({ vx: 10, vy: 20 });
  });
  it('maps correctly at 90', () => {
    expect(Geom.unrotatePoint(10, 20, lw, lh, 90, 1)).toEqual({ vx: 20, vy: 190 });
  });
  it('maps correctly at 180', () => {
    expect(Geom.unrotatePoint(10, 20, lw, lh, 180, 1)).toEqual({ vx: 90, vy: 180 });
  });
  it('maps correctly at 270', () => {
    expect(Geom.unrotatePoint(10, 20, lw, lh, 270, 1)).toEqual({ vx: 80, vy: 10 });
  });
  it('normalizes a negative rotation to its positive equivalent', () => {
    expect(Geom.unrotatePoint(10, 20, lw, lh, -90, 1))
      .toEqual(Geom.unrotatePoint(10, 20, lw, lh, 270, 1));
  });
  it('normalizes rotations beyond 360', () => {
    expect(Geom.unrotatePoint(10, 20, lw, lh, 450, 1))
      .toEqual(Geom.unrotatePoint(10, 20, lw, lh, 90, 1));
  });
  it('divides by zoom', () => {
    expect(Geom.unrotatePoint(10, 20, lw, lh, 0, 2)).toEqual({ vx: 5, vy: 10 });
  });
});

describe('Geom.arrowHeadPoints', () => {
  it('produces two wings symmetric about the shaft', () => {
    const [w1, w2] = Geom.arrowHeadPoints(P(0, 0), P(100, 0), 0);
    expect(w1.vy).toBeCloseTo(-w2.vy, 6);
    expect(w1.vx).toBeCloseTo(w2.vx, 6);
  });
  it('places both wings behind the tip', () => {
    const [w1, w2] = Geom.arrowHeadPoints(P(0, 0), P(100, 0), 0);
    expect(w1.vx).toBeLessThan(100);
    expect(w2.vx).toBeLessThan(100);
  });
  it('grows the head with stroke width', () => {
    const thin = Geom.arrowHeadPoints(P(0, 0), P(100, 0), 0)[0];
    const thick = Geom.arrowHeadPoints(P(0, 0), P(100, 0), 6)[0];
    expect(thick.vx).toBeLessThan(thin.vx);
  });
});

describe('Geom.matMul and Geom.matApply', () => {
  const I = [1, 0, 0, 1, 0, 0];
  it('treats identity as a no-op', () => {
    expect(Geom.matMul(I, I)).toEqual(I);
  });
  it('applies identity unchanged', () => {
    expect(Geom.matApply(I, 7, 9)).toEqual([7, 9]);
  });
  it('applies a translation', () => {
    expect(Geom.matApply([1, 0, 0, 1, 5, 6], 1, 1)).toEqual([6, 7]);
  });
  it('applies a scale', () => {
    expect(Geom.matApply([2, 0, 0, 3, 0, 0], 4, 5)).toEqual([8, 15]);
  });
  it('composes so the second matrix acts first', () => {
    const scale = [2, 0, 0, 2, 0, 0];
    const move = [1, 0, 0, 1, 10, 0];
    expect(Geom.matApply(Geom.matMul(scale, move), 1, 0)[0]).toBe(22);
  });
});

describe('Geom.constructPathVertices', () => {
  const codes = { moveTo: 1, lineTo: 2, curveTo: 3, curveTo2: 4, curveTo3: 5, rectangle: 6, closePath: 7 };
  it('expands a rectangle into four corners', () => {
    expect(Geom.constructPathVertices([codes.rectangle], [10, 20, 30, 40], codes))
      .toEqual([[10, 20], [40, 20], [40, 60], [10, 60]]);
  });
  it('takes the landing point of moveTo and lineTo', () => {
    expect(Geom.constructPathVertices([codes.moveTo, codes.lineTo], [1, 2, 3, 4], codes))
      .toEqual([[1, 2], [3, 4]]);
  });
  it('takes only the endpoint of a cubic curve', () => {
    expect(Geom.constructPathVertices([codes.curveTo], [1, 1, 2, 2, 9, 9], codes))
      .toEqual([[9, 9]]);
  });
  it('takes the endpoint of shorthand cubics', () => {
    expect(Geom.constructPathVertices([codes.curveTo2], [1, 1, 8, 8], codes))
      .toEqual([[8, 8]]);
  });
  it('ignores closePath, which carries no coordinates', () => {
    expect(Geom.constructPathVertices([codes.moveTo, codes.closePath], [5, 5], codes))
      .toEqual([[5, 5]]);
  });
  it('returns nothing for an empty path', () => {
    expect(Geom.constructPathVertices([], [], codes)).toEqual([]);
  });
});
