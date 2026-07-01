'use strict';

/*
 * PDF.js viewer: loads a document, renders every page to a canvas, and
 * manages zoom / navigation. Placement geometry is stored in *scale-1
 * viewport points* (see placement.js), so re-rendering at a new zoom only
 * needs to reposition existing items — no data conversion.
 */
(function () {
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.js';

  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 4.0;
  const ZOOM_STEP = 0.2;

  const Viewer = {};

  // ---- Load a document from an ArrayBuffer ----
  Viewer.load = async function (arrayBuffer, name, filePath) {
    App.showLoading('Opening PDF…');
    try {
      // Keep a pristine copy for pdf-lib (pdf.js detaches the buffer it gets).
      const original = new Uint8Array(arrayBuffer.byteLength);
      original.set(new Uint8Array(arrayBuffer));

      const forPdfJs = new Uint8Array(arrayBuffer.byteLength);
      forPdfJs.set(new Uint8Array(arrayBuffer));

      const task = pdfjsLib.getDocument({ data: forPdfJs });
      const doc = await task.promise;

      // Reset state for the new document.
      Viewer._clear();
      App.state.pdfDoc = doc;
      App.state.pdfBytes = original;
      App.state.fileName = name || 'document.pdf';
      App.state.filePath = filePath || null;
      App.state.numPages = doc.numPages;
      App.state.currentPage = 1;
      App.state.zoom = 1.0;

      // Cache scale-1 viewports (includes each page's rotation).
      App.state.baseViewports = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        App.state.baseViewports[i - 1] = page.getViewport({ scale: 1 });
      }

      App.$('#empty-state').classList.add('hidden');
      App.$('#page-total').textContent = String(doc.numPages);
      App.$('#page-input').value = '1';
      document.title = `${App.state.fileName} — PDF Signer`;

      // Fit to width on first open for a friendly default.
      Viewer._computeFitWidthZoom();
      await Viewer.renderAll();
      Viewer._updateControls(true);
      App.toast(`Opened ${App.state.fileName}`, 'success');
    } catch (err) {
      console.error(err);
      Viewer._clear();
      Viewer._updateControls(false);
      App.$('#empty-state').classList.remove('hidden');
      const msg = /password|encrypted/i.test(err.message || '')
        ? 'This PDF is password-protected / encrypted and cannot be opened.'
        : 'Could not open this file. It may be corrupt or not a valid PDF.';
      App.toast(msg, 'error', 6000);
    } finally {
      App.hideLoading();
    }
  };

  Viewer._clear = function () {
    App.$('#pages-container').innerHTML = '';
    App.state.pageEls = [];
    App.state.placements = [];
    App.state.selectedId = null;
    // reset measurement state for the new document
    App.state.scales = {};
    App.state.viewports = {};
    App.state.measurements = [];
    App.state.measureSelectedId = null;
    if (App.Measure) App.Measure.renderPanel();
    App.setMode && App.setMode(null);
  };

  // ---- Render every page at the current zoom ----
  Viewer.renderAll = async function () {
    const container = App.$('#pages-container');
    container.innerHTML = '';
    App.state.pageEls = [];

    for (let i = 1; i <= App.state.numPages; i++) {
      const page = await App.state.pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: App.state.zoom });

      const holder = document.createElement('div');
      holder.className = 'page-holder';
      holder.dataset.page = String(i);
      holder.style.width = `${viewport.width}px`;
      holder.style.height = `${viewport.height}px`;

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const overlay = document.createElement('div');
      overlay.className = 'page-overlay';
      overlay.dataset.page = String(i);

      holder.appendChild(canvas);
      holder.appendChild(overlay);
      container.appendChild(holder);

      App.state.pageEls[i - 1] = { holder, canvas, overlay };

      await page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      }).promise;
    }

    App.$('#zoom-label').textContent = `${Math.round(App.state.zoom * 100)}%`;

    // Re-attach placement + measurement overlays after canvases are rebuilt.
    if (App.Placement) App.Placement.repositionAll();
    if (App.Measure) App.Measure.repositionAll();
  };

  // ---- Zoom ----
  Viewer.setZoom = async function (z) {
    App.state.zoom = App.clamp(z, ZOOM_MIN, ZOOM_MAX);
    await Viewer.renderAll();
  };
  Viewer.zoomIn = () => Viewer.setZoom(App.state.zoom + ZOOM_STEP);
  Viewer.zoomOut = () => Viewer.setZoom(App.state.zoom - ZOOM_STEP);

  Viewer._computeFitWidthZoom = function () {
    const vp = App.state.baseViewports[0];
    if (!vp) return;
    const wrap = App.$('#viewer-wrap');
    const avail = wrap.clientWidth - 56; // padding + a little breathing room
    App.state.zoom = App.clamp(avail / vp.width, ZOOM_MIN, ZOOM_MAX);
  };

  Viewer.fitWidth = async function () {
    Viewer._computeFitWidthZoom();
    await Viewer.renderAll();
  };

  // ---- Navigation ----
  Viewer.goToPage = function (n) {
    n = App.clamp(Math.round(n), 1, App.state.numPages);
    App.state.currentPage = n;
    const el = App.state.pageEls[n - 1];
    if (el) el.holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
    App.$('#page-input').value = String(n);
  };
  Viewer.next = () => Viewer.goToPage(App.state.currentPage + 1);
  Viewer.prev = () => Viewer.goToPage(App.state.currentPage - 1);

  // Track which page is centered in the viewport as the user scrolls.
  Viewer.trackScroll = function () {
    const wrap = App.$('#viewer-wrap');
    let raf = null;
    wrap.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const mid = wrap.scrollTop + wrap.clientHeight / 2;
        let best = 1;
        for (let i = 0; i < App.state.pageEls.length; i++) {
          const h = App.state.pageEls[i].holder;
          if (h.offsetTop <= mid) best = i + 1;
          else break;
        }
        if (best !== App.state.currentPage) {
          App.state.currentPage = best;
          App.$('#page-input').value = String(best);
        }
      });
    });
  };

  // ---- Enable/disable toolbar controls ----
  Viewer._updateControls = function (enabled) {
    ['#btn-sign', '#btn-initials', '#btn-date', '#btn-measure', '#btn-zoom-out',
     '#btn-zoom-in', '#btn-fit-width', '#btn-prev', '#btn-next', '#btn-save', '#page-input']
      .forEach((s) => { App.$(s).disabled = !enabled; });
  };

  App.Viewer = Viewer;
})();
