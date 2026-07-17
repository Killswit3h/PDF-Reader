'use strict';

/*
 * Print preview + page-range selection (Tier A, renderer-only).
 *
 * Before the platform print path runs, show the user the exact pages that will
 * come out — one thumbnail per sheet, rendered with PDF.js from the *exported*
 * bytes (all placements/markups/measurements baked in), so the preview matches
 * the printout. The user can narrow the print to a subset of pages, either by
 * typing a range ("1-3, 5, 8-10") or by clicking thumbnails to toggle them.
 * Being renderer-only, it ships identically to Windows, macOS and the Android
 * WebView.
 *
 * App.Print.preview(bytes) opens the modal and resolves:
 *   { pages:[1,3,...], total:N } -> the user pressed Print (pages are 1-based,
 *                                   ascending; caller prints those pages)
 *   null                         -> the user cancelled / closed the modal
 *
 * App.Print.buildSubset(bytes, pages, total) returns the bytes to actually
 * print: the originals when every page is selected, else a fresh PDF containing
 * just `pages` (in order) via pdf-lib copyPages.
 *
 * Selection model — three explicit modes (mirrors a browser print dialog):
 *   'all'     : every page prints (the text field is disabled).
 *   'current' : just the page the user was viewing when they hit Print — handy
 *               when you want one specific sheet but don't know its number.
 *   'range'   : `selected` (a Set of 1-based page numbers) prints. Typing edits
 *               the Set; clicking a thumbnail toggles one page and rewrites the
 *               field to the normalised range. Print is disabled when the range
 *               resolves to zero valid pages.
 */
