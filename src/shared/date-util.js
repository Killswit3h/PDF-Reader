'use strict';

/*
 * Date formatting, shared by placement.js and unit-tested in Node.
 * `todayFormatted` takes an optional Date so tests are deterministic; the app
 * calls it with no arg to use "now". Dual export → { todayFormatted } in Node,
 * or App.todayFormatted in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  // MM/DD/YYYY, zero-padded.
  function todayFormatted(date) {
    const d = date || new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getFullYear()}`;
  }

  return { todayFormatted };
});
