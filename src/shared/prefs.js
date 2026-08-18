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
    root.App.Prefs = api.createPrefs(store, function () {
      // App.toast may not exist yet if a preference is written during boot.
      if (root.App && typeof root.App.toast === 'function') {
        root.App.toast('Settings can\u2019t be saved on this device — your preferences won\u2019t be remembered next time.', 'error');
      }
    });
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

  // createPrefs(storage, onWriteError) — onWriteError is called at most once per
  // session, the first time a write fails. Every caller in the app wraps
  // Prefs.set in its own empty catch "for quota", which meant a full or blocked
  // localStorage silently stopped remembering the user's theme, their drawn
  // signature and their tool settings, forever, with nothing said. Reporting it
  // once centrally beats fourteen call sites each staying quiet — and beats
  // reporting it on every keystroke.
  function createPrefs(storage, onWriteError) {
    let warned = false;
    function readAll() {
      try { return JSON.parse(storage.getItem(KEY)) || {}; } catch (_) { return {}; }
    }
    function writeAll(obj) {
      try {
        storage.setItem(KEY, JSON.stringify(obj));
        return true;
      } catch (e) {
        if (!warned) {
          warned = true;
          if (typeof onWriteError === 'function') { try { onWriteError(e); } catch (_) { /* never throw from here */ } }
        }
        return false;
      }
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
      // True when the last write attempt succeeded; lets callers that care
      // (Settings, in a later track) show inline state instead of a toast.
      canPersist() { return writeAll(readAll()); },
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
