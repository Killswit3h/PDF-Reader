import { describe, it, expect } from 'vitest';
import mm from '../../src/shared/measure-math.js';

const { UNITS, fmtMeasure, formatFeetInches, computeValue, ratioToFactor, segmentLengths } = mm;
const P = (vx, vy) => ({ vx, vy });

// A 1:1 scale in feet: one PDF point maps to 1/864 ft (864 pt = 12 in = 1 ft).
const FT = { factor: 1 / 864, unit: 'ft' };

describe('UNITS table', () => {
  it('defines a foot as twelve inches of PDF points', () => {
    expect(UNITS.ft.perPoint).toBe(UNITS.in.perPoint * 12);
  });
  it('defines a yard as three feet', () => {
    expect(UNITS.yd.perPoint).toBe(UNITS.ft.perPoint * 3);
  });
  it('defines a metre as ten times a decimetre-equivalent of cm', () => {
    expect(UNITS.m.perPoint).toBeCloseTo(UNITS.cm.perPoint * 100, 6);
  });
  it('defines a centimetre as ten millimetres', () => {
    expect(UNITS.cm.perPoint).toBeCloseTo(UNITS.mm.perPoint * 10, 6);
  });
  it('uses the PDF 72-points-per-inch convention', () => {
    expect(UNITS.in.perPoint).toBe(72);
  });
});

describe('formatFeetInches', () => {
  it('renders a clean half foot', () => {
    expect(formatFeetInches(24.5, 16)).toBe(`24'-6"`);
  });
  it('renders a reduced fraction rather than sixteenths', () => {
    expect(formatFeetInches(24.53, 16)).toBe(`24'-6 3/8"`);
  });
  it('reduces 8/16 to 1/2', () => {
    expect(formatFeetInches(1.0416667, 16)).toBe(`1'-0 1/2"`);
  });
  it('carries a rounded 12 inches up into the next foot', () => {
    expect(formatFeetInches(0.9999, 16)).toBe(`1'-0"`);
  });
  it('renders zero', () => {
    expect(formatFeetInches(0, 16)).toBe(`0'-0"`);
  });
  it('keeps the sign on a negative length', () => {
    expect(formatFeetInches(-2.5, 16)).toBe(`-2'-6"`);
  });
  it('honours a coarser denominator', () => {
    expect(formatFeetInches(1.3, 2)).toBe(`1'-3 1/2"`);
  });
  it('defaults to sixteenths when no denominator is given', () => {
    expect(formatFeetInches(24.53)).toBe(formatFeetInches(24.53, 16));
  });
  it('never emits a denominator-equal numerator', () => {
    for (let i = 0; i < 400; i++) {
      const out = formatFeetInches(i * 0.017, 32);
      expect(out).not.toMatch(/\b(\d+)\/\1\b/);
    }
  });
  it('never emits twelve or more inches', () => {
    for (let i = 0; i < 400; i++) {
      const inches = Number(formatFeetInches(i * 0.017, 32).split('-')[1].split(' ')[0].replace('"', ''));
      expect(inches).toBeLessThan(12);
    }
  });
});

describe('fmtMeasure', () => {
  it('prints a count as a bare integer', () => {
    expect(fmtMeasure('count', 7, 'ct')).toBe('7');
  });
  it('prints an angle to one decimal with a degree sign', () => {
    expect(fmtMeasure('angle', 90, '°')).toBe('90.0°');
  });
  it('prints an area with a squared unit', () => {
    expect(fmtMeasure('area', 12.345, 'ft')).toBe('12.35 ft²');
  });
  it('prints a length to two decimals', () => {
    expect(fmtMeasure('length', 12.345, 'ft')).toBe('12.35 ft');
  });
  it('switches length to feet-inches when asked', () => {
    expect(fmtMeasure('length', 24.5, 'ft', { feetInches: true, denom: 16 })).toBe(`24'-6"`);
  });
  it('leaves area decimal even when feet-inches is on', () => {
    expect(fmtMeasure('area', 24.5, 'ft', { feetInches: true, denom: 16 })).toBe('24.50 ft²');
  });
  it('ignores feet-inches for a metric unit', () => {
    expect(fmtMeasure('length', 24.5, 'm', { feetInches: true, denom: 16 })).toBe('24.50 m');
  });
});

