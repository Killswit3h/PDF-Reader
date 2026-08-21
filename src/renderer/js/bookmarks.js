'use strict';

/*
 * Page bookmarks — real entries in the PDF's own /Outlines tree, not an
 * app-local flag layer. They travel with the file: a client opening it in
 * Acrobat or Bluebeam sees them, and a set someone sends you shows theirs here.
 *
 * The tree arithmetic is pure and lives in src/shared/outline.js; this file is
 * the parts that cannot be: reading the outline through pdf.js, writing it
 * through pdf-lib, and the toolbar button and shelf.
 *
 * The whole tree is held in App.state.bookmarks. Entries that arrived with the
 * file are carried through untouched — see the note in outline.js.
 */
(function () {
  const B = {};

  /* ---------------- reading (pdf.js) ---------------- */

  // Resolve an outline item's destination to a 1-based page number, or null.
  // Both destination forms occur in the wild: a NAME needing a lookup, and an
  // explicit array whose first element is the page ref. A file that uses the
  // form we did not handle would silently show no bookmarks, so both are here.
  async function pageOfDest(doc, dest) {
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return null;
      const idx = await doc.getPageIndex(explicit[0]);
      return typeof idx === 'number' ? idx + 1 : null;
    } catch (_) {
      return null; // unresolvable: kept in the tree, skipped in the shelf
    }
  }

  async function normalize(doc, nodes, owned) {
    const out = [];
    for (const n of (nodes || [])) {
      if (!n) continue;
      const page = n.dest ? await pageOfDest(doc, n.dest) : null;
      out.push({
        title: String(n.title || ''),
        page: page,
        mine: page != null && owned.has(page),
        items: await normalize(doc, n.items, owned)
      });
    }
    return out;
  }

  // Read a parsed pdf.js document's outline.
  //
  // `ownedPages` says which entries are ours, and comes from the round-trip
  // sidecar. It cannot come from the file's own /FieldMark marker: pdf.js's
  // getOutline() surfaces only title/dest/items and drops custom keys, so that
  // marker is write-only. Matching on the "Page N" title instead would claim a
  // foreign bookmark that happened to be titled that way, and FR-11 says a
  // bookmark that arrived with the file is never ours to touch.
  //
  // An unreadable outline yields an empty shelf rather than blocking the open.
  B.read = async function (doc, ownedPages) {
    const owned = new Set(ownedPages || []);
    try {
      const raw = await doc.getOutline();
      if (!raw || !raw.length) return [];
      return await normalize(doc, raw, owned);
    } catch (e) {
      if (window.console) console.warn('outline unreadable:', e && e.message);
      return [];
    }
  };

  /* ---------------- state ---------------- */

  function tree() { return App.state.bookmarks || []; }

  B.isBookmarked = function (page) { return App.hasOurBookmark(tree(), page); };

  B.toggle = function () {
    if (!App.state.pdfDoc) return;
    const page = App.state.currentPage || 1;
    App.state.bookmarks = App.toggleBookmark(tree(), page);
    // A real bookmark does not exist until the file is written, so this has to
    // count as an unsaved change or the close prompt would let it be lost.
    App.state.dirty = true;
    App.refreshDirtyIndicator();
    const on = B.isBookmarked(page);
    App.toast(on ? `Bookmarked page ${page}` : `Removed bookmark on page ${page}`, 'info', 2500);
    B.refreshButton();
    B.renderShelf();
  };

  /* ---------------- button ---------------- */

  B.refreshButton = function () {
    const btn = App.$('#btn-bookmark');
    if (!btn) return;
    const open = !!App.state.pdfDoc;
    btn.disabled = !open;
    const on = open && B.isBookmarked(App.state.currentPage || 1);
    btn.classList.toggle('armed', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = !open ? 'Bookmark this page'
      : on ? `Remove bookmark on page ${App.state.currentPage}`
        : `Bookmark page ${App.state.currentPage}`;
  };

  /* ---------------- shelf ---------------- */

  B.renderShelf = function () {
    const list = App.$('#bookmark-list');
    if (!list) return;
    const rows = App.flattenOutline(tree());
    list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'bm-empty';
      empty.textContent = 'No bookmarks yet — open a page and press the bookmark button.';
      list.appendChild(empty);
      return;
    }
    rows.forEach((r) => {
      const row = document.createElement('button');
      row.className = 'bm-row' + (r.mine ? '' : ' bm-foreign');
      row.style.paddingLeft = (10 + r.depth * 14) + 'px';
      row.innerHTML =
        `<span class="bm-title"></span><span class="bm-page">p.${r.page}</span>`;
      row.querySelector('.bm-title').textContent = r.title || `Page ${r.page}`;
      // Bookmarks that came with the file are shown but marked, so the shelf
      // never claims one of them is ours to toggle.
      if (!r.mine) row.title = 'Bookmark saved in this document';
      row.addEventListener('click', () => {
        App.Viewer.goToPage(r.page);
        B.refreshButton();
      });
      list.appendChild(row);
    });
  };

  /* ---------------- writing (pdf-lib) ---------------- */

  // Build the /Outlines tree on a pdf-lib document's catalog.
  //
  // pdf-lib has no outline API, so the dictionaries are assembled by hand — the
  // same technique save.js uses for annotations. Each item needs /Title,
  // /Parent, /Dest and its /Prev + /Next sibling links; the root needs /First,
  // /Last and /Count. A malformed chain here can make a viewer reject the whole
  // document, not merely show no bookmarks, which is why the tree it is built
  // from is unit-tested separately.
  B.writeOutline = function (pdfDoc, nodes) {
    const { PDFName, PDFNumber, PDFString, PDFArray } = window.PDFLib;
    const ctx = pdfDoc.context;
    const pages = pdfDoc.getPages();
    const list = nodes || [];
    if (!App.countOutline(list)) return false;

    const rootRef = ctx.nextRef();
    const rootDict = ctx.obj({});
    rootDict.set(PDFName.of('Type'), PDFName.of('Outlines'));

    // Returns { firstRef, lastRef, count } for one level of siblings.
    const build = (siblings, parentRef) => {
      const refs = [];
      const dicts = [];
      for (const n of siblings) {
        if (!n) continue;
        const d = ctx.obj({});
        d.set(PDFName.of('Title'), PDFString.of(String(n.title || '')));
        d.set(PDFName.of('Parent'), parentRef);
        const pageIdx = (typeof n.page === 'number' && n.page > 0) ? n.page - 1 : -1;
        if (pageIdx >= 0 && pageIdx < pages.length) {
          const dest = PDFArray.withContext(ctx);
          dest.push(pages[pageIdx].ref);
          dest.push(PDFName.of('Fit'));
          d.set(PDFName.of('Dest'), dest);
        }
        // Provenance marker. A non-standard key in an outline item is ignored
        // by other viewers. Write-only for now -- pdf.js drops custom keys when
        // reading, so ownership on reopen comes from the sidecar instead -- but
        // it records in the file itself which entries this app created.
        if (n.mine) d.set(PDFName.of('FieldMark'), PDFName.of('true'));
        const ref = ctx.nextRef();
        refs.push(ref); dicts.push({ d, node: n, ref });
      }
      if (!refs.length) return null;
      let count = refs.length;
      dicts.forEach((entry, i) => {
        if (i > 0) entry.d.set(PDFName.of('Prev'), refs[i - 1]);
        if (i < refs.length - 1) entry.d.set(PDFName.of('Next'), refs[i + 1]);
        const kids = entry.node.items && entry.node.items.length
          ? build(entry.node.items, entry.ref) : null;
        if (kids) {
          entry.d.set(PDFName.of('First'), kids.firstRef);
          entry.d.set(PDFName.of('Last'), kids.lastRef);
          // Positive = open. Children are counted into the parent's total.
          entry.d.set(PDFName.of('Count'), PDFNumber.of(kids.count));
          count += kids.count;
        }
        ctx.assign(entry.ref, entry.d);
      });
      return { firstRef: refs[0], lastRef: refs[refs.length - 1], count };
    };

    const top = build(list, rootRef);
    if (!top) return false;
    rootDict.set(PDFName.of('First'), top.firstRef);
    rootDict.set(PDFName.of('Last'), top.lastRef);
    rootDict.set(PDFName.of('Count'), PDFNumber.of(top.count));
    ctx.assign(rootRef, rootDict);
    pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
    return true;
  };

  App.Bookmarks = B;
})();
