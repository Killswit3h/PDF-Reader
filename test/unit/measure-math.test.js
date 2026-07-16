import { describe, it, expect } from 'vitest';
import { UNITS, fmtMeasure, formatFeetInches, computeValue, ratioToFactor, segmentLengths } from '../../src/shared/measure-math.js';

const P = (vx, vy) => ({ vx, vy });
const SQUARE = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)];

describe('UNITS table', () => {
  it('inches are 72 points', () => expect(UNITS.in.perPoint).toBe(72));
  it('feet are 12x inches', () => expect(UNITS.ft.perPoint).toBe(72 * 12));
  it('a metre is 1000 mm worth of points', () => {
    expect(UNITS.m.perPoint).toBeCloseTo(UNITS.mm.perPoint * 1000, 6);
  });
});

describe('fmtMeasure', () => {
  it('formats length to 2 decimals with unit', () => {
    expect(fmtMeasure('length', 3.14159, 'ft')).toBe('3.14 ft');
  });
  it('formats area with a squared unit', () => {
    expect(fmtMeasure('area', 12.5, 'm')).toBe('12.50 m²');
  });
  it('formats angle to 1 decimal + degree sign', () => {
    expect(fmtMeasure('angle', 89.95, '°')).toBe('90.0°');
  });
  it('formats a count as a bare integer', () => {
    expect(fmtMeasure('count', 7, 'ct')).toBe('7');
  });
});

describe('formatFeetInches', () => {
  it('renders whole feet with zero inches', () => {
    expect(formatFeetInches(24, 16)).toBe("24'-0\"");
  });
  it('renders a clean half foot as 6 inches', () => {
    expect(formatFeetInches(24.5, 16)).toBe("24'-6\"");
  });
  it('renders and reduces a fractional inch', () => {
    // 0.53125 ft = 6.375 in = 6 3/8"
    expect(formatFeetInches(24.53125, 16)).toBe("24'-6 3/8\"");
  });
  it('carries rounding up into the next foot', () => {
    // 11.999" rounds to 12" → +1 ft, 0 in
    expect(formatFeetInches(1 - 0.001 / 12, 16)).toBe("1'-0\"");
  });
  it('reduces 8/16 to 1/2', () => {
    // 0.5 in = 0.5/12 ft → "0'-0 1/2\""
    expect(formatFeetInches(0.5 / 12, 16)).toBe("0'-0 1/2\"");
  });
  it('honors a coarser denominator (1/4)', () => {
    // 6.3 in at denom 4 → nearest 1/4 is 6 1/4"
    expect(formatFeetInches(6.3 / 12, 4)).toBe("0'-6 1/4\"");
  });
  it('is negative-safe', () => {
    expect(formatFeetInches(-2.5, 16)).toBe("-2'-6\"");
  });
});

describe('fmtMeasure feet-inches option', () => {
  it('formats feet length as architectural feet-inches when opted in', () => {
    expect(fmtMeasure('length', 24.5, 'ft', { feetInches: true, denom: 16 })).toBe("24'-6\"");
  });
  it('ignores feet-inches for non-foot units', () => {
    expect(fmtMeasure('length', 3.14159, 'm', { feetInches: true, denom: 16 })).toBe('3.14 m');
  });
  it('keeps area decimal even with feet-inches on', () => {
    expect(fmtMeasure('area', 12.5, 'ft', { feetInches: true, denom: 16 })).toBe('12.50 ft²');
  });
  it('stays decimal by default (no opts)', () => {
    expect(fmtMeasure('length', 24.5, 'ft')).toBe('24.50 ft');
  });
});

describe('segmentLengths', () => {
  const P = (vx, vy) => ({ vx, vy });
  it('returns null without a scale', () => {
    expect(segmentLengths('length', [P(0, 0), P(10, 0)], null)).toBeNull();
  });
  it('gives per-segment real lengths of an open polyline', () => {
    // 0,0 ->10,0 ->10,10 with factor 0.5 => [5, 5]
    expect(segmentLengths('perimeter', [P(0, 0), P(10, 0), P(10, 10)], { factor: 0.5, unit: 'ft' }))
      .toEqual([5, 5]);
  });
  it('includes the closing segment for an area', () => {
    // square 10x10, factor 1 => 4 sides of 10
    const sq = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)];
    expect(segmentLengths('area', sq, { factor: 1, unit: 'ft' })).toEqual([10, 10, 10, 10]);
  });
});

describe('computeValue', () => {
  it('counts points regardless of scale', () => {
    expect(computeValue('count', SQUARE, null)).toEqual({ value: 4, unit: 'ct' });
  });
  it('computes an angle without a scale', () => {
    const r = computeValue('angle', [P(1, 0), P(0, 0), P(0, 1)], null);
    expect(r.value).toBeCloseTo(90, 6);
    expect(r.unit).toBe('°');
  });
  it('returns null value when a scaled type has no scale', () => {
    expect(computeValue('length', SQUARE, null)).toEqual({ value: null, unit: null });
  });
  it('scales area by factor squared', () => {
    expect(computeValue('area', SQUARE, { factor: 2, unit: 'ft' })).toEqual({ value: 400, unit: 'ft' });
  });
  it('scales perimeter/length linearly', () => {
    // open polyline 0,0 -> 10,0 -> 10,10  = length 20, factor 0.5 => 10
    const line = [P(0, 0), P(10, 0), P(10, 10)];
    expect(computeValue('length', line, { factor: 0.5, unit: 'in' })).toEqual({ value: 10, unit: 'in' });
  });
  it('sums a continuous run as the total of every leg', () => {
    // continuous is an open polyline like length/perimeter — sum of all legs
    const run = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)]; // legs 10+10+10 = 30
    expect(computeValue('continuous', run, { factor: 0.5, unit: 'ft' })).toEqual({ value: 15, unit: 'ft' });
  });
  it('formats a continuous total like a length', () => {
    expect(fmtMeasure('continuous', 15, 'ft')).toBe('15.00 ft');
  });
});

describe('ratioToFactor', () => {
  it('1in on drawing = 10ft real gives 10 units per inch-worth-of-points', () => {
    // 1 in = 72 points; 10 ft real => factor = 10 / 72
    expect(ratioToFactor(1, 'in', 10)).toBeCloseTo(10 / 72, 9);
  });
  it('round-trips a measured length back to the entered ratio', () => {
    const factor = ratioToFactor(0.25, 'in', 1); // 1/4" = 1ft
    // 0.25in worth of points = 18 points; measuring 18 points should read 1
    expect(18 * factor).toBeCloseTo(1, 9);
  });
});
