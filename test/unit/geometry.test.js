import { describe, it, expect } from 'vitest';
import geom from '../../src/shared/geometry.js';

const { Geom } = geom;
const P = (vx, vy) => ({ vx, vy });

describe('Geom.dist', () => {
  it('measures a 3-4-5 triangle hypotenuse', () => {
    expect(Geom.dist(P(0, 0), P(3, 4))).toBe(5);
  });
  it('is zero for identical points', () => {
    expect(Geom.dist(P(7, 7), P(7, 7))).toBe(0);
  });
});

describe('Geom.polyLen', () => {
  it('sums segment lengths of an open polyline', () => {
    expect(Geom.polyLen([P(0, 0), P(0, 3), P(4, 3)])).toBe(7);
  });
  it('is zero for a single point', () => {
    expect(Geom.polyLen([P(1, 1)])).toBe(0);
  });
});

describe('Geom.shoelace', () => {
  it('computes the area of a 10x10 square', () => {
    expect(Geom.shoelace([P(0, 0), P(10, 0), P(10, 10), P(0, 10)])).toBe(100);
  });
  it('is winding-order independent (clockwise = same area)', () => {
    expect(Geom.shoelace([P(0, 0), P(0, 10), P(10, 10), P(10, 0)])).toBe(100);
  });
  it('computes a triangle area', () => {
    expect(Geom.shoelace([P(0, 0), P(4, 0), P(0, 3)])).toBe(6);
  });
});

describe('Geom.angleAt', () => {
  it('returns 90 for a right angle', () => {
    expect(Geom.angleAt(P(1, 0), P(0, 0), P(0, 1))).toBeCloseTo(90, 6);
  });
  it('returns 180 for a straight line', () => {
    expect(Geom.angleAt(P(-1, 0), P(0, 0), P(1, 0))).toBeCloseTo(180, 6);
  });
  it('returns 45 for a diagonal', () => {
    expect(Geom.angleAt(P(1, 0), P(0, 0), P(1, 1))).toBeCloseTo(45, 6);
  });
});

describe('Geom.centroid', () => {
  it('averages the points', () => {
    expect(Geom.centroid([P(0, 0), P(10, 0), P(10, 10), P(0, 10)])).toEqual(P(5, 5));
  });
});

describe('Geom.bbox', () => {
  it('bounds a scattered set', () => {
    expect(Geom.bbox([P(2, 3), P(8, 1), P(5, 9)])).toEqual({ x: 2, y: 1, w: 6, h: 8 });
  });
});

describe('Geom.rectFrom', () => {
  it('normalizes corners regardless of order', () => {
    expect(Geom.rectFrom(P(10, 10), P(2, 4))).toEqual({ vx: 2, vy: 4, vw: 8, vh: 6 });
  });
});

describe('Geom.ortho', () => {
  it('snaps a near-horizontal drag to horizontal', () => {
    const r = Geom.ortho(P(0, 0), P(10, 1));
    expect(r.vy).toBeCloseTo(0, 6);
    expect(r.vx).toBeGreaterThan(9);
  });
  it('snaps a near-45 drag onto the diagonal', () => {
    const r = Geom.ortho(P(0, 0), P(10, 9));
    expect(r.vx).toBeCloseTo(r.vy, 6);
  });
});

describe('Geom.nearestVertex', () => {
  const verts = [P(0, 0), P(100, 100), P(50, 50)];
  it('finds a vertex within threshold', () => {
    expect(Geom.nearestVertex(verts, P(52, 49), 10)).toEqual(P(50, 50));
  });
  it('returns null when nothing is close enough', () => {
    expect(Geom.nearestVertex(verts, P(52, 49), 1)).toBeNull();
  });
});

describe('Geom.simplify', () => {
  it('keeps only the endpoints of a straight, evenly-sampled run', () => {
    const line = [P(0, 0), P(1, 0), P(2, 0), P(3, 0), P(4, 0)];
    expect(Geom.simplify(line, 0.5)).toEqual([P(0, 0), P(4, 0)]);
  });
  it('preserves a real corner above epsilon', () => {
    const bent = [P(0, 0), P(5, 0), P(10, 0), P(10, 10)];
    const s = Geom.simplify(bent, 0.5);
    expect(s).toContainEqual(P(10, 0)); // the corner survives
    expect(s.length).toBeLessThan(bent.length); // the collinear mid-point is dropped
  });
  it('returns short inputs untouched', () => {
    expect(Geom.simplify([P(0, 0), P(1, 1)], 1)).toEqual([P(0, 0), P(1, 1)]);
  });
});

