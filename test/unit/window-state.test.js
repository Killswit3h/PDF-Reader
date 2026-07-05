import { describe, it, expect } from 'vitest';
import { sanitizeBounds, DEFAULTS, MIN } from '../../src/shared/window-state.js';

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };

describe('sanitizeBounds', () => {
  it('centres a default-sized window when nothing is saved', () => {
    const b = sanitizeBounds(null, AREA);
    expect(b.width).toBe(DEFAULTS.width);
    expect(b.height).toBe(DEFAULTS.height);
    expect(b.x).toBe(Math.round((AREA.width - DEFAULTS.width) / 2));
    expect(b.y).toBe(Math.round((AREA.height - DEFAULTS.height) / 2));
  });

  it('preserves valid saved bounds', () => {
    const saved = { x: 100, y: 80, width: 1000, height: 700 };
    expect(sanitizeBounds(saved, AREA)).toEqual(saved);
  });

  it('clamps a window larger than the work area', () => {
    const b = sanitizeBounds({ x: 0, y: 0, width: 5000, height: 5000 }, AREA);
    expect(b.width).toBe(AREA.width);
    expect(b.height).toBe(AREA.height);
  });

  it('enforces the app minimum size', () => {
    const b = sanitizeBounds({ x: 10, y: 10, width: 100, height: 100 }, AREA);
    expect(b.width).toBe(MIN.width);
    expect(b.height).toBe(MIN.height);
  });

  it('nudges an off-screen window back onto the work area', () => {
    // Saved on a monitor to the right that is no longer connected.
    const b = sanitizeBounds({ x: 3000, y: 2000, width: 1000, height: 700 }, AREA);
    expect(b.x).toBe(AREA.width - 1000);
    expect(b.y).toBe(AREA.height - 700);
    expect(b.x).toBeGreaterThanOrEqual(AREA.x);
    expect(b.y).toBeGreaterThanOrEqual(AREA.y);
  });

  it('honors a non-zero work-area origin (taskbar / second display)', () => {
    const area = { x: 1920, y: 40, width: 1280, height: 1000 };
    const b = sanitizeBounds(null, area);
    expect(b.x).toBeGreaterThanOrEqual(area.x);
    expect(b.y).toBeGreaterThanOrEqual(area.y);
  });

  it('falls back to defaults on garbage input', () => {
    const b = sanitizeBounds({ x: 'nope', y: NaN, width: null, height: undefined }, AREA);
    expect(b.width).toBe(DEFAULTS.width);
    expect(b.height).toBe(DEFAULTS.height);
  });
});
