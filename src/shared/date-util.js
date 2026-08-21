'use strict';

/*
 * Date formatting, shared by placement.js and unit-tested in Node.
 * `todayFormatted` takes an optional Date so tests are deterministic; the app
 * calls it with no arg to use "now". Dual export → { todayFormatted } in Node,
 * or App.todayFormatted in the browser. pdfDateString is the PDF-wire format.
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

  // A PDF date string: D:YYYYMMDDHHmmSSOHH'mm' (PDF 1.7, 7.9.4). Written to
  // /CreationDate and /M on exported annotations so Bluebeam and Acrobat show a
  // date in their markup list -- without these keys both display a blank column
  // and cannot sort by date. Takes an optional Date so tests are deterministic.
  function pdfDateString(date) {
    const dt = date || new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = String(dt.getFullYear()) + p(dt.getMonth() + 1) + p(dt.getDate()) +
      p(dt.getHours()) + p(dt.getMinutes()) + p(dt.getSeconds());
    // getTimezoneOffset is minutes BEHIND UTC, so the sign flips.
    const off = -dt.getTimezoneOffset();
    const abs = Math.abs(off);
    const tz = off === 0
      ? "Z00'00'"
      : (off > 0 ? '+' : '-') + p(Math.floor(abs / 60)) + "'" + p(abs % 60) + "'";
    return 'D:' + stamp + tz;
  }

  return { todayFormatted, pdfDateString };
});
