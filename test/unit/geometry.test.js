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