describe('computeValue', () => {
  it('counts points regardless of scale', () => {
    expect(computeValue('count', [P(0, 0), P(1, 1), P(2, 2)], null)).toEqual({ value: 3, unit: 'ct' });
  });
  it('measures a right angle', () => {
    const r = computeValue('angle', [P(10, 0), P(0, 0), P(0, 10)], null);
    expect(r.value).toBeCloseTo(90, 6);
    expect(r.unit).toBe('°');
  });
  it('reports a zero angle when given fewer than three points', () => {
    expect(computeValue('angle', [P(0, 0), P(1, 1)], null).value).toBe(0);
  });
  it('returns a null value for a length with no scale set', () => {
    expect(computeValue('length', [P(0, 0), P(864, 0)], null)).toEqual({ value: null, unit: null });
  });
  it('converts a length through the scale factor', () => {
    expect(computeValue('length', [P(0, 0), P(864, 0)], FT).value).toBeCloseTo(1, 9);
  });
  it('squares the scale factor for an area', () => {
    const sq = [P(0, 0), P(864, 0), P(864, 864), P(0, 864)];
    expect(computeValue('area', sq, FT).value).toBeCloseTo(1, 9);
  });
  it('sums every segment of a multi-segment length', () => {
    const pts = [P(0, 0), P(864, 0), P(864, 864)];
    expect(computeValue('length', pts, FT).value).toBeCloseTo(2, 9);
  });
  it('carries the scale unit through', () => {
    expect(computeValue('length', [P(0, 0), P(864, 0)], FT).unit).toBe('ft');
  });
});

describe('segmentLengths', () => {
  it('returns null without a scale', () => {
    expect(segmentLengths('length', [P(0, 0), P(10, 0)], null)).toBeNull();
  });
  it('returns null for fewer than two points', () => {
    expect(segmentLengths('length', [P(0, 0)], FT)).toBeNull();
  });
  it('gives one value per open segment', () => {
    const segs = segmentLengths('length', [P(0, 0), P(864, 0), P(864, 864)], FT);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toBeCloseTo(1, 9);
  });
  it('adds the closing segment for an area so the parts sum to the perimeter', () => {
    const sq = [P(0, 0), P(864, 0), P(864, 864), P(0, 864)];
    const segs = segmentLengths('area', sq, FT);
    expect(segs).toHaveLength(4);
    expect(segs.reduce((a, b) => a + b, 0)).toBeCloseTo(4, 9);
  });
  it('does not close a two-point area', () => {
    expect(segmentLengths('area', [P(0, 0), P(864, 0)], FT)).toHaveLength(1);
  });
});

describe('ratioToFactor', () => {
  it('maps one inch of paper to one inch of world at 1:1', () => {
    expect(ratioToFactor(1, 'in', 1)).toBeCloseTo(1 / 72, 12);
  });
  it('builds a factor that reproduces the stated real length', () => {
    // 1 inch on the sheet represents 20 ft: a 72-point line should measure 20.
    const f = ratioToFactor(1, 'in', 20);
    expect(computeValue('length', [P(0, 0), P(72, 0)], { factor: f, unit: 'ft' }).value)
      .toBeCloseTo(20, 9);
  });
  it('scales linearly with the real value', () => {
    expect(ratioToFactor(1, 'in', 40)).toBeCloseTo(ratioToFactor(1, 'in', 20) * 2, 12);
  });
  it('scales inversely with the drawn value', () => {
    expect(ratioToFactor(2, 'in', 20)).toBeCloseTo(ratioToFactor(1, 'in', 20) / 2, 12);
  });
  it('agrees across equivalent metric units', () => {
    expect(ratioToFactor(1, 'cm', 5)).toBeCloseTo(ratioToFactor(10, 'mm', 5), 12);
  });
});
