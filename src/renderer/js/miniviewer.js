'use strict';

/*
 * MiniViewer — a lightweight, read-only PDF viewer.
 *
 * Powers the in-window Split View right pane (splitview.js): a second document
 * shown for reference, without the full editing stack. (To put a document on a
 * separate monitor, tab tear-off opens a full interactive window instead.)
 *
 * It is deliberately self-contained: it only needs `window.pdfjsLib` and a
 * container element, and attaches as both App.MiniViewer and window.MiniViewer.
 * Pages render lazily (IntersectionObserver) so a 500-page set doesn't
 * rasterize all at once.
 */
(function () {
  const CSS_UNITS = 96 / 72;

  function ensureWorker(vendor) {
    const lib = window.pdfjsLib;
    if (lib && lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      const base = vendor || window.PDFJS_VENDOR || '../../node_modules/pdfjs-dist/';
      lib.GlobalWorkerOptions.workerSrc = base + 'build/pdf.worker.min.js';
    }
  }

  function create(container, opts) {
    opts = opts || {};
    ensureWorker(opts.vendor);
    const lib = window.pdfjsLib;

    let doc = null;
    let zoom = opts.zoom || 1.0;
    let pageBoxes = [];      // { el, canvas, rendered, baseW, baseH }
    let observer = null;
    let renderToken = 0;     // bumped on reload/zoom to cancel stale renders

    container.classList.add('mini-viewer');

    function clear() {
      renderToken++;
      if (observer) { observer.disconnect(); observer = null; }
      pageBoxes = [];
      container.innerHTML = '';
    }

    async function layout() {
      const token = renderToken;
      container.innerHTML = '';
      pageBoxes = [];
      if (observer) observer.disconnect();
      // One placeholder per page, pre-sized so scroll position is stable before
      // a page has actually rasterized.
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        if (token !== renderToken) return; // a newer load/zoom superseded us
        const vp = page.getViewport({ scale: 1 });
        const box = document.createElement('div');
        box.className = 'mini-page';
        box.style.width = Math.floor(vp.width * CSS_UNITS * zoom) + 'px';
        box.style.height = Math.floor(vp.height * CSS_UNITS * zoom) + 'px';
        container.appendChild(box);
        pageBoxes.push({ el: box, num: i, canvas: null, rendered: false, page });
      }
      observer = new IntersectionObserver((entries) => {
        entries.forEach((en) => { if (en.isIntersecting) renderBox(pageBoxes[+en.target.dataset.idx], token); });
      }, { root: container, rootMargin: '400px 0px' });
      pageBoxes.forEach((b, idx) => { b.el.dataset.idx = idx; observer.observe(b.el); });
    }

    async function renderBox(box, token) {
      if (!box || box.rendered || token !== renderToken) return;
      box.rendered = true; // claim it so we don't double-render on rapid scroll
      const scale = CSS_UNITS * zoom;
      const vp = box.page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.ceil(vp.width * ratio);
      canvas.height = Math.ceil(vp.height * ratio);
      canvas.style.width = Math.floor(vp.width) + 'px';
      canvas.style.height = Math.floor(vp.height) + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      try {
        await box.page.render({ canvasContext: ctx, viewport: vp }).promise;
      } catch (_) { box.rendered = false; return; }
      if (token !== renderToken) return;
      box.el.innerHTML = '';
      box.el.appendChild(canvas);
      box.canvas = canvas;
    }

    const inst = {
      el: container,
      get zoom() { return zoom; },
      async loadBytes(bytes, name) {
        clear();
        // pdf.js transfers (neutralizes) the buffer; hand it a copy so the
        // caller's original bytes stay usable (e.g. the app's pdfBytes).
        const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice();
        doc = await lib.getDocument({ data }).promise;
        inst.name = name || 'document.pdf';
        await layout();
        return doc.numPages;
      },
      setZoom(z) {
        zoom = Math.max(0.25, Math.min(6, z));
        if (doc) layout();
        return zoom;
      },
      zoomIn() { return inst.setZoom(zoom * 1.2); },
      zoomOut() { return inst.setZoom(zoom / 1.2); },
      fitWidth() {
        if (!pageBoxes.length) return zoom;
        const avail = container.clientWidth - 24;
        const first = pageBoxes[0];
        const baseW = first.el.offsetWidth / zoom; // css px at zoom 1
        if (baseW > 0) inst.setZoom(avail / baseW);
        return zoom;
      },
      destroy() { clear(); doc = null; }
    };
    return inst;
  }

  const MiniViewer = { create };
  window.MiniViewer = MiniViewer;
  if (window.App) window.App.MiniViewer = MiniViewer;
})();
