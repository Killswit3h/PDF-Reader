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

  return { isLandscape, orientationForSizes };
});