describe('Geom.smoothStroke', () => {
  it('keeps the first and last anchor points', () => {
    const raw = [P(0, 0), P(4, 6), P(9, 2), P(14, 8), P(20, 0)];
    const s = Geom.smoothStroke(raw, { eps: 0.5, samples: 6 });
    expect(s[0]).toEqual(P(0, 0));
    expect(s[s.length - 1]).toEqual(P(20, 0));
  });
  it('densifies a multi-point stroke into a finer curve', () => {
    const raw = [P(0, 0), P(4, 6), P(9, 2), P(14, 8), P(20, 0)];
    const s = Geom.smoothStroke(raw, { eps: 0.5, samples: 8 });
    expect(s.length).toBeGreaterThan(raw.length);
  });
  it('leaves a two-point (straightened) stroke as a plain segment', () => {
    expect(Geom.smoothStroke([P(0, 0), P(10, 0)], {})).toEqual([P(0, 0), P(10, 0)]);
  });
  it('collapses tremor smaller than epsilon toward the trend line', () => {
    // Zig-zag amplitude 3 < eps 4 -> simplify drops every wobble, leaving a flat line.
    const zig = [P(0, 0), P(2, 3), P(4, -3), P(6, 3), P(8, -3), P(10, 0)];
    const s = Geom.smoothStroke(zig, { eps: 4, samples: 10 });
    const maxAbsY = Math.max(...s.map((p) => Math.abs(p.vy)));
    expect(maxAbsY).toBeLessThan(0.001);
  });
  it('keeps spline overshoot bounded near the input envelope', () => {
    const zig = [P(0, 0), P(2, 3), P(4, -3), P(6, 3), P(8, -3), P(10, 0)];
    const s = Geom.smoothStroke(zig, { eps: 0.1, samples: 10 });
    const maxAbsY = Math.max(...s.map((p) => Math.abs(p.vy)));
    expect(maxAbsY).toBeLessThan(3.6); // Catmull-Rom may overshoot slightly, never wildly
  });
});

describe('Geom.matMul / matApply', () => {
  const I = [1, 0, 0, 1, 0, 0];
  it('identity is a no-op under matApply', () => {
    expect(Geom.matApply(I, 3, 7)).toEqual([3, 7]);
  });
  it('applies scale+translate', () => {
    // 2x scale, then +(10,20)
    expect(Geom.matApply([2, 0, 0, 2, 10, 20], 3, 4)).toEqual([16, 28]);
  });
  it('composes so m2 acts first (matMul then apply == nested apply)', () => {
    const m1 = [2, 0, 0, 2, 10, 20];   // scale 2, translate
    const m2 = [1, 0, 0, 1, 5, 5];     // translate (5,5)
    const composed = Geom.matMul(m1, m2);
    const p = [3, 4];
    const nested = Geom.matApply(m1, ...Geom.matApply(m2, p[0], p[1]));
    expect(Geom.matApply(composed, p[0], p[1])).toEqual(nested);
  });
});

describe('Geom.constructPathVertices', () => {
  // Mirror the PDF.js 3.11 OPS numbers used by the content-snap harvester.
  const CODES = { moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, rectangle: 19, closePath: 18 };
  it('collects moveTo/lineTo endpoints', () => {
    const v = Geom.constructPathVertices([CODES.moveTo, CODES.lineTo], [1, 2, 3, 4], CODES);
    expect(v).toEqual([[1, 2], [3, 4]]);
  });
  it('expands a rectangle into 4 corners', () => {
    const v = Geom.constructPathVertices([CODES.rectangle], [0, 0, 10, 5], CODES);
    expect(v).toEqual([[0, 0], [10, 0], [10, 5], [0, 5]]);
  });
  it('keeps only the on-curve endpoint of a cubic bezier', () => {
    // curveTo consumes 6 args (c1x,c1y,c2x,c2y,x,y) → anchor is (x,y)
    const v = Geom.constructPathVertices([CODES.moveTo, CODES.curveTo], [0, 0, 1, 1, 2, 2, 9, 8], CODES);
    expect(v).toEqual([[0, 0], [9, 8]]);
  });
  it('ignores closePath (no coordinates)', () => {
    const v = Geom.constructPathVertices([CODES.moveTo, CODES.lineTo, CODES.closePath], [0, 0, 4, 0], CODES);
    expect(v).toEqual([[0, 0], [4, 0]]);
  });
});

