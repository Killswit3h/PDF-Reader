'use strict';

/*
 * Markup metadata: the review columns of a Bluebeam-style Markups List.
 *
 * Every markup can carry a subject, a review status, a comment, a lock flag and
 * a creation time. This file owns the pure logic around those fields — the
 * status vocabulary, filtering, sorting and the rows the CSV / summary exports
 * write — so it can be unit-tested in Node. The renderer (markup.js) only reads
 * and writes the fields.
 *
 * Status names follow the PDF review state model (ISO 32000 §12.5.6.3,
 * /StateModel /Review): Accepted, Rejected, Cancelled, Completed, None. Those
 * are the states Acrobat and Revu read from a review reply, so a status set
 * here survives the round trip. "For Review" is a FieldMark-only label kept
 * for punch-list use; it exports as no state.
 *
 * Dual export → named functions in Node, or the same names on App in the
 * browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  const STATUSES = [
    { id: '', label: 'None', pdf: 'None' },
    { id: 'review', label: 'For Review', pdf: null },
    { id: 'accepted', label: 'Accepted', pdf: 'Accepted' },
    { id: 'rejected', label: 'Rejected', pdf: 'Rejected' },
    { id: 'completed', label: 'Completed', pdf: 'Completed' },
    { id: 'cancelled', label: 'Cancelled', pdf: 'Cancelled' }
  ];
  const BY_ID = Object.create(null);
  STATUSES.forEach((s) => { BY_ID[s.id] = s; });

  // Unknown or missing values read as "no status" rather than throwing, so a
  // model saved by a newer build still opens.
  function statusOf(an) {
    const id = an && typeof an.status === 'string' ? an.status : '';
    return BY_ID[id] || BY_ID[''];
  }
  function statusLabel(an) { return statusOf(an).label; }

  // Map a PDF /State name back to our id (import path).
  function statusFromPdf(name) {
    const n = String(name || '').toLowerCase();
    const hit = STATUSES.find((s) => s.pdf && s.pdf.toLowerCase() === n);
    return hit ? hit.id : '';
  }

  // Readable type names for the list and the exports.
  const TYPE_LABEL = {
    line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse',
    polyline: 'Polyline', polygon: 'Polygon', cloud: 'Cloud', ink: 'Pen',
    highlight: 'Highlighter', text: 'Text Box', callout: 'Callout',
    texthighlight: 'Text Highlight', underline: 'Underline',
    strikeout: 'Strikethrough', squiggly: 'Squiggly', note: 'Note',
    stamp: 'Stamp', link: 'Hyperlink', redact: 'Redaction'
  };
  function typeLabel(type) { return TYPE_LABEL[type] || String(type || ''); }

  // The subject defaults to the type name, the way Revu fills it.
  function subjectOf(an) {
    return (an && an.subject && String(an.subject).trim()) || typeLabel(an && an.type);
  }

  // The text a reviewer reads in the comment column: the typed comment, or for
  // a text box / callout / stamp the words on the sheet.
  function commentOf(an) {
    if (!an) return '';
    if (an.comment) return String(an.comment);
    if (an.type === 'link') return an.link ? (an.link.url || (an.link.page ? 'Page ' + an.link.page : '')) : '';
    return an.text ? String(an.text) : '';
  }

  // Filter by free text (type, subject, comment, page "p3") and by status id.
  // `status` undefined / null = any status; '' = only markups with no status.
  function filterMarkups(list, opts) {
    const o = opts || {};
    const q = String(o.q || '').trim().toLowerCase();
    return (list || []).filter((an) => {
      if (o.status != null && o.status !== '*' && statusOf(an).id !== o.status) return false;
      if (!q) return true;
      return String(an.type).toLowerCase().includes(q) ||
        typeLabel(an.type).toLowerCase().includes(q) ||
        subjectOf(an).toLowerCase().includes(q) ||
        commentOf(an).toLowerCase().includes(q) ||
        ('p' + an.page) === q;
    });
  }

  // Stable sort by one column. Ties keep document order (page, then id), so a
  // sorted list never shuffles between renders.
  const KEYS = {
    type: (an) => typeLabel(an.type).toLowerCase(),
    subject: (an) => subjectOf(an).toLowerCase(),
    status: (an) => STATUSES.indexOf(statusOf(an)),
    page: (an) => an.page || 0,
    date: (an) => an.createdAt || 0,
    comment: (an) => commentOf(an).toLowerCase()
  };
  function sortMarkups(list, key, dir) {
    const get = KEYS[key] || KEYS.page;
    const sign = dir === 'desc' ? -1 : 1;
    return (list || []).map((an, i) => ({ an, i })).sort((a, b) => {
      const va = get(a.an), vb = get(b.an);
      if (va < vb) return -sign;
      if (va > vb) return sign;
      if ((a.an.page || 0) !== (b.an.page || 0)) return (a.an.page || 0) - (b.an.page || 0);
      return a.i - b.i;
    }).map((x) => x.an);
  }

  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // Rows for the CSV export and the PDF summary, header first.
  function markupRows(list) {
    const rows = [['#', 'Type', 'Subject', 'Status', 'Page', 'Color', 'Comment', 'Locked', 'Created']];
    (list || []).forEach((an, i) => {
      rows.push([
        i + 1,
        typeLabel(an.type),
        subjectOf(an),
        statusLabel(an),
        an.page,
        (an.style && an.style.stroke) || '',
        commentOf(an),
        an.locked ? 'Yes' : '',
        fmtDate(an.createdAt)
      ]);
    });
    return rows;
  }

  function toCsv(rows) {
    return rows.map((r) => r.map((c) => {
      const s = String(c == null ? '' : c);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
  }

  // Count of markups per status, for the summary header.
  function statusTotals(list) {
    const out = {};
    (list || []).forEach((an) => {
      const l = statusLabel(an);
      out[l] = (out[l] || 0) + 1;
    });
    return out;
  }

  return {
    MARKUP_STATUSES: STATUSES,
    markupStatusOf: statusOf,
    markupStatusLabel: statusLabel,
    markupStatusFromPdf: statusFromPdf,
    markupTypeLabel: typeLabel,
    markupSubjectOf: subjectOf,
    markupCommentOf: commentOf,
    filterMarkups,
    sortMarkups,
    markupRows,
    markupRowsToCsv: toCsv,
    markupStatusTotals: statusTotals,
    fmtMarkupDate: fmtDate
  };
});
