import { describe, it, expect } from 'vitest';
import { addRotation, normalizeRotation } from '../../src/shared/rotation.js';

describe('normalizeRotation', () => {
  it('passes the four legal values through', () => {
    for (const d of [0, 90, 180, 270]) expect(normalizeRotation(d)).toBe(d);
  });

  it('wraps past a full turn', () => {
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(720)).toBe(0);
  });

  it('brings a negative rotation back into range', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-180)).toBe(180);
    expect(normalizeRotation(-450)).toBe(270);
  });

  // Files in the wild are not always spec-compliant. A reader rounds to the
  // nearest quarter turn rather than rejecting the page; a NaN reaching the
  // saved file would be far worse than a page a degree off.
  it('rounds an off-spec rotation to the nearest quarter turn', () => {
    expect(normalizeRotation(89)).toBe(90);
    expect(normalizeRotation(91)).toBe(90);
    expect(normalizeRotation(44)).toBe(0);
    expect(normalizeRotation(46)).toBe(90);
  });

  it('treats missing or nonsense input as unrotated', () => {
    expect(normalizeRotation(undefined)).toBe(0);
    expect(normalizeRotation(null)).toBe(0);
    expect(normalizeRotation(NaN)).toBe(0);
    expect(normalizeRotation('not a number')).toBe(0);
  });

  it('never returns a value a PDF reader would reject', () => {
    for (let d = -720; d <= 720; d += 7) {
      expect([0, 90, 180, 270]).toContain(normalizeRotation(d));
    }
  });
});

describe('addRotation', () => {
  it('applies the view rotation to an unrotated page', () => {
    expect(addRotation(0, 90)).toBe(90);
    expect(addRotation(0, 180)).toBe(180);
    expect(addRotation(0, 270)).toBe(270);
  });

  // The point of adding rather than replacing: a set can arrive with its sheets
  // at different orientations, and replacing would flatten them into one.
  it('adds to the rotation a page already carried', () => {
    expect(addRotation(90, 90)).toBe(180);
    expect(addRotation(180, 90)).toBe(270);
    expect(addRotation(270, 90)).toBe(0);
    expect(addRotation(90, 270)).toBe(0);
  });

  it('keeps two differently-rotated pages different', () => {
    const view = 90;
    expect(addRotation(0, view)).not.toBe(addRotation(90, view));
  });

  it('is a no-op when the view is not rotated', () => {
    for (const page of [0, 90, 180, 270]) expect(addRotation(page, 0)).toBe(page);
  });

  // FR-8: the change is undone by the action that made it.
  it('returns a page to its original rotation when turned the rest of the way', () => {
    for (const page of [0, 90, 180, 270]) {
      const saved = addRotation(page, 90);
      expect(addRotation(saved, 270)).toBe(page);
    }
  });

  it('tolerates missing values on either side', () => {
    expect(addRotation(undefined, 90)).toBe(90);
    expect(addRotation(90, undefined)).toBe(90);
    expect(addRotation(undefined, undefined)).toBe(0);
  });
});
