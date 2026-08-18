'use strict';

/*
 * Per-document view state: where you were in a file, so reopening it puts you
 * back. Zoom and page were previously reset on every open and survived only a
 * tab switch, so relaunching the app dropped a 200-page plan set back to page 1
 * at fit-width.
 *
 * Stored as one bounded map inside the existing prefs blob. Bounded matters:
 * localStorage is a few megabytes and a field user opens a lot of drawings, so
 * an unbounded map would grow until writes started failing — which is exactly
 * the silent-failure class Track C just fixed.
 *
 * Keying: file path on desktop, where it is stable and unique. Android hands
 * back opaque content:// URIs that change between pickers, so there we fall
 * back to name + size, which is stable enough to be useful and cheap to compute.
 *
 * Pure logic with no storage or DOM access, so it is unit-tested directly.
 *   Node    -> require() returns { makeDocKey, readDocState, writeDocState, LIMIT }
 *   browser -> App.DocState
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.App = root.App || {};
    root.App.DocState = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // How many documents to remember. Each entry is tiny (~60 bytes), so this is
  // about keeping the blob obviously bounded rather than about bytes.
  const LIMIT = 50;

  // A stable identifier for a document. Returns null when there is nothing
  // stable to key on, and callers then simply do not persist — better than
  // keying on something that collides between different files.
  function makeDocKey(info) {
    if (!info) return null;
    if (info.path) return 'p:' + info.path;
    if (info.name) return 'n:' + info.name + ':' + (info.size == null ? '' : info.size);
    return null;
  }

  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

  // Pull one document's state out of the map. Anything malformed reads as "no
  // saved state" rather than throwing or restoring nonsense — a corrupt entry
  // must never stop a document from opening.
  function readDocState(map, key) {
    if (!map || !key) return null;
    const e = map[key];
    if (!e || typeof e !== 'object') return null;
    const out = {};
    if (isFiniteNum(e.page) && e.page >= 1) out.page = Math.floor(e.page);
    if (isFiniteNum(e.scale) && e.scale > 0) out.scale = e.scale;
    else if (typeof e.scale === 'string' && e.scale) out.scale = e.scale;  // 'page-width' etc.
    if (e.scales && typeof e.scales === 'object') out.scales = e.scales;
    return Object.keys(out).length ? out : null;
  }

  // Merge `patch` into `key`'s entry and return a NEW map, evicting the least
  // recently touched entries past LIMIT. `at` is supplied by the caller (a
  // timestamp) so this stays pure and testable.
  function writeDocState(map, key, patch, at) {
    const base = (map && typeof map === 'object') ? map : {};
    if (!key || !patch) return base;
    const next = {};
    for (const k of Object.keys(base)) {
      if (base[k] && typeof base[k] === 'object') next[k] = base[k];
    }
    const prev = next[key] || {};
    const merged = { at: isFiniteNum(at) ? at : (isFiniteNum(prev.at) ? prev.at : 0) };
    if (isFiniteNum(patch.page) && patch.page >= 1) merged.page = Math.floor(patch.page);
    else if (isFiniteNum(prev.page)) merged.page = prev.page;
    if (patch.scale != null && patch.scale !== '') merged.scale = patch.scale;
    else if (prev.scale != null) merged.scale = prev.scale;
    if (patch.scales && typeof patch.scales === 'object') merged.scales = patch.scales;
    else if (prev.scales) merged.scales = prev.scales;
    next[key] = merged;

    const keys = Object.keys(next);
    if (keys.length > LIMIT) {
      // Oldest `at` first; ties keep insertion order, which is deterministic.
      keys.sort((a, b) => (next[a].at || 0) - (next[b].at || 0));
      for (const k of keys.slice(0, keys.length - LIMIT)) delete next[k];
    }
    return next;
  }

  return { makeDocKey, readDocState, writeDocState, LIMIT };
});
