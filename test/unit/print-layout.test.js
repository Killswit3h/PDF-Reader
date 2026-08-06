import { describe, it, expect } from 'vitest';
import { isLandscape, orientationForSizes } from '../../src/shared/print-layout.js';

describe('isLandscape', () => {
  it('is true for a wider-than-tall sheet (tabloid 17x11)', () => {
    expect(isLandscape(1224, 792)).toBe(true);
  });
  it('is false for a taller-than-wide sheet (letter 8.5x11)', () => {
    expect(isLandscape(612, 792)).toBe(false);
  });
  it('treats a square-ish page as portrait (within tolerance)', () => {
    expect(isLandscape(800, 792)).toBe(false);
  });
  it('flips to landscape once clearly wider than the tolerance', () => {
    expect(isLandscape(820, 792)).toBe(true);
  });
  it('is false for degenerate / zero sizes', () => {
    expect(isLandscape(0, 100)).toBe(false);
    expect(isLandscape(100, 0)).toBe(false);
    expect(isLandscape(NaN, NaN)).toBe(false);
  });
});

describe('orientationForSizes', () => {
  it('requests landscape for a single wide plan sheet', () => {
    expect(orientationForSizes([{ width: 1224, height: 792 }])).toEqual({ landscape: true });
  });
  it('requests portrait for a single tall page', () => {
    expect(orientationForSizes([{ width: 612, height: 792 }])).toEqual({ landscape: false });
  });
  it('follows the majority across mixed pages', () => {
    const sizes = [
      { width: 1224, height: 792 }, // landscape
      { width: 1224, height: 792 }, // landscape
      { width: 612, height: 792 },  // portrait
    ];
    expect(orientationForSizes(sizes)).toEqual({ landscape: true });
  });
  it('stays portrait when portrait pages are the majority', () => {
    const sizes = [
      { width: 1224, height: 792 }, // landscape
      { width: 612, height: 792 },  // portrait
      { width: 612, height: 792 },  // portrait
    ];
    expect(orientationForSizes(sizes)).toEqual({ landscape: false });
  });
  it('breaks a tie in favour of landscape (wide sheets need it most)', () => {
    const sizes = [
      { width: 1224, height: 792 }, // landscape
      { width: 612, height: 792 },  // portrait
    ];
    expect(orientationForSizes(sizes)).toEqual({ landscape: true });
  });
  it('defaults to portrait for an empty or invalid set', () => {
    expect(orientationForSizes([])).toEqual({ landscape: false });
    expect(orientationForSizes(null)).toEqual({ landscape: false });
  });
});
