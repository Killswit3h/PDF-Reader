import { describe, it, expect } from 'vitest';
import { computeValue, fmtMeasure, circleOf } from '../../src/shared/measure-math.js';

// factor = real units per scale-1 point. 0.5 ft/pt => 100pt = 50ft.
const FT = { factor: 0.5, unit: 'ft' };
const M = { factor: 0.1, unit: 'm' };

// Three points on a circle of radius 100 centred at the origin.
const ON_R100 = [{ vx: 100, vy: 0 }, { vx: 0, vy: 100 }, { vx: -100, vy: 0 }];
const COLLINEAR = [{ vx: 0, vy: 0 }, { vx: 10, vy: 10 }, { vx: 20, vy: 20 }];

describe('circleOf', () => {
  it('reads centre and radius straight off a centre-radius pair', () => {
    const c = circleOf('radiusCenter', [{ vx: 20, vy: 30 }, { vx: 20, vy: 80 }]);
    expect(c).toEqual({ vx: 20, vy: 30, r: 50 });
  });

  it('derives the circle through three arc points', () => {
    const c = circleOf('radius3', ON_R100);
    expect(c.r).toBeCloseTo(100, 9);
    expect(c.vx).toBeCloseTo(0, 9);
  });

  it('is null when the points cannot define a circle', () => {
    expect(circleOf('radius3', COLLINEAR)).toBeNull();
    expect(circleOf('radiusCenter', [{ vx: 5, vy: 5 }, { vx: 5, vy: 5 }])).toBeNull();
    expect(circleOf('radius3', [{ vx: 0, vy: 0 }])).toBeNull();
    expect(circleOf('radiusCenter', [{ vx: 0, vy: 0 }])).toBeNull();
    expect(circleOf('length', ON_R100)).toBeNull();
  });
});

describe('computeValue — radius types', () => {
  it('reports the radius in the scale units, not the arc length', () => {
    // The distinction this whole feature turns on: r=100pt at 0.5 ft/pt is
    // 50ft, NOT the 157ft half-circumference the drawn arc measures.
    expect(computeValue('radius3', ON_R100, FT)).toEqual({ value: 50, unit: 'ft' });
  });

  it('measures centre-to-circumference for radiusCenter', () => {
    const pts = [{ vx: 0, vy: 0 }, { vx: 0, vy: 100 }];
    expect(computeValue('radiusCenter', pts, FT)).toEqual({ value: 50, unit: 'ft' });
  });

  it('honours the governing scale, whatever its unit', () => {
    expect(computeValue('radius3', ON_R100, M)).toEqual({ value: 10, unit: 'm' });
  });

  it('yields a null value -- never NaN -- for a degenerate circle', () => {
    const got = computeValue('radius3', COLLINEAR, FT);
    expect(got.value).toBeNull();
    expect(Number.isNaN(got.value)).toBe(false);
  });

  it('yields a null value for a zero-length radius', () => {
    expect(computeValue('radiusCenter', [{ vx: 1, vy: 1 }, { vx: 1, vy: 1 }], FT).value).toBeNull();
  });

  it('reports no value when the page has no scale', () => {
    expect(computeValue('radius3', ON_R100, null)).toEqual({ value: null, unit: null });
    expect(computeValue('radiusCenter', ON_R100, null)).toEqual({ value: null, unit: null });
  });

  it('leaves the existing types untouched', () => {
    const line = [{ vx: 0, vy: 0 }, { vx: 100, vy: 0 }];
    expect(computeValue('length', line, FT)).toEqual({ value: 50, unit: 'ft' });
    expect(computeValue('count', line, FT)).toEqual({ value: 2, unit: 'ct' });
  });
});

describe('fmtMeasure — radius labels', () => {
  // A radius is a distance, so it prints as one -- identical to what Bluebeam
  // shows for the same annotation. The tool name lives on the button and in the
  // measurements panel, not in the value.
  it('formats exactly like a length, with no distinguishing prefix', () => {
    expect(fmtMeasure('radius3', 50, 'ft')).toBe('50.00 ft');
    expect(fmtMeasure('radiusCenter', 12.5, 'm')).toBe('12.50 m');
  });

  it('applies the feet-inches toggle exactly as a length does', () => {
    expect(fmtMeasure('radius3', 50.5, 'ft', { feetInches: true, denom: 16 })).toBe("50'-6\"");
  });

  it('ignores feet-inches for a metric scale', () => {
    expect(fmtMeasure('radiusCenter', 4.25, 'm', { feetInches: true, denom: 16 })).toBe('4.25 m');
  });

  it('is indistinguishable from a length of the same value', () => {
    expect(fmtMeasure('radius3', 50, 'ft')).toBe(fmtMeasure('length', 50, 'ft'));
  });

  it('does not change how the existing types format', () => {
    expect(fmtMeasure('length', 50, 'ft')).toBe('50.00 ft');
    expect(fmtMeasure('area', 12, 'ft')).toBe('12.00 ft²');
    expect(fmtMeasure('angle', 90, '°')).toBe('90.0°');
  });
});

// Arc length is the quantity a linear-feet takeoff of a curved run needs, and
// is deliberately NOT the radius the same three clicks also produce.
describe('computeValue — arcLength', () => {
  const HALF_R100 = [{ vx: 100, vy: 0 }, { vx: 0, vy: 100 }, { vx: -100, vy: 0 }];

  it('measures along the curve, not across to it', () => {
    // Half of a 100pt circle is 100*PI points; at 0.5 ft/pt that is 50*PI ft.
    const got = computeValue('arcLength', HALF_R100, FT);
    expect(got.value).toBeCloseTo(50 * Math.PI, 6);
    expect(got.unit).toBe('ft');
  });

  it('differs from the radius the same three points give', () => {
    const arc = computeValue('arcLength', HALF_R100, FT).value;
    const rad = computeValue('radius3', HALF_R100, FT).value;
    expect(rad).toBeCloseTo(50, 9);
    expect(arc).toBeGreaterThan(rad);
  });

  it('scales a quarter arc correctly', () => {
    const q = [{ vx: 100, vy: 0 }, { vx: 70.710678, vy: 70.710678 }, { vx: 0, vy: 100 }];
    expect(computeValue('arcLength', q, FT).value).toBeCloseTo(25 * Math.PI, 3);
  });

  it('yields a null value — never NaN — for collinear points', () => {
    const got = computeValue('arcLength', COLLINEAR, FT);
    expect(got.value).toBeNull();
    expect(Number.isNaN(got.value)).toBe(false);
  });

  it('reports no value when the page has no scale', () => {
    expect(computeValue('arcLength', HALF_R100, null)).toEqual({ value: null, unit: null });
  });

  it('labels as a plain distance, like any length', () => {
    expect(fmtMeasure('arcLength', 214.05, 'ft')).toBe('214.05 ft');
    expect(fmtMeasure('arcLength', 214.05, 'ft')).toBe(fmtMeasure('length', 214.05, 'ft'));
  });
});
