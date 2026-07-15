'use strict';

/*
 * Saved digital IDs — a small store for the user's PKCS#12 (.p12/.pfx) signing
 * identities, so the digital-signature dialog doesn't ask for the key, the
 * password and the signer's name every single time.
 *
 * Each identity keeps the .p12 bytes (base64), the signer details (name/reason/
 * location) and — only if the user opted in per-identity — the passphrase. It
 * all lives on this device via App.Prefs (localStorage); nothing is uploaded.
 * The dialog is single-user and offline, but the password is genuinely
 * sensitive, so "also save the password" is an explicit, per-identity choice:
 * leave it off and the identity is remembered while the password is still
 * asked for at signing time.
 *
 * Shape persisted under the `digitalIds` pref:
 *   { items: [ Identity, ... ], activeId: string | null }
 *   Identity = { id, label, fileName, p12, savePass, pass, name, reason, location }
 *
 * A one-time migration folds the previous single-preset shape (`digitalId`)
 * into the list, so nobody loses a remembered ID on upgrade.
 *
 * Dual export: Node `require()` returns { createDigitalIdStore } for unit tests;
 * in the browser App.DigitalIds is a ready instance bound to App.Prefs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.App = root.App || {};
    root.App.createDigitalIdStore = api.createDigitalIdStore;
    // Bind an instance to the shared Prefs store (prefs.js loads first).
    if (root.App.Prefs) root.App.DigitalIds = api.createDigitalIdStore(root.App.Prefs);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'digitalIds';        // { items: [...], activeId }
  const LEGACY_KEY = 'digitalId';  // old single-preset shape

  // Unique enough for a local, single-user identity list; overridable in tests.
  function defaultGenId() {
    return 'id-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }

  // Coerce any partial profile into a full, storage-safe Identity. Enforces the
  // security rule that the password is only kept when savePass is set.
  function normalize(p, genId) {
    const savePass = !!p.savePass;
    const label = String(p.label || '').trim();
    return {
      id: p.id || genId(),
      label: label || p.fileName || p.name || 'Digital ID',
      fileName: p.fileName || '',
      p12: p.p12 || '',
      savePass: savePass,
      pass: savePass ? (p.pass || '') : '',
      name: p.name || '',
      reason: p.reason || '',
      location: p.location || ''
    };
  }

  function createDigitalIdStore(prefs, opts) {
    const genId = (opts && opts.genId) || defaultGenId;

    function readState() {
      const s = prefs.get(KEY, null);
      if (s && Array.isArray(s.items)) return { items: s.items.slice(), activeId: s.activeId || null };
      return { items: [], activeId: null };
    }
    function writeState(state) {
      prefs.set(KEY, { items: state.items, activeId: state.activeId });
      return state;
    }

    // Fold the legacy single preset into the list, once. Cleared afterwards so
    // this is idempotent (later calls find no legacy and no-op).
    function migrate() {
      const legacy = prefs.get(LEGACY_KEY, null);
      if (!legacy) return;
      if (legacy.p12) {
        const state = readState();
        const item = normalize({
          label: legacy.fileName || legacy.name || 'Saved digital ID',
          fileName: legacy.fileName || 'digital ID',
          p12: legacy.p12,
          savePass: !!legacy.pass,
          pass: legacy.pass || '',
          name: legacy.name || '',
          reason: legacy.reason || '',
          location: legacy.location || ''
        }, genId);
        state.items.unshift(item);
        if (!state.activeId) state.activeId = item.id;
        writeState(state);
      }
      prefs.set(LEGACY_KEY, null); // consumed
    }

    return {
      // All saved identities (never null).
      list() { migrate(); return readState().items.slice(); },
      // A single identity by id, or null.
      get(id) { migrate(); return readState().items.find((it) => it.id === id) || null; },
      // The id of the active identity (may be null when the list is empty).
      activeId() { migrate(); const s = readState(); return s.activeId || (s.items[0] && s.items[0].id) || null; },
      // The active identity object, falling back to the first, or null.
      active() {
        migrate();
        const s = readState();
        return s.items.find((it) => it.id === s.activeId) || s.items[0] || null;
      },
      // Insert or update an identity; the saved one becomes active. Returns it.
      save(profile) {
        migrate();
        const state = readState();
        const item = normalize(profile, genId);
        const idx = state.items.findIndex((it) => it.id === item.id);
        if (idx >= 0) state.items[idx] = item; else state.items.push(item);
        state.activeId = item.id;
        writeState(state);
        return item;
      },
      // Delete an identity; if it was active, the first remaining one takes over.
      remove(id) {
        migrate();
        const state = readState();
        state.items = state.items.filter((it) => it.id !== id);
        if (state.activeId === id) state.activeId = state.items.length ? state.items[0].id : null;
        writeState(state);
        return state.items.slice();
      },
      // Mark an existing identity active (no-op for an unknown id).
      setActive(id) {
        migrate();
        const state = readState();
        if (state.items.some((it) => it.id === id)) { state.activeId = id; writeState(state); }
        return readState().activeId;
      },
      // Wipe every saved identity (and any un-migrated legacy preset).
      clear() { prefs.set(KEY, { items: [], activeId: null }); prefs.set(LEGACY_KEY, null); }
    };
  }

  return { createDigitalIdStore };
});