(function () {
  const P = {};
  const pdfjsLib = window.pdfjsLib;
  let observer = null;      // lazy-thumbnail IntersectionObserver
  let resolveFn = null;     // resolver for the in-flight preview() promise
  let renderDoc = null;     // pdf.js proxy for the previewed bytes
  let numPages = 0;
  let mode = 'all';         // 'all' | 'current' | 'range'
  let selected = new Set(); // 1-based page numbers (meaningful in 'range' mode)
  let currentPage = 1;      // the page the user was viewing (1-based, clamped)

  function modal() { return App.$('#printprev-modal'); }
  function isOpen() { return modal() && !modal().classList.contains('hidden'); }

  /* ---------------- range parsing / formatting ---------------- */
  // "1-3, 5, 8-10" -> Set{1,2,3,5,8,9,10}, clamped to [1, max]; junk ignored.
  function parseRanges(str, max) {
    const set = new Set();
    String(str || '').split(',').forEach((raw) => {
      const tok = raw.trim();
      if (!tok) return;
      const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a > b) { const t = a; a = b; b = t; }
        for (let i = Math.max(1, a); i <= Math.min(max, b); i++) set.add(i);
      } else if (/^\d+$/.test(tok)) {
        const n = parseInt(tok, 10);
        if (n >= 1 && n <= max) set.add(n);
      }
    });
    return set;
  }
  // Set{1,2,3,5} -> "1-3, 5". Empty set -> "".
  function formatRanges(set) {
    const arr = [...set].sort((a, b) => a - b);
    const parts = [];
    let i = 0;
    while (i < arr.length) {
      let j = i;
      while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
      parts.push(arr[i] === arr[j] ? String(arr[i]) : `${arr[i]}-${arr[j]}`);
      i = j + 1;
    }
    return parts.join(', ');
  }
  // The pages that will actually print, ascending (1-based).
  function effectivePages() {
    if (mode === 'all') return Array.from({ length: numPages }, (_, i) => i + 1);
    if (mode === 'current') return numPages ? [currentPage] : [];
    return [...selected].sort((a, b) => a - b);
  }

  /* ---------------- rendering ---------------- */
  async function renderThumb(tile) {
    const canvas = tile.querySelector('canvas');
    if (!canvas || canvas.dataset.done || !renderDoc) return;
    const n = parseInt(tile.dataset.n, 10);
    try {
      const page = await renderDoc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = 200 / base.width; // ~200px-wide thumbnail, upscaled by CSS
      const vp = page.getViewport({ scale, rotation: page.rotate });
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      canvas.dataset.done = '1';
    } catch (_) { /* leave the blank placeholder */ }
  }

  function onVisible(entries) {
    entries.forEach((en) => {
      if (en.isIntersecting) { renderThumb(en.target); observer.unobserve(en.target); }
    });
  }

  // Reflect the current selection in the thumbnails, the count and the Print
  // button. Never rewrites the text field (so it doesn't fight the caret).
  function refresh() {
    const input = App.$('#pp-range');
    const rAll = App.$('#pp-mode-all');
    const rCurrent = App.$('#pp-mode-current');
    const rRange = App.$('#pp-mode-range');
    if (rAll) rAll.checked = mode === 'all';
    if (rCurrent) rCurrent.checked = mode === 'current';
    if (rRange) rRange.checked = mode === 'range';
    if (input) input.disabled = mode !== 'range';

    const eff = new Set(effectivePages());
    modal().querySelectorAll('.pp-tile').forEach((tile) => {
      tile.classList.toggle('excluded', !eff.has(parseInt(tile.dataset.n, 10)));
    });

    const k = eff.size;
    const count = App.$('#pp-count');
    if (count) {
      count.textContent = k === 0 ? 'No pages selected'
        : mode === 'current' ? `Page ${currentPage} of ${numPages}`
        : (mode === 'all' || k === numPages)
          ? (numPages === 1 ? '1 page' : numPages + ' pages')
          : `${k} of ${numPages} pages`;
    }
    const printBtn = App.$('#pp-print');
    if (printBtn) printBtn.disabled = k === 0;
  }

  // Toggle one page's inclusion (thumbnail click). Switches to range mode,
  // seeding from "all" the first time, then syncs the text field.
  function togglePage(n) {
    if (mode === 'all') { selected = new Set(effectivePages()); mode = 'range'; }
    if (selected.has(n)) selected.delete(n); else selected.add(n);
    const input = App.$('#pp-range');
    if (input) input.value = formatRanges(selected);
    refresh();
  }

  async function buildGrid(bytes) {
    const grid = App.$('#pp-grid');
    grid.innerHTML = '';
    const data = new Uint8Array(bytes.byteLength || bytes.length);
    data.set(bytes);
    renderDoc = await pdfjsLib.getDocument({ data }).promise;
    numPages = renderDoc.numPages;

    // Clamp the caller-supplied current page into range and label the radio with
    // it, so the user can pick "Current page (7)" without knowing the number.
    currentPage = Math.min(Math.max(1, currentPage || 1), numPages);
    const curN = App.$('#pp-current-n');
    if (curN) curN.textContent = `(${currentPage})`;

    // Reset selection to "all pages" for each fresh preview.
    mode = 'all';
    selected = new Set(effectivePages());
    const input = App.$('#pp-range');
    if (input) input.value = '';

    observer = ('IntersectionObserver' in window)
      ? new IntersectionObserver(onVisible, { root: grid, rootMargin: '300px' })
      : null;

    for (let n = 1; n <= numPages; n++) {
      const tile = document.createElement('div');
      tile.className = 'pp-tile';
      tile.dataset.n = String(n);
      tile.title = 'Click to include / exclude this page';
      const canvas = document.createElement('canvas');
      canvas.className = 'pp-thumb';
      const badge = document.createElement('div');
      badge.className = 'pp-badge';
      badge.textContent = String(n);
      const tick = document.createElement('div');
      tick.className = 'pp-tick';
      tile.appendChild(tick);
      tile.appendChild(canvas);
      tile.appendChild(badge);
      tile.addEventListener('click', () => togglePage(n));
      grid.appendChild(tile);
      if (observer) observer.observe(tile);
      else await renderThumb(tile); // no IO support: render eagerly
    }
    // Render the first few eagerly so the modal is never blank before the
    // observer has a chance to fire (also what the smoke test asserts on).
    const tiles = grid.querySelectorAll('.pp-tile');
    for (let i = 0; i < Math.min(3, tiles.length); i++) await renderThumb(tiles[i]);
    refresh();
  }

  /* ---------------- open / settle ---------------- */
  function cleanup() {
    if (observer) { observer.disconnect(); observer = null; }
    if (renderDoc) { try { renderDoc.destroy(); } catch (_) { /* ignore */ } renderDoc = null; }
    const grid = App.$('#pp-grid');
    if (grid) grid.innerHTML = '';
  }

  function settle(result) {
    if (!resolveFn && !isOpen()) return;
    modal().classList.add('hidden');
    cleanup();
    const r = resolveFn; resolveFn = null;
    if (r) r(result);
  }

  // Resolve with the selected pages (Print) unless nothing is selected.
  function confirmPrint() {
    const pages = effectivePages();
    if (!pages.length) return; // Print button is disabled in this state anyway
    settle({ pages, total: numPages });
  }

  // Open the preview for `bytes`; resolves { pages, total } or null. `current`
  // is the 1-based page the user was viewing (defaults to 1) — it seeds the
  // "Current page" option.
  P.preview = async function (bytes, current) {
    if (resolveFn) settle(null); // never leave a prior preview dangling
    currentPage = current || 1;
    modal().classList.remove('hidden');
    const promise = new Promise((res) => { resolveFn = res; });
    try {
      await buildGrid(bytes);
    } catch (e) {
      settle(null);
      throw e;
    }
    return promise;
  };

  // Bytes to hand the printer: the originals when all pages are selected, else a
  // fresh PDF with just `pages` (in order). `total` avoids re-counting.
  P.buildSubset = async function (bytes, pages, total) {
    if (!pages || pages.length === 0) return bytes;
    if (total != null && pages.length === total) return bytes;
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.load(bytes);
    if (total == null && pages.length === src.getPageCount()) return bytes;
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, pages.map((p) => p - 1));
    copied.forEach((pg) => out.addPage(pg));
    return out.save();
  };

  // Programmatic hooks (used by the Escape handler + smoke harness).
  P.confirm = confirmPrint;
  P.cancel = () => settle(null);

  function wire() {
    App.$('#pp-print').addEventListener('click', confirmPrint);
    App.$('#pp-cancel').addEventListener('click', () => settle(null));
    App.$('#pp-close').addEventListener('click', () => settle(null));
    // A click on the dimmed backdrop (outside the card) cancels.
    modal().addEventListener('mousedown', (e) => { if (e.target === modal()) settle(null); });

    App.$('#pp-mode-all').addEventListener('change', () => { mode = 'all'; refresh(); });
    App.$('#pp-mode-current').addEventListener('change', () => { mode = 'current'; refresh(); });
    App.$('#pp-mode-range').addEventListener('change', () => {
      mode = 'range';
      const input = App.$('#pp-range');
      const parsed = parseRanges(input.value, numPages);
      // First switch into range mode with an empty field defaults to all pages,
      // so the thumbnails don't all disappear before the user types.
      selected = parsed.size ? parsed : new Set(effectivePagesAll());
      if (!parsed.size) input.value = formatRanges(selected);
      refresh();
      input.focus(); input.select();
    });
    App.$('#pp-range').addEventListener('input', () => {
      mode = 'range';
      selected = parseRanges(App.$('#pp-range').value, numPages);
      refresh();
    });
    // Normalise the field when the user commits (blur / Enter).
    App.$('#pp-range').addEventListener('blur', () => {
      if (mode === 'range' && selected.size) App.$('#pp-range').value = formatRanges(selected);
    });
    App.$('#pp-range').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (!App.$('#pp-print').disabled) confirmPrint(); }
    });
  }
  // Helper used only when seeding range mode (all pages, ignoring current mode).
  function effectivePagesAll() { return Array.from({ length: numPages }, (_, i) => i + 1); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  App.Print = P;
})();
