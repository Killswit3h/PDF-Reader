import { describe, it, expect, beforeEach } from 'vitest';
import prefsApi from '../../src/shared/prefs.js';

const { createPrefs, memoryStore } = prefsApi;

describe('Prefs', () => {
  let prefs;
  beforeEach(() => { prefs = createPrefs(memoryStore()); });

  it('returns the fallback when a key is unset', () => {
    expect(prefs.get('theme', 'dark')).toBe('dark');
  });
  it('persists and reads back a value', () => {
    prefs.set('theme', 'light');
    expect(prefs.get('theme', 'dark')).toBe('light');
  });
  it('distinguishes a stored falsy value from unset', () => {
    prefs.set('snap', false);
    expect(prefs.get('snap', true)).toBe(false);
  });
  it('round-trips an object value (markup style defaults)', () => {
    const style = { stroke: '#ff0000', width: 3, opacity: 0.5 };
    prefs.set('annoStyle', style);
    expect(prefs.get('annoStyle')).toEqual(style);
  });
  it('merges a patch of multiple keys', () => {
    prefs.merge({ a: 1, b: 2 });
    expect(prefs.all()).toEqual({ a: 1, b: 2 });
  });
  it('clears everything', () => {
    prefs.set('x', 1);
    prefs.clear();
    expect(prefs.all()).toEqual({});
  });
  it('survives corrupt storage without throwing', () => {
    const store = memoryStore();
    store.setItem('pdfsigner.prefs.v1', '{not valid json');
    const p = createPrefs(store);
    expect(p.get('theme', 'dark')).toBe('dark');
    expect(() => p.set('theme', 'light')).not.toThrow();
  });
  it('shares state across instances on the same store', () => {
    const store = memoryStore();
    createPrefs(store).set('theme', 'light');
    expect(createPrefs(store).get('theme')).toBe('light');
  });
});
