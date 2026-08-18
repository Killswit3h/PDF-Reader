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

  // A full or blocked localStorage used to fail silently at every call site, so
  // the app simply stopped remembering anything with nothing said.
  describe('write failures', () => {
    function failingStore() {
      const inner = memoryStore();
      return {
        getItem: inner.getItem,
        removeItem: inner.removeItem,
        setItem: () => { throw new Error('QuotaExceededError'); }
      };
    }

    it('reports the first write failure', () => {
      let calls = 0;
      const p = createPrefs(failingStore(), () => { calls++; });
      p.set('theme', 'light');
      expect(calls).toBe(1);
    });

    it('reports it only once per session, however many writes fail', () => {
      let calls = 0;
      const p = createPrefs(failingStore(), () => { calls++; });
      p.set('theme', 'light');
      p.set('snap', true);
      p.merge({ a: 1, b: 2 });
      expect(calls).toBe(1);
    });

    it('still does not throw when a write fails', () => {
      const p = createPrefs(failingStore(), () => {});
      expect(() => p.set('theme', 'light')).not.toThrow();
      expect(p.set('theme', 'light')).toBe('light');
    });

    it('tolerates a handler that itself throws', () => {
      const p = createPrefs(failingStore(), () => { throw new Error('handler blew up'); });
      expect(() => p.set('theme', 'light')).not.toThrow();
    });

    it('works with no handler supplied at all', () => {
      const p = createPrefs(failingStore());
      expect(() => p.set('theme', 'light')).not.toThrow();
    });

    it('canPersist reflects whether the store accepts writes', () => {
      expect(createPrefs(memoryStore()).canPersist()).toBe(true);
      expect(createPrefs(failingStore(), () => {}).canPersist()).toBe(false);
    });
  });
});
