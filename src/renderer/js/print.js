'use strict';

/*
 * Print preview (Tier A, renderer-only).
 *
 * Before the platform print path runs, show the user the exact pages that will
 * come out — one thumbnail per sheet, rendered with PDF.js from the *exported*
 * bytes (all placements/markups/measurements baked in), so the preview matches
 * the printout. Being renderer-only, it ships identically to Windows, macOS and
 * the Android WebView.
 *
 * App.Print.preview(bytes) opens the modal and resolves:
 *   true  -> the user pressed Print   (caller proceeds with the window.api path)
 *   false -> the user cancelled / closed the modal
 *
 * Thumbnails render lazily (IntersectionObserver) like the page organizer, so a
 * large document doesn't rasterize every sheet up front.
 */
(function () {
  const P = {};
  const pdfjsLib = window.pdfjsLib;
  let observer = null;      // lazy-thumbnail IntersectionObserver
  let resolveFn = null;     // resolver for the in-flight preview() promise
  let renderDoc = null;     // pdf.js proxy for the previewed bytes

  function modal() { return App.$('#printprev-modal'); }
  function isOpen() { return modal() && !modal().classList.contains('hidden'); }

  function cleanup() {
    if (observer) { observer.disconnect(); observer = null; }
    if (renderDoc) { try { renderDoc.destroy(); } catch (_) { /* ignore */ } renderDoc = null; }
    const grid = App.$('#pp-grid');
    if (grid) grid.innerHTML = '';
  }

  // Close the modal and resolve the outstanding promise exactly once.
  function settle(result) {
    if (!resolveFn && !isOpen()) return;
    modal().classList.add('hidden');
    cleanup();
    const r = resolveFn; resolveFn = null;
    if (r) r(result);
  }

  // Render one page thumbnail into the tile's canvas (first scroll-in only).
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

  async function buildGrid(bytes) {
    const grid = App.$('#pp-grid');
    grid.innerHTML = '';
    const data = new Uint8Array(bytes.byteLength || bytes.length);
    data.set(bytes);
    renderDoc = await pdfjsLib.getDocument({ data }).promise;
    const num = renderDoc.numPages;
    App.$('#pp-count').textContent = num === 1 ? '1 page' : num + ' pages';

    observer = ('IntersectionObserver' in window)
      ? new IntersectionObserver(onVisible, { root: grid, rootMargin: '300px' })
      : null;

    for (let n = 1; n <= num; n++) {
      const tile = document.createElement('div');
      tile.className = 'pp-tile';
      tile.dataset.n = String(n);
      const canvas = document.createElement('canvas');
      canvas.className = 'pp-thumb';
      const badge = document.createElement('div');
      badge.className = 'pp-badge';
      badge.textContent = String(n);
      tile.appendChild(canvas);
      tile.appendChild(badge);
      grid.appendChild(tile);
      if (observer) observer.observe(tile);
      else await renderThumb(tile); // no IO support: render eagerly
    }
    // Render the first few eagerly so the modal is never blank before the
    // observer has a chance to fire (also what the smoke test asserts on).
    const tiles = grid.querySelectorAll('.pp-tile');
    for (let i = 0; i < Math.min(3, tiles.length); i++) await renderThumb(tiles[i]);
  }

  // Open the preview for `bytes`; resolves true (print) / false (cancel).
  P.preview = async function (bytes) {
    if (resolveFn) settle(false); // never leave a prior preview dangling
    modal().classList.remove('hidden');
    const promise = new Promise((res) => { resolveFn = res; });
    try {
      await buildGrid(bytes);
    } catch (e) {
      settle(false);
      throw e;
    }
    return promise;
  };

  // Programmatic resolve hooks (used by the Escape handler + smoke harness).
  P.confirm = () => settle(true);
  P.cancel = () => settle(false);

  function wire() {
    App.$('#pp-print').addEventListener('click', () => settle(true));
    App.$('#pp-cancel').addEventListener('click', () => settle(false));
    App.$('#pp-close').addEventListener('click', () => settle(false));
    // A click on the dimmed backdrop (outside the card) cancels.
    modal().addEventListener('mousedown', (e) => { if (e.target === modal()) settle(false); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  App.Print = P;
})();
