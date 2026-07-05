'use strict';

/*
 * Pure window-bounds sanitizer (no Electron). `src/main.js` reads the saved
 * bounds from disk and the current work area from the `screen` module, then
 * asks this helper for a safe rectangle to open at. Keeping it pure means the
 * "don't restore off-screen / absurdly-sized windows" rules are unit-tested
 * without a display.
 */

const DEFAULTS = { width: 1280, height: 900 };
const MIN = { width: 800, height: 600 };

// Given a `saved` {x,y,width,height} (any field may be missing/garbage) and the
// display work `area` {x,y,width,height}, return bounds that:
//   - fall back to a centred default size when nothing usable is saved,
//   - are clamped to at least the app minimums and at most the work area,
//   - are nudged fully on-screen (so a window saved on a now-disconnected
//     monitor still appears).
// `defaults`/`min` are injectable for tests.
function sanitizeBounds(saved, area, defaults, min) {
  const def = defaults || DEFAULTS;
  const mn = min || MIN;
  const s = saved || {};
  const a = area || { x: 0, y: 0, width: def.width, height: def.height };

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  let width = num(s.width) || def.width;
  let height = num(s.height) || def.height;
  width = Math.max(mn.width, Math.min(width, a.width));
  height = Math.max(mn.height, Math.min(height, a.height));

  // If no valid position was saved, centre in the work area.
  let x = num(s.x);
  let y = num(s.y);
  if (x === null || y === null) {
    x = a.x + Math.round((a.width - width) / 2);
    y = a.y + Math.round((a.height - height) / 2);
  } else {
    // Clamp so the window is fully inside the work area.
    x = Math.max(a.x, Math.min(x, a.x + a.width - width));
    y = Math.max(a.y, Math.min(y, a.y + a.height - height));
  }
  return { x, y, width, height };
}

module.exports = { sanitizeBounds, DEFAULTS, MIN };
