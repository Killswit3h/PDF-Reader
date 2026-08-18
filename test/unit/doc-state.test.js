import { describe, it, expect } from 'vitest';
import docState from '../../src/shared/doc-state.js';

const { makeDocKey, readDocState, writeDocState, LIMIT } = docState;

describe('makeDocKey', () => {
  it('prefers the file path, which is stable on desktop', () => {
    expect(makeDocKey({ path: '/plans/A.pdf', name: 'A.pdf' })).toBe('p:/plans/A.pdf');
  });
  it('falls back to name + size where paths are opaque (Android)', () => {
    expect(makeDocKey({ name: 'A.pdf', size: 1234 })).toBe('n:A.pdf:1234');
  });
  it('returns null when there is nothing stable to key on', () => {
    expect(makeDocKey(null)).toBe(null);
    expect(makeDocKey({})).toBe(null);
  });
  it('does not collide between different files of the same name and size', () => {
    expect(makeDocKey({ path: '/a/A.pdf' })).not.toBe(makeDocKey({ path: '/b/A.pdf' }));
  });
});

describe('readDocState', () => {
  it('reads back what was written', () => {
    const m = writeDocState({}, 'k', { page: 7, scale: 1.5 }, 1);
    expect(readDocState(m, 'k')).toEqual({ page: 7, scale: 1.5 });
  });
  it('keeps named zoom modes as strings', () => {
    const m = writeDocState({}, 'k', { scale: 'page-width' }, 1);
    expect(readDocState(m, 'k').scale).toBe('page-width');
  });
  it('returns null for an unknown key', () => {
    expect(readDocState({}, 'nope')).toBe(null);
  });
  it('returns null rather than throwing on a corrupt entry', () => {
    expect(readDocState({ k: 'not an object' }, 'k')).toBe(null);
    expect(readDocState({ k: null }, 'k')).toBe(null);
    expect(readDocState(null, 'k')).toBe(null);
  });
  // A corrupt entry must never restore nonsense — page 0 or a negative zoom
  // would leave the viewer in a state the user cannot get out of.
  it('drops out-of-range values instead of restoring them', () => {
    expect(readDocState({ k: { page: 0, scale: -2 } }, 'k')).toBe(null);
    expect(readDocState({ k: { page: NaN } }, 'k')).toBe(null);
  });
  it('floors a fractional page', () => {
    expect(readDocState({ k: { page: 3.7 } }, 'k').page).toEqual(3);
  });
});

describe('writeDocState', () => {
  it('merges rather than replacing', () => {
    let m = writeDocState({}, 'k', { page: 4 }, 1);
    m = writeDocState(m, 'k', { scale: 2 }, 2);
    expect(readDocState(m, 'k')).toEqual({ page: 4, scale: 2 });
  });
  it('does not mutate the map it was given', () => {
    const before = {};
    writeDocState(before, 'k', { page: 2 }, 1);
    expect(before).toEqual({});
  });
  it('carries per-document scale calibration', () => {
    const scales = { 1: { factor: 0.25, unit: 'ft' } };
    const m = writeDocState({}, 'k', { scales }, 1);
    expect(readDocState(m, 'k').scales).toEqual(scales);
  });
  it('is a no-op without a key', () => {
    expect(writeDocState({ a: { at: 1 } }, null, { page: 2 }, 2)).toEqual({ a: { at: 1 } });
  });
  it('tolerates a corrupt starting map', () => {
    expect(() => writeDocState('garbage', 'k', { page: 1 }, 1)).not.toThrow();
    expect(readDocState(writeDocState(null, 'k', { page: 1 }, 1), 'k')).toEqual({ page: 1 });
  });

  // Bounded on purpose: localStorage is finite and a field user opens a lot of
  // drawings. An unbounded map would grow until writes began failing.
  it(`evicts the least recently used past ${LIMIT} documents`, () => {
    let m = {};
    for (let i = 0; i < LIMIT + 10; i++) m = writeDocState(m, 'k' + i, { page: i + 1 }, i + 1);
    expect(Object.keys(m).length).toBe(LIMIT);
    expect(readDocState(m, 'k0')).toBe(null);          // oldest gone
    expect(readDocState(m, 'k' + (LIMIT + 9))).toEqual({ page: LIMIT + 10 }); // newest kept
  });
  it('keeps a document that was touched recently over an older one', () => {
    let m = {};
    for (let i = 0; i < LIMIT; i++) m = writeDocState(m, 'k' + i, { page: 1 }, i + 1);
    m = writeDocState(m, 'k0', { page: 9 }, 10000);    // re-open the oldest
    m = writeDocState(m, 'new', { page: 1 }, 10001);   // force one eviction
    expect(readDocState(m, 'k0')).toEqual({ page: 9 });
    expect(readDocState(m, 'k1')).toBe(null);          // next-oldest evicted instead
  });
});
