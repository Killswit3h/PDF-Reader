'use strict';

/*
 * User preferences, persisted as one JSON blob in localStorage. Survives across
 * app restarts: theme, markup style defaults, the save-as-annotations toggle,
 * snapping, last zoom mode, etc.
 *
 * `createPrefs(storage)` takes any { getItem, setItem } store, so unit tests
 * inject a fake and the browser injects window.localStorage. Dual export:
 *   Node  → require() returns { createPrefs, memoryStore }
 *   browser → App.Prefs is a ready instance bound to localStorage.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.App = root.App || {};
    const store = (typeof localStorage !== 'undefined') ? localStorage : api.memoryStore();
    root.App.Prefs = api.createPrefs(store);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'pdfsigner.prefs.v1';

  // In-memory fallback with the localStorage shape (used if storage is absent).
  function memoryStore() {
    const m = Object.create(null);
    return {
      getItem: (k) => (k in m ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: (k) => { delete m[k]; }
    };
  }

  function createPrefs(storage) {
    function readAll() {
      try { return JSON.parse(storage.getItem(KEY)) || {}; } catch (_) { return {}; }
    }
    function writeAll(obj) {
      try { storage.setItem(KEY, JSON.stringify(obj)); } catch (_) { /* quota/denied: ignore */ }
    }
    return {
      // Value for `key`, or `fallback` when unset.
      get(key, fallback) {
        const all = readAll();
        return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
      },
      // Persist `key` = `value`; returns value for chaining.
      set(key, value) {
        const all = readAll();
        all[key] = value;
        writeAll(all);
        return value;
      },
      // Merge a patch of several keys at once.
      merge(patch) {
        const all = readAll();
        Object.assign(all, patch);
        writeAll(all);
        return all;
      },
      all() { return readAll(); },
      clear() { writeAll({}); }
    };
  }

  return { createPrefs, memoryStore };
});
