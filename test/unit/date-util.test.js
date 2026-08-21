import { describe, it, expect } from 'vitest';
import { todayFormatted, pdfDateString } from '../../src/shared/date-util.js';

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

// /CreationDate and /M on exported annotations use this. Bluebeam and Acrobat
// parse it strictly: a malformed string shows as a blank date, not an error.
describe('pdfDateString', () => {
  it('formats D:YYYYMMDDHHmmSS with a timezone suffix', () => {
    const s = pdfDateString(new Date(2026, 7, 21, 6, 5, 4));
    expect(s).toMatch(/^D:20260821060504(Z00'00'|[+-]\d{2}'\d{2}')$/);
  });

  it('zero-pads every field', () => {
    const s = pdfDateString(new Date(2026, 0, 2, 3, 4, 5));
    expect(s.slice(0, 16)).toBe('D:20260102030405');
  });

  it('keeps a four-digit year and a 24-hour clock', () => {
    const s = pdfDateString(new Date(2026, 11, 31, 23, 59, 59));
    expect(s.slice(0, 16)).toBe('D:20261231235959');
  });

  it('emits a well-formed offset the spec accepts', () => {
    const tz = pdfDateString(new Date(2026, 5, 1, 12, 0, 0)).slice(16);
    expect(tz).toMatch(/^(Z00'00'|[+-]\d{2}'\d{2}')$/);
  });

  it('defaults to now when called with no argument', () => {
    expect(pdfDateString()).toMatch(/^D:\d{14}(Z00'00'|[+-]\d{2}'\d{2}')$/);
  });
});
