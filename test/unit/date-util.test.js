import { describe, it, expect } from 'vitest';
import { todayFormatted } from '../../src/shared/date-util.js';

describe('todayFormatted', () => {
  it('formats MM/DD/YYYY with zero padding', () => {
    expect(todayFormatted(new Date(2026, 0, 5))).toBe('01/05/2026');
  });
  it('formats a two-digit month/day without padding artifacts', () => {
    expect(todayFormatted(new Date(2026, 11, 25))).toBe('12/25/2026');
  });
  it('returns a MM/DD/YYYY shaped string for "now"', () => {
    expect(todayFormatted()).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});
