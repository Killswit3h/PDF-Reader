'use strict';

/*
 * Print-orientation decision, shared by app.js (print flow) and unit-tested in
 * Node.
 *
 * The desktop print path drives Chromium's `webContents.print()`, which applies
 * ONE orientation to the whole job. Left to its default (portrait), a landscape
 * plan sheet — e.g. tabloid 17x11 — gets "fit to page"'d down to the portrait
 * paper's *width*, so the drawing fills only the top ~half of the sheet and the
 * rest comes out blank (everything tiny). Picking the orientation that matches
 * the sheet lets the printer's fit-to-page use the whole page.
 *
 * These helpers are pure: they take page sizes ({width,height} in points, with
 * any page rotation already applied so width/height are the *visual* extents)
 * and return the orientation to request. app.js measures the sizes via PDF.js
 * (whose default viewport already bakes in /Rotate) and this file decides.
 *
 * Dual export → { isLandscape, orientationForSizes } in Node, or
 * App.isLandscape / App.orientationForSizes in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.App = root.App || {};
    Object.assign(root.App, factory());
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // A single page is landscape when it's meaningfully wider than tall. The small
  // tolerance keeps near-square pages (and rounding noise) from flipping to
  // landscape, where portrait is the safer default.
  function isLandscape(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (w <= 0 || h <= 0) return false;
    return w > h * 1.02;
  }

  // Decide the single orientation for a print job spanning `sizes`
  // (an array of {width,height} in visual points). Chromium prints the whole
  // document in one orientation, so we go with the majority of the pages that
  // will actually print; an empty set stays portrait. A tie favours landscape,
  // since the pages that most need this are wide plan sheets.
  //   -> { landscape: boolean }  (shape matches webContents.print options)
  function orientationForSizes(sizes) {
    let landscape = 0;
    let portrait = 0;
    (Array.isArray(sizes) ? sizes : []).forEach((s) => {
      if (s && isLandscape(s.width, s.height)) landscape++;
      else if (s) portrait++;
    });
    return { landscape: landscape > 0 && landscape >= portrait };
  }

  /* ------------------------------------------------------------------ *
   * Paper sizing — normalise every printed page to the chosen sheet.
   *
   * Leaving the page geometry to Chromium is what made tabloid printing
   * unreliable: `webContents.print()` was handed an orientation and nothing
   * else, so the job's page box and the scale of the PDF inside it were both
   * Chromium's guess. On macOS a 17x11 sheet came out at roughly 3/4 size in
   * the top-left corner of the paper, and no setting in the native dialog
   * could correct it, because by then the page box was already wrong.
   *
   * So the renderer now builds the print document itself: one page per sheet,
   * exactly the size of the target paper, with the source page scaled to fill
   * it and centred. The helpers below are the pure geometry for that, kept
   * here so they unit-test in Node with no Electron and no browser.
   * ------------------------------------------------------------------ */

  // Named paper sizes in PDF points (1pt = 1/72"), portrait (width < height).
  const PAPER_SIZES = {
    letter: { width: 612, height: 792 },        // 8.5 x 11 in
    legal: { width: 612, height: 1008 },        // 8.5 x 14 in
    tabloid: { width: 792, height: 1224 },      // 11 x 17 in
    a4: { width: 595.28, height: 841.89 },
    a3: { width: 841.89, height: 1190.55 }
  };

  // Look up a paper size by name, case-insensitively. Returns null for unknown
  // names (callers treat that as "same size as the PDF" and skip normalising).
  function paperSize(name) {
    const key = String(name || '').trim().toLowerCase();
    const p = PAPER_SIZES[key];
    return p ? { width: p.width, height: p.height } : null;
  }

  // Orient `paper` to suit a `pageW` x `pageH` source: a wide sheet gets
  // landscape paper, a tall one portrait. Returns a fresh {width,height} so
  // PAPER_SIZES is never mutated.
  function orientPaper(pageW, pageH, paper) {
    const w = Number(paper && paper.width) || 0;
    const h = Number(paper && paper.height) || 0;
    if (w <= 0 || h <= 0) return null;
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    return isLandscape(pageW, pageH)
      ? { width: long, height: short }
      : { width: short, height: long };
  }

  // How to place a `pageW` x `pageH` source page on a `paperW` x `paperH`
  // sheet: the largest uniform scale that still fits (so nothing is cropped),
  // then centred. Uniform on purpose — scaling the axes independently to fill
  // every last millimetre would stretch the drawing.
  //   -> { scale, dx, dy, width, height }  (width/height = scaled extents)
  // Degenerate inputs return a 1:1 identity rather than NaN, so a malformed
  // page prints at native size instead of vanishing.
  function fitOnPaper(pageW, pageH, paperW, paperH) {
    const pw = Number(pageW) || 0;
    const ph = Number(pageH) || 0;
    const sw = Number(paperW) || 0;
    const sh = Number(paperH) || 0;
    if (pw <= 0 || ph <= 0 || sw <= 0 || sh <= 0) {
      return { scale: 1, dx: 0, dy: 0, width: pw, height: ph };
    }
    const scale = Math.min(sw / pw, sh / ph);
    const width = pw * scale;
    const height = ph * scale;
    return { scale, dx: (sw - width) / 2, dy: (sh - height) / 2, width, height };
  }

  // The full plan for one page: which paper to use and how to place the source
  // on it. `paperName` may be a PAPER_SIZES key, or anything unknown/empty to
  // mean "keep the PDF's own size" (a 1:1 identity placement).
  function layoutForPage(pageW, pageH, paperName) {
    const named = paperSize(paperName);
    if (!named) {
      const pw = Number(pageW) || 0;
      const ph = Number(pageH) || 0;
      return { paper: { width: pw, height: ph }, fit: { scale: 1, dx: 0, dy: 0, width: pw, height: ph } };
    }
    const paper = orientPaper(pageW, pageH, named);
    return { paper, fit: fitOnPaper(pageW, pageH, paper.width, paper.height) };
  }

  // PDF points -> microns, the unit Electron's `pageSize` wants. Rounded,
  // because Chromium rejects a non-integer page size.
  function ptToMicrons(pt) {
    return Math.round((Number(pt) || 0) * 25400 / 72);
  }

  // The `pageSize` for webContents.print(), given a paper size in points.
  // Returns null for degenerate input so the caller can omit the option and
  // let the platform default apply.
  function pageSizeMicrons(paper) {
    const w = ptToMicrons(paper && paper.width);
    const h = ptToMicrons(paper && paper.height);
    if (w <= 0 || h <= 0) return null;
    return { width: w, height: h };
  }

  return {
    isLandscape,
    orientationForSizes,
    PAPER_SIZES,
    paperSize,
    orientPaper,
    fitOnPaper,
    layoutForPage,
    ptToMicrons,
    pageSizeMicrons
  };
});
