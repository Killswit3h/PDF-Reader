'use strict';

/*
 * Scale detection: parsing and arithmetic, shared by scaledetect.js and
 * unit-tested in Node.
 *
 * Two sources of truth for "what scale is this page drawn at":
 *
 *   Tier A - the file says so. A CAD/BIM exporter writes ISO 32000 s12.9
 *            measurement data: a /VP array of viewport dictionaries, each with
 *            a /BBox region and a /Measure dictionary. `measureToScale` turns
 *            one of those into the app's { factor, unit } pair. This is exact.
 *
 *   Tier B - a human wrote it in the title block ("SCALE: 1/4" = 1'-0"").
 *            `parseScaleNotes` finds every scale expression in a page's text
 *            and `classify` decides whether one of them is trustworthy enough
 *            to apply without asking.
 *
 * EVERYTHING HERE EATS UNTRUSTED INPUT. Every value originates in an arbitrary
 * PDF someone opened. So: no function throws, every one returns null/false
 * rather than guessing, all regex repetition is bounded (no ReDoS), unit labels
 * are matched against a null-prototype allowlist (no __proto__ reaching a
 * lookup), and every factor is bounds-checked before it can reach App.state.
 * A wrong scale is worse than no scale - it turns into confident numbers on a
 * bid - so "I don't know" is always an acceptable answer here.
 *
 * Pure - no DOM, no PDF.js, no pdf-lib, no App.state. Dual export ->
 * { ScaleDetect } in Node, App.ScaleDetect in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./measure-math').UNITS);
  } else {
    root.App = root.App || {};
    Object.assign(root.App, factory(root.App.UNITS));
  }
})(typeof self !== 'undefined' ? self : this, function (UNITS) {
  /* ------------------------------------------------------------------ units */

  // Unit spellings seen in the wild, mapped to the keys of App.UNITS. A
  // null-prototype object so a hostile label like "__proto__" or "constructor"
  // looks up as undefined instead of finding something on Object.prototype.
  const UNIT_ALIASES = Object.assign(Object.create(null), {
    in: 'in', ins: 'in', inch: 'in', inches: 'in', '"': 'in', '”': 'in',
    ft: 'ft', foot: 'ft', feet: 'ft', "'": 'ft', '’': 'ft',
    yd: 'yd', yds: 'yd', yard: 'yd', yards: 'yd',
    mm: 'mm', millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
    cm: 'cm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
    m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm'
  });

  // A /Measure's /U, or a unit word out of a scale note, normalised to a key of
  // App.UNITS. Returns null for anything not on the allowlist - FR-11 is
  // explicit that an unrecognised unit is rejected, never guessed, because
  // picking the wrong unit silently rescales every measurement on the page.
  function normalizeUnit(label) {
    if (typeof label !== 'string') return null;
    // Strip trailing periods ("FT.") and surrounding punctuation/space.
    const key = label.trim().toLowerCase().replace(/\.+$/, '').trim();
    if (!key) return null;
    const hit = UNIT_ALIASES[key];
    return (hit && Object.prototype.hasOwnProperty.call(UNITS, hit)) ? hit : null;
  }

  /* -------------------------------------------------------------- arithmetic */

  // A factor this app can actually use: real units per scale-1 viewport point.
  // The bounds are a false-positive guard, not a physical limit - a page number
  // or a revision code parsed as a ratio lands far outside them. 1e-6 is finer
  // than a micrometre per point; 1e6 is coarser than 12 miles per point.
  function plausibleFactor(f) {
    return typeof f === 'number' && isFinite(f) && f > 0 && f >= 1e-6 && f <= 1e6;
  }

  // Drawn length -> real length, as a factor. Deliberately the same arithmetic
  // as measure.js's applyScale (`realVal / (drawnVal * UNITS[u].perPoint)`), so
  // a detected scale and a hand-entered one are the same number, not two
  // numbers that happen to agree. `realUnit` is the label the factor is
  // expressed in; it does not enter the arithmetic.
  function factorFromRatio(drawnVal, drawnUnit, realVal, realUnit) {
    const du = normalizeUnit(drawnUnit);
    const ru = normalizeUnit(realUnit);
    if (!du || !ru) return null;
    if (!(drawnVal > 0) || !(realVal > 0)) return null;
    if (!isFinite(drawnVal) || !isFinite(realVal)) return null;
    const f = realVal / (drawnVal * UNITS[du].perPoint);
    return plausibleFactor(f) ? f : null;
  }

  /* ------------------------------------------- tier A: /Measure dictionaries */

  // Clip an arbitrary string out of a PDF down to something safe to put in a
  // review-list row: control characters folded to spaces, runs collapsed,
  // length capped. Done with char codes rather than a regex so no control
  // character has to appear literally in this source file. The renderer still
  // escapes the result before it reaches the DOM.
  function safeLabel(s, max) {
    if (typeof s !== 'string') return '(none)';
    const cap = max || 40;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out += (c < 32 || c === 127) ? ' ' : s.charAt(i);
    }
    out = out.replace(/\s{2,}/g, ' ').trim();
    if (out.length > cap) out = out.slice(0, cap);
    return out || '(none)';
  }

  // Numbers into labels without trailing-zero noise: 0.05555... -> 0.0556.
  function trimNum(n) {
    if (!isFinite(n)) return '?';
    return String(Math.round(n * 10000) / 10000);
  }

  // One flattened /Measure dictionary -> a scale.
  //
  // `md` is a plain object, NOT a pdf-lib PDFDict: the renderer flattens it
  // first ({ subtype, R, X: [{ U, C }] }) so pdf-lib never has to exist in this
  // module or in the Node test environment.
  //
  // /X[0].C is "user-space units -> /U units", which is exactly this app's
  // factor: at scale 1 one viewport point is one PDF user-space unit. That
  // equivalence is the same one save.js relies on when it WRITES these
  // dictionaries (save.js:469-484) - this function is its inverse.
  //
  // Returns { ok: true, factor, unit, ratioLabel } or { ok: false, reason }.
  // The reason is carried rather than collapsed to null because FR-11/AC-5
  // require the review list to say *why* a page was rejected ("unreadable
  // unit: furlongs"), which a bare null cannot express.
  function measureToScale(md) {
    if (!md || typeof md !== 'object') return { ok: false, reason: 'no measurement data' };
    if (md.subtype !== 'RL') {
      return { ok: false, reason: 'unsupported measurement type: ' + safeLabel(md.subtype) };
    }
    const x = Array.isArray(md.X) ? md.X[0] : null;
    if (!x || typeof x !== 'object') return { ok: false, reason: 'no linear measurement (/X)' };

    const unit = normalizeUnit(x.U);
    if (!unit) return { ok: false, reason: 'unreadable unit: ' + safeLabel(x.U) };

    const factor = x.C;
    if (!plausibleFactor(factor)) {
      return { ok: false, reason: 'unreadable conversion factor' };
    }
    // /R is the exporter's own human label ("1 in = 20 ft"). Prefer it when it
    // looks like one; otherwise synthesise a label in this app's own format.
    const label = (typeof md.R === 'string' && md.R.trim())
      ? safeLabel(md.R, 60)
      : '1in = ' + trimNum(factor * 72) + unit;
    return { ok: true, factor, unit, ratioLabel: label };
  }

  /* ----------------------------------------------- tier B: title-block notes */

  // Bounded repetition everywhere. Every quantifier below has an explicit upper
  // limit, so no input can drive the regex engine into exponential backtracking
  // (NFR-9 / T3.1). The limits are far above any real drawing note.
  const NUM = '\\d{1,6}(?:\\.\\d{1,4})?';
  const FRAC = '\\d{1,3}\\/\\d{1,3}';
  // "1 1/2" (mixed) must be tried before "1" (plain) or it parses as 1.
  const LEN = '(?:\\d{1,3}\\s{1,3}' + FRAC + '|' + FRAC + '|' + NUM + ')';
  const INCH_U = '(?:"|\\u201d|in\\b|ins\\b|inch(?:es)?\\b)';
  const FOOT_U = "(?:'|\\u2019|ft\\b|foot\\b|feet\\b)";

  // `1/4" = 1'-0"` / `1 1/2"=1'0"` / `1" = 20'` / `1 IN = 40 FT`
  // Covers architectural (FR-16) and engineering (FR-17) alike: they differ
  // only in whether an inches remainder follows the feet.
  const RE_IMPERIAL = new RegExp(
    '(' + LEN + ')\\s{0,3}' + INCH_U +
    '\\s{0,3}=\\s{0,3}' +
    '(' + NUM + ')\\s{0,3}' + FOOT_U +
    '(?:\\s{0,3}-?\\s{0,3}(' + LEN + ')\\s{0,3}' + INCH_U + ')?',
    'gi'
  );

  // `1:100`, `1 : 50`. Also written `1/100` on some metric sheets, but that
  // form is deliberately NOT matched - it collides with the inch fractions
  // above and would turn `1/4" = 1'-0"` into a bogus 1:4 candidate.
  const RE_RATIO = new RegExp('(' + NUM + ')\\s{0,3}:\\s{0,3}(' + NUM + ')', 'g');

  // Self-evident no-scale markers, and the ones that only mean "no single page
  // scale" when the word SCALE is nearby (FR-21). "VARIES" or "AS NOTED" on
  // their own are ordinary English and appear all over a drawing.
  // Trailing (?![A-Za-z]) rather than \b so the final period of "N.T.S." is
  // kept in the reported marker; \b would refuse it and report "N.T.S".
  const RE_NTS = /\b(N\.?T\.?S\.?|NOT\s{1,3}TO\s{1,3}SCALE)(?![A-Za-z])/i;
  const RE_SOFT_MARKER = /\b(AS\s{1,3}NOTED|AS\s{1,3}SHOWN|VARIES)\b/i;

  // How far back to look for the word SCALE when deciding whether a match is
  // a real title-block scale note or a number that merely looks like one.
  const KEYWORD_WINDOW = 40;
  const RE_KEYWORD = /scale\s*[:.-]?\s*$/i;

  // Cap on how much text is parsed from one page. A hostile or pathological
  // page cannot make this module allocate without bound (NFR-3 / T3.5).
  const MAX_TEXT = 200000;

  // Bounds on a pure `D:N` ratio, tighter than plausibleFactor because `a:b` is
  // a far weaker signal than a note with units in it - part numbers, times,
  // aspect ratios and reference codes all wear the same shape. 1:100000 is
  // coarser than any drawing FieldMark is used on (a 1:25000 map is already an
  // outlier), and 1:0.01 covers 100x detail enlargements.
  const MIN_RATIO = 0.01;
  const MAX_RATIO = 100000;

  // "1 1/2" -> 1.5, "3/16" -> 0.1875, "0.25" -> 0.25. Null if it does not
  // resolve to a usable number.
  //
  // Zero is a VALID result, not a failure: `1'-0"` is the commonest way an
  // architectural note is written, and its inches remainder is 0. Callers that
  // need a strictly positive number (the drawn length) get that check from
  // factorFromRatio, which refuses a zero or negative drawn value anyway.
  function lenToNumber(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    let m = /^(\d{1,3})\s+(\d{1,3})\/(\d{1,3})$/.exec(t);
    if (m) {
      const den = +m[3];
      if (!den) return null;
      return +m[1] + (+m[2]) / den;
    }
    m = /^(\d{1,3})\/(\d{1,3})$/.exec(t);
    if (m) {
      const den = +m[2];
      if (!den) return null;
      return (+m[1]) / den;
    }
    const n = parseFloat(t);
    return isFinite(n) && n >= 0 ? n : null;
  }

  // Was this match introduced by the word SCALE? Looks only at the characters
  // immediately before it, so `SCALE: 1/4" = 1'-0"` counts and a stray `1:100`
  // in a schedule does not.
  function isKeyworded(text, index) {
    const from = Math.max(0, index - KEYWORD_WINDOW);
    return RE_KEYWORD.test(text.slice(from, index));
  }

  // Every scale expression on a page, plus any no-scale marker.
  //
  // Returns { candidates: [{ factor, unit, ratioLabel, keyworded }],
  //           noScaleMarker: string|null }
  //
  // Candidates are returned in the order found and are NOT deduped here -
  // `classify` does that, because "how many *distinct* scales does this sheet
  // claim" is the question that decides confidence.
  function parseScaleNotes(text) {
    const out = { candidates: [], noScaleMarker: null };
    if (typeof text !== 'string' || !text) return out;
    const src = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;

    // ---- no-scale markers (FR-21) ----
    const nts = RE_NTS.exec(src);
    if (nts) {
      out.noScaleMarker = nts[1].toUpperCase().replace(/\s+/g, ' ');
    } else {
      const soft = RE_SOFT_MARKER.exec(src);
      // A soft marker only counts as a declaration when SCALE introduces it.
      if (soft && isKeyworded(src, soft.index)) {
        out.noScaleMarker = soft[1].toUpperCase().replace(/\s+/g, ' ');
      }
    }

    // ---- imperial (FR-16, FR-17) ----
    RE_IMPERIAL.lastIndex = 0;
    let m;
    while ((m = RE_IMPERIAL.exec(src)) !== null) {
      const drawn = lenToNumber(m[1]);
      const feet = parseFloat(m[2]);
      const inches = m[3] ? lenToNumber(m[3]) : 0;
      if (drawn == null || !isFinite(feet) || inches == null) continue;
      const realFeet = feet + inches / 12;
      // FR-20: imperial ratios are expressed in feet, matching how the note is
      // written and the feet-inches formatter in measure-math.js.
      const factor = factorFromRatio(drawn, 'in', realFeet, 'ft');
      if (factor == null) continue;
      out.candidates.push({
        factor,
        unit: 'ft',
        ratioLabel: m[1].trim().replace(/\s+/g, ' ') + 'in = ' + trimNum(realFeet) + 'ft',
        keyworded: isKeyworded(src, m.index)
      });
    }

    // ---- pure ratio (FR-18) ----
    RE_RATIO.lastIndex = 0;
    while ((m = RE_RATIO.exec(src)) !== null) {
      const drawn = parseFloat(m[1]);
      const real = parseFloat(m[2]);
      if (!(drawn > 0) || !(real > 0)) continue;
      const ratio = real / drawn;
      if (ratio < MIN_RATIO || ratio > MAX_RATIO) continue;
      // FR-20: detail scales (1:10 and finer) are dimensioned in millimetres,
      // everything coarser in metres. Both describe the same physical scale;
      // this only picks the unit the numbers read best in.
      const unit = ratio <= 10 ? 'mm' : 'm';
      const factor = factorFromRatio(drawn, unit, real, unit);
      if (factor == null) continue;
      out.candidates.push({
        factor,
        unit,
        ratioLabel: trimNum(drawn) + ':' + trimNum(real),
        keyworded: isKeyworded(src, m.index)
      });
    }

    return out;
  }

  /* ------------------------------------------------------------- confidence */

  // Two candidates are "the same scale" when their factors agree to 6
  // significant figures and they share a unit. Sheets routinely repeat their
  // scale note in the title block and again under the drawing.
  function sameScale(a, b) {
    if (a.unit !== b.unit) return false;
    if (a.factor === b.factor) return true;
    return Math.abs(a.factor - b.factor) <= 1e-6 * Math.max(a.factor, b.factor);
  }

  function distinct(candidates) {
    const out = [];
    for (const c of candidates) {
      if (!out.some((o) => sameScale(o, c))) out.push(c);
    }
    return out;
  }

  // How much to trust a page's candidates, and whether to apply one unasked.
  //
  // The rule is deliberately blunt, because the cost of a wrong auto-apply is
  // a plausible wrong number on a takeoff:
  //   exactly one distinct scale, introduced by the word SCALE  -> high, apply
  //   exactly one distinct scale, not introduced by SCALE       -> low, review
  //   two or more distinct scales (a detail sheet)              -> low, nothing
  // FR-23, FR-24, FR-25.
  function classify(candidates) {
    const all = Array.isArray(candidates) ? candidates : [];
    const list = distinct(all);
    if (list.length === 0) return { confidence: 'low', apply: false, chosen: null, distinct: [] };
    if (list.length > 1) return { confidence: 'low', apply: false, chosen: null, distinct: list };
    const only = list[0];
    // Prefer a keyworded instance if any occurrence of this scale was keyworded.
    const keyworded = all.some((c) => sameScale(c, only) && c.keyworded);
    return {
      confidence: keyworded ? 'high' : 'low',
      apply: keyworded,
      chosen: only,
      distinct: list
    };
  }

  /* -------------------------------------------------------- half-size plots */

  // Standard sheet sizes in inches, portrait-normalised (w <= h).
  const SHEET_SIZES = [
    { name: 'ANSI A', w: 8.5, h: 11 },
    { name: 'ANSI B', w: 11, h: 17 },
    { name: 'ANSI C', w: 17, h: 22 },
    { name: 'ANSI D', w: 22, h: 34 },
    { name: 'ANSI E', w: 34, h: 44 },
    { name: 'ARCH A', w: 9, h: 12 },
    { name: 'ARCH B', w: 12, h: 18 },
    { name: 'ARCH C', w: 18, h: 24 },
    { name: 'ARCH D', w: 24, h: 36 },
    { name: 'ARCH E1', w: 30, h: 42 },
    { name: 'ARCH E', w: 36, h: 48 },
    { name: 'ISO A4', w: 8.27, h: 11.69 },
    { name: 'ISO A3', w: 11.69, h: 16.54 },
    { name: 'ISO A2', w: 16.54, h: 23.39 },
    { name: 'ISO A1', w: 23.39, h: 33.11 },
    { name: 'ISO A0', w: 33.11, h: 46.81 }
  ];

  const SIZE_TOL = 0.02; // 2%

  function near(a, b) {
    return Math.abs(a - b) <= SIZE_TOL * Math.max(a, b);
  }

  // Portrait-normalise so orientation never decides a match.
  function norm(size) {
    return { w: Math.min(size.w, size.h), h: Math.max(size.w, size.h) };
  }

  function matchesSheet(size, sheet) {
    const n = norm(size);
    return near(n.w, sheet.w) && near(n.h, sheet.h);
  }

  // Which pages are half-size (reduced) plots?
  //
  // "Half size" in drafting means each LINEAR dimension halved - a 22x34 sheet
  // printed on 11x17 - not half the area. So a page is a half-size candidate
  // when it matches some standard size S scaled by 0.5.
  //
  // The guard that stops this from firing on ordinary small sheets: if ANY page
  // in the document is the full size S, then this document simply contains both
  // sizes and nothing was reduced (AC-13). A reduced set is reduced throughout.
  //
  // `pageSizesInches` is [{ w, h }] per page. Returns one entry per page:
  //   { half: boolean, of: string|null }
  function halfSizePages(pageSizesInches) {
    const sizes = Array.isArray(pageSizesInches) ? pageSizesInches : [];
    const valid = sizes.map((s) => (
      s && isFinite(s.w) && isFinite(s.h) && s.w > 0 && s.h > 0 ? s : null
    ));

    // Which full sizes are physically present in this document?
    const present = SHEET_SIZES.filter(
      (sheet) => valid.some((s) => s && matchesSheet(s, sheet))
    );

    return valid.map((s) => {
      if (!s) return { half: false, of: null };
      for (const sheet of SHEET_SIZES) {
        const halved = { w: sheet.w / 2, h: sheet.h / 2 };
        if (!matchesSheet(s, halved)) continue;
        // Full size present in the same document -> a mixed set, not a
        // reduction.
        if (present.some((p) => p.name === sheet.name)) continue;
        return { half: true, of: sheet.name };
      }
      return { half: false, of: null };
    });
  }

  return {
    ScaleDetect: {
      UNIT_ALIASES,
      SHEET_SIZES,
      MAX_TEXT,
      normalizeUnit,
      plausibleFactor,
      factorFromRatio,
      measureToScale,
      parseScaleNotes,
      classify,
      halfSizePages,
      // exported for tests + the renderer's review-list rows
      safeLabel,
      trimNum,
      lenToNumber
    }
  };
});
