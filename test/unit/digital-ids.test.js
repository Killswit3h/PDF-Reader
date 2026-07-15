import { describe, it, expect, beforeEach } from 'vitest';
import prefsApi from '../../src/shared/prefs.js';
import idsApi from '../../src/shared/digital-ids.js';

const { createPrefs, memoryStore } = prefsApi;
const { createDigitalIdStore } = idsApi;

// Deterministic id generator so assertions don't depend on Date/Math.random.
function seqGen() {
  let n = 0;
  return () => 'id-' + (++n);
}

function newStore() {
  const prefs = createPrefs(memoryStore());
  const store = createDigitalIdStore(prefs, { genId: seqGen() });
  return { prefs, store };
}

const sample = (over = {}) => Object.assign({
  label: 'Work ID', fileName: 'work.p12', p12: 'AAA=',
  savePass: true, pass: 'secret', name: 'Jane Doe', reason: 'Approve', location: 'NYC'
}, over);

describe('digital-ids store', () => {
  let store;
  beforeEach(() => { store = newStore().store; });

  it('starts empty', () => {
    expect(store.list()).toEqual([]);
    expect(store.active()).toBeNull();
    expect(store.activeId()).toBeNull();
  });

  it('saves an identity, assigns an id, and makes it active', () => {
    const saved = store.save(sample());
    expect(saved.id).toBe('id-1');
    expect(store.list()).toHaveLength(1);
    expect(store.active().id).toBe('id-1');
    expect(store.get('id-1').name).toBe('Jane Doe');
  });

  it('keeps the password only when savePass is true', () => {
    const withPass = store.save(sample({ savePass: true, pass: 'secret' }));
    expect(withPass.pass).toBe('secret');
    const noPass = store.save(sample({ label: 'No-save', savePass: false, pass: 'secret' }));
    expect(noPass.savePass).toBe(false);
    expect(noPass.pass).toBe('');
  });

  it('derives a label from fileName or name when none is given', () => {
    const a = store.save(sample({ label: '', fileName: 'my.p12', name: '' }));
    expect(a.label).toBe('my.p12');
    const b = store.save(sample({ label: '', fileName: '', name: 'Bob' }));
    expect(b.label).toBe('Bob');
  });

  it('updates in place when saving with an existing id', () => {
    const a = store.save(sample());
    store.save(Object.assign({}, sample({ name: 'Jane R. Doe' }), { id: a.id }));
    expect(store.list()).toHaveLength(1);
    expect(store.get(a.id).name).toBe('Jane R. Doe');
  });

  it('removes an identity and reassigns active to the first remaining', () => {
    const a = store.save(sample({ label: 'A' }));
    const b = store.save(sample({ label: 'B' }));
    expect(store.activeId()).toBe(b.id);
    store.remove(b.id);
    expect(store.list()).toHaveLength(1);
    expect(store.activeId()).toBe(a.id);
    store.remove(a.id);
    expect(store.list()).toEqual([]);
    expect(store.activeId()).toBeNull();
  });

  it('setActive switches identities but ignores unknown ids', () => {
    const a = store.save(sample({ label: 'A' }));
    const b = store.save(sample({ label: 'B' }));
    expect(store.setActive(a.id)).toBe(a.id);
    expect(store.active().id).toBe(a.id);
    expect(store.setActive('nope')).toBe(a.id); // unchanged
  });

  it('active() falls back to the first item when no explicit active is set', () => {
    const prefs = createPrefs(memoryStore());
    // Seed a list with a stale/null activeId directly.
    prefs.set('digitalIds', { items: [{ id: 'x', label: 'X', p12: 'AAA=', savePass: false, pass: '', name: '', reason: '', location: '', fileName: '' }], activeId: null });
    const s = createDigitalIdStore(prefs, { genId: seqGen() });
    expect(s.active().id).toBe('x');
    expect(s.activeId()).toBe('x');
  });

  it('clear() wipes everything', () => {
    store.save(sample());
    store.clear();
    expect(store.list()).toEqual([]);
  });
});

describe('digital-ids migration from the legacy single preset', () => {
  it('folds the old `digitalId` preset into the list, once, and consumes it', () => {
    const prefs = createPrefs(memoryStore());
    prefs.set('digitalId', {
      p12: 'QkJC', pass: 'pw', name: 'Old Name', reason: 'r', location: 'l', fileName: 'old.p12'
    });
    const store = createDigitalIdStore(prefs, { genId: seqGen() });

    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0].p12).toBe('QkJC');
    expect(items[0].name).toBe('Old Name');
    expect(items[0].savePass).toBe(true);
    expect(items[0].pass).toBe('pw');
    expect(store.activeId()).toBe(items[0].id);

    // Legacy key is consumed, so a later call doesn't duplicate it.
    expect(prefs.get('digitalId', null)).toBeNull();
    store.save(sample({ label: 'Second' }));
    expect(store.list()).toHaveLength(2);
  });

  it('migrates a legacy preset that never saved a password (savePass false)', () => {
    const prefs = createPrefs(memoryStore());
    prefs.set('digitalId', { p12: 'QkJC', name: 'No Pass', fileName: 'np.p12' });
    const store = createDigitalIdStore(prefs, { genId: seqGen() });
    const it = store.list()[0];
    expect(it.savePass).toBe(false);
    expect(it.pass).toBe('');
  });

  it('ignores an empty/invalid legacy preset', () => {
    const prefs = createPrefs(memoryStore());
    prefs.set('digitalId', { name: 'no key here' });
    const store = createDigitalIdStore(prefs, { genId: seqGen() });
    expect(store.list()).toEqual([]);
    expect(prefs.get('digitalId', null)).toBeNull();
  });
});
