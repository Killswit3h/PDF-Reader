'use strict';

/*
 * Page rotation arithmetic, shared by save.js and unit-tested in Node.
 *
 * A PDF page's /Rotate is a display instruction — it turns the page and
 * everything on it, and does not touch user space, which is why marks written
 * in user space stay glued to the drawing when a page is rotated.
 *
 * The view rotation is ADDED to whatever the page already carried, never
 * substituted for it: a drawing set can arrive with its sheets at different
 * orientations, and replacing them would flatten those differences into one.
 *
 * Dual export → { addRotation, normalizeRotation } in Node, or the same names
 * on App in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  // Coerce anything to one of 0/90/180/270.
  //
  // The spec requires /Rotate to be a multiple of 90, but files in the wild are
  // not always obliging. PDF readers round to the nearest quarter turn rather
  // than rejecting the page, so this does the same — a slightly-off value must
  // not become a NaN that reaches the saved file.
  function normalizeRotation(deg) {
    const n = Number(deg);
    if (!isFinite(n)) return 0;
    const quarter = Math.round(n / 90) * 90;
    return ((quarter % 360) + 360) % 360;
  }

  // The orientation a page should carry after being viewed at `viewRotate`.
  function addRotation(pageRotate, viewRotate) {
    return normalizeRotation(normalizeRotation(pageRotate) + normalizeRotation(viewRotate));
  }

  return { addRotation, normalizeRotation };
});