describe('Geom.arrowHeadPoints', () => {
  it('returns two wing points behind the tip', () => {
    const [w1, w2] = Geom.arrowHeadPoints(P(0, 0), P(10, 0), 2);
    // both wings sit to the left of the tip (x < 10)
    expect(w1.vx).toBeLessThan(10);
    expect(w2.vx).toBeLessThan(10);
    // symmetric about the shaft
    expect(w1.vy).toBeCloseTo(-w2.vy, 6);
  });
  it('grows the head with stroke width', () => {
    const thin = Geom.arrowHeadPoints(P(0, 0), P(10, 0), 0);
    const thick = Geom.arrowHeadPoints(P(0, 0), P(10, 0), 8);
    expect(Math.abs(thick[0].vy)).toBeGreaterThan(Math.abs(thin[0].vy));
  });
});

describe('Geom.unrotatePoint', () => {
  // A page is 100x200 (unrotated, scale-1); the layer is drawn at that size and
  // then rigid-rotated by CSS. lw/lh are the layer's UNROTATED size, and the
  // (dx, dy) passed in are the offset within the rotated bounding box on screen.
  const lw = 100, lh = 200, z = 1;

  it('is a plain offset/zoom at 0°', () => {
    expect(Geom.unrotatePoint(30, 40, lw, lh, 0, z)).toEqual({ vx: 30, vy: 40 });
  });
  it('scales by zoom at 0°', () => {
    expect(Geom.unrotatePoint(60, 80, lw, lh, 0, 2)).toEqual({ vx: 30, vy: 40 });
  });

  // At each rotation, the four unrotated corners map to their known on-screen
  // bounding-box offsets; unrotatePoint must invert that back to the corner.
  it('maps the corners back at 90°', () => {
    // (lx,ly) -> screen (lh-ly, lx)
    expect(Geom.unrotatePoint(lh, 0, lw, lh, 90, z)).toEqual({ vx: 0, vy: 0 });
    expect(Geom.unrotatePoint(lh, lw, lw, lh, 90, z)).toEqual({ vx: lw, vy: 0 });
    expect(Geom.unrotatePoint(0, 0, lw, lh, 90, z)).toEqual({ vx: 0, vy: lh });
    expect(Geom.unrotatePoint(0, lw, lw, lh, 90, z)).toEqual({ vx: lw, vy: lh });
  });
  it('maps the corners back at 180°', () => {
    // (lx,ly) -> screen (lw-lx, lh-ly)
    expect(Geom.unrotatePoint(lw, lh, lw, lh, 180, z)).toEqual({ vx: 0, vy: 0 });
    expect(Geom.unrotatePoint(0, 0, lw, lh, 180, z)).toEqual({ vx: lw, vy: lh });
  });
  it('maps the corners back at 270°', () => {
    // (lx,ly) -> screen (ly, lw-lx)
    expect(Geom.unrotatePoint(0, lw, lw, lh, 270, z)).toEqual({ vx: 0, vy: 0 });
    expect(Geom.unrotatePoint(lh, lw, lw, lh, 270, z)).toEqual({ vx: 0, vy: lh });
    expect(Geom.unrotatePoint(0, 0, lw, lh, 270, z)).toEqual({ vx: lw, vy: 0 });
  });
  it('normalizes negative/overspun rotations', () => {
    expect(Geom.unrotatePoint(30, 40, lw, lh, -270, z))
      .toEqual(Geom.unrotatePoint(30, 40, lw, lh, 90, z));
    expect(Geom.unrotatePoint(30, 40, lw, lh, 450, z))
      .toEqual(Geom.unrotatePoint(30, 40, lw, lh, 90, z));
  });
});
