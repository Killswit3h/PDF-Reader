import { describe, it, expect } from 'vitest';
import { UNITS, fmtMeasure, computeValue, ratioToFactor } from '../../src/shared/measure-math.js';

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
