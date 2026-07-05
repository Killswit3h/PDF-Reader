'use strict';

/*
 * Pure recent-files list logic (no fs, no Electron). The desktop main process
 * (`src/main.js`) persists the list to disk and feeds it to the native menu +
 * `app.addRecentDocument`, but all the list arithmetic — most-recent-first
 * order, de-duplication by path, and the cap — lives here so it can be
 * unit-tested directly in Node. Each entry is `{ path, name }`.
 */

const MAX_RECENT = 10;

// Return a new list with `entry` promoted to the front, any prior occurrence of
// the same path removed, and the whole thing capped at `max`. Entries without a
// usable path are ignored (web picks have no durable path — desktop only).
function addRecent(list, entry, max) {
  const cap = typeof max === 'number' ? max : MAX_RECENT;
  const path = entry && entry.path;
  if (!path) return Array.isArray(list) ? list.slice(0, cap) : [];
  const name = (entry && entry.name) || path.split(/[\\/]/).pop() || path;
  const rest = (Array.isArray(list) ? list : []).filter((e) => e && e.path !== path);
  return [{ path, name }, ...rest].slice(0, cap);
}

// Drop a single path (e.g. a file that no longer exists on disk).
function removeRecent(list, path) {
  return (Array.isArray(list) ? list : []).filter((e) => e && e.path !== path);
}

// Keep only entries whose path still passes `existsFn` (injectable for tests).
function pruneRecent(list, existsFn) {
  const exists = typeof existsFn === 'function' ? existsFn : () => true;
  return (Array.isArray(list) ? list : []).filter((e) => e && e.path && exists(e.path));
}

module.exports = { addRecent, removeRecent, pruneRecent, MAX_RECENT };
