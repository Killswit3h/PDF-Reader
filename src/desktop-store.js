'use strict';

/*
 * Tiny JSON-backed store for desktop-only UI state: the last window bounds +
 * maximized flag, and the recent-files list. Lives in the Electron main process
 * (uses fs + app.getPath('userData')); the pure list/bounds arithmetic it
 * relies on is in src/shared/{recent-files,window-state}.js and unit-tested.
 *
 * Writes are debounced so a burst of resize/move events doesn't hammer the disk.
 * All reads/writes are best-effort — a corrupt or unwritable file degrades to
 * in-memory defaults rather than crashing the app.
 */

const fs = require('fs');
const path = require('path');

function createStore(userDataDir) {
  const file = path.join(userDataDir, 'desktop-state.json');
  let state = { bounds: null, maximized: false, recent: [] };
  let writeTimer = null;

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state = {
        bounds: parsed.bounds && typeof parsed.bounds === 'object' ? parsed.bounds : null,
        maximized: !!parsed.maximized,
        recent: Array.isArray(parsed.recent) ? parsed.recent : []
      };
    }
  } catch (_) { /* first run or unreadable — keep defaults */ }

  function flush() {
    writeTimer = null;
    try {
      fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    } catch (_) { /* disk full / read-only — ignore */ }
  }

  function scheduleWrite() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 400);
  }

  return {
    get: () => state,
    getRecent: () => state.recent.slice(),
    setBounds(bounds, maximized) {
      state.bounds = bounds || state.bounds;
      state.maximized = !!maximized;
      scheduleWrite();
    },
    setRecent(list) {
      state.recent = Array.isArray(list) ? list : [];
      scheduleWrite();
    },
    // Write immediately (used on quit, where a debounced write could be lost).
    flushNow() {
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      flush();
    }
  };
}

module.exports = { createStore };
