'use strict';

/*
 * Favourite colours — a small named palette the user builds once and reuses.
 *
 * The six preset swatches on the markup bar are generic (red/orange/yellow/…).
 * Real take-off work runs off a legend: a plan set is colour-coded per pay item
 * with EXACT hex codes ("Guardrail #3B7D23", "Fence #FFC000"), and re-typing
 * those into the OS colour wheel for every markup is where the time goes. This
 * module is the model behind a saved list of { name, hex } entries so the bar
 * can offer them as one-click swatches.
 *
 * Pure and dual-exported so the list logic (parsing pasted legends, dedupe,
 * validation, ordering) is unit-tested in Node rather than only through the UI:
 *   Node    → require() returns the named functions
 *   browser → the same names land on App
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  // A legend rarely runs past a dozen items; the cap only stops a runaway paste
  // from filling localStorage and the toolbar strip.
  const FAV_LIMIT = 32;
  const FAV_NAME_MAX = 40;

  // "#3b7d23" from "3B7D23", "#3B7D23", "#3b7d23ff" or "#abc". Anything else is
  // null — callers treat that as "not a colour" rather than guessing.
  //
  // Lowercase output is deliberate: it's the comparison key for dedupe and for
  // matching the active swatch, and <input type="color"> also reports lowercase.
  function normalizeHex(value) {
    const s = String(value == null ? '' : value).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) return '#' + s.toLowerCase().replace(/./g, (c) => c + c);
    // An 8-digit code carries alpha; keep the RGB half — opacity is its own
    // control on the markup bar, so folding it into the swatch would silently
    // override whatever the user set there.
    if (/^[0-9a-fA-F]{8}$/.test(s)) return '#' + s.slice(0, 6).toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase();
    return null;
  }

  function cleanName(name, hex) {
    const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, FAV_NAME_MAX);
    // An unnamed favourite still needs a label for its tooltip and the manage
    // list; the code itself is the honest fallback.
    return s || String(hex || '').toUpperCase();
  }

  // Coerce whatever came back from storage into a valid list. Prefs are JSON
  // written by an older build (or a hand-edited localStorage), so every entry is
  // re-validated instead of trusted.
  function sanitizeFavorites(raw) {
    const out = [];
    const seen = Object.create(null);
    (Array.isArray(raw) ? raw : []).forEach((item) => {
      // Tolerate a bare string ("#3B7D23") as well as { hex, name }.
      const hex = normalizeHex(item && typeof item === 'object' ? item.hex : item);
      if (!hex || seen[hex]) return;
      seen[hex] = true;
      out.push({ hex, name: cleanName(item && typeof item === 'object' ? item.name : '', hex) });
    });
    return out.slice(0, FAV_LIMIT);
  }

  function indexOfHex(list, hex) {
    const h = normalizeHex(hex);
    if (!h) return -1;
    return sanitizeFavorites(list).findIndex((f) => f.hex === h);
  }

  function isFavorite(list, hex) { return indexOfHex(list, hex) >= 0; }

  // Add one colour. Re-adding a colour already on the list renames it in place
  // rather than making a second swatch of the same green — two identical chips
  // is never what the user meant, and the newer name is the better one.
  // Returns { list, added, reason } so the caller can word its own toast.
  function addFavorite(list, hex, name) {
    const cur = sanitizeFavorites(list);
    const h = normalizeHex(hex);
    if (!h) return { list: cur, added: false, reason: 'invalid' };
    const at = cur.findIndex((f) => f.hex === h);
    if (at >= 0) {
      const named = String(name == null ? '' : name).trim();
      if (named) cur[at] = { hex: h, name: cleanName(named, h) };
      return { list: cur, added: false, reason: 'duplicate' };
    }
    if (cur.length >= FAV_LIMIT) return { list: cur, added: false, reason: 'full' };
    cur.push({ hex: h, name: cleanName(name, h) });
    return { list: cur, added: true, reason: 'added' };
  }

  function removeFavorite(list, hex) {
    const h = normalizeHex(hex);
    return sanitizeFavorites(list).filter((f) => f.hex !== h);
  }

  function renameFavorite(list, hex, name) {
    const h = normalizeHex(hex);
    return sanitizeFavorites(list).map((f) => (f.hex === h ? { hex: f.hex, name: cleanName(name, f.hex) } : f));
  }

  // Move the entry at `from` to `to`, clamped. Order is the point of the strip:
  // the legend reads top-to-bottom and the swatches should match it.
  function moveFavorite(list, from, to) {
    const cur = sanitizeFavorites(list);
    if (!cur.length) return cur;
    const a = Math.max(0, Math.min(cur.length - 1, Math.trunc(from)));
    const b = Math.max(0, Math.min(cur.length - 1, Math.trunc(to)));
    if (a === b || !Number.isFinite(from) || !Number.isFinite(to)) return cur;
    cur.splice(b, 0, cur.splice(a, 1)[0]);
    return cur;
  }

  // Parse a pasted legend into entries. Typing a dozen codes by hand is the
  // chore this whole feature exists to remove, so the parser takes the shapes a
  // legend actually gets copied in as — one item per line, name and code in
  // either order, with the punctuation Word and Excel leave behind:
  //
  //   Guardrail (Green) – Hex: #3B7D23
  //   Fence (Orange) - #FFC000
  //   #7030A0  Guardrail Removal (Purple)
  //   FFFF00, Temporary Fence
  //
  // Lines with no colour code are skipped rather than failing the whole paste —
  // a legend copied out of a table brings its header row along with it.
  function parseFavoriteList(text) {
    const out = [];
    String(text == null ? '' : text).split(/[\r\n]+/).forEach((line) => {
      // The LAST code on the line wins: in "Guardrail (Green) - Hex: #3B7D23"
      // that is the colour, while a leading item number is not.
      const hashed = line.match(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g);
      let code = hashed && hashed.length ? hashed[hashed.length - 1] : null;
      if (!code) {
        // No '#' anywhere on the line — fall back to a bare code, but only one
        // with a letter in it. FDOT pay item numbers ("536001") are six digits
        // too, and reading one as a colour invents a swatch nobody asked for.
        const bare = line.match(/\b(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{6}\b/g);
        code = bare && bare.length ? bare[bare.length - 1] : null;
      }
      if (!code) return;
      const hex = normalizeHex(code);
      if (!hex) return;
      // Whatever is left once the code and its label are gone is the name.
      const name = line
        .replace(code, ' ')
        .replace(/\bhex\b\s*:?/ig, ' ')
        .replace(/[–—]/g, '-')          // en/em dash → hyphen
        .replace(/^[\s\-–—:,;|*•·]+/, '')
        .replace(/[\s\-–—:,;|*•·]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
      out.push({ hex, name: cleanName(name, hex) });
    });
    return out;
  }

  // Merge parsed entries into the saved list, honouring dedupe + the cap.
  // Returns counts so the caller can say "6 added, 1 already saved".
  function mergeFavorites(list, entries) {
    let added = 0, duplicate = 0, skipped = 0;
    let cur = sanitizeFavorites(list);
    (Array.isArray(entries) ? entries : []).forEach((e) => {
      const r = addFavorite(cur, e && e.hex, e && e.name);
      cur = r.list;
      if (r.added) added++;
      else if (r.reason === 'duplicate') duplicate++;
      else skipped++;
    });
    return { list: cur, added, duplicate, skipped };
  }

  return {
    FAV_LIMIT,
    FAV_NAME_MAX,
    normalizeHex,
    sanitizeFavorites,
    indexOfHex,
    isFavorite,
    addFavorite,
    removeFavorite,
    renameFavorite,
    moveFavorite,
    parseFavoriteList,
    mergeFavorites
  };
});
