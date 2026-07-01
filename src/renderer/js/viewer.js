'use strict';

/*
 * Viewer built on the official PDF.js viewer component (pdfjsViewer.PDFViewer).
 * This gives virtualized rendering (only visible pages are rasterized), a text
 * layer (selection), and find/search — the foundation for large plan sets.
 *
 * Our markup overlays (signatures, dates, measurements) attach a per-page
 * `.markup-layer` div inside each rendered `.page` div. Geometry stays in
 * scale-1 viewport points; `App.state.zoom` mirrors the viewer's current scale,
 * so the existing placement/measure code positions items with `pt * zoom`.
 */
(function () {
  const pdfjsLib = window.pdfjsLib;
  const pdfjsViewer = window.pdfjsViewer;
  const VENDOR = '../../node_modules/pdfjs-dist/';
  pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'build/pdf.worker.js';

  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 8.0;
  const ZOOM_STEP = 0.2;

  const Viewer = {};
  let eventBus = null;
  let pdfViewer = null;
  let linkService = null;
  let findController = null;
  let inited = false;

  // ---- One-time setup of the PDFViewer infrastructure ----
  Viewer.init = function () {
    if (inited) return;
    inited = true;
    const container = App.$('#viewerContainer');
    const viewerEl = App.$('#viewer');

    eventBus = new pdfjsViewer.EventBus();
    linkService = new pdfjsViewer.PDFLinkService({ eventBus });
    findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });

    pdfViewer = new pdfjsViewer.PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
      l10n: pdfjsViewer.NullL10n,
      textLayerMode: 1, // enable text selection
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      removePageBorders: true,
      maxCanvasPixels: 16777216 // cap per-page canvas to bound memory on big pages
    });
    linkService.setViewer(pdfViewer);
    Viewer._pdfViewer = pdfViewer;
    Viewer._findController = findController;
    Viewer._eventBus = eventBus;

    eventBus.on('pagesinit', () => {
      pdfViewer.currentScaleValue = 'page-width';
      App.state.zoom = pdfViewer.currentScale;
      updateZoomLabel();
      Viewer._updateControls(true);
      App.$('#page-total').textContent = String(App.state.numPages);
      App.$('#page-input').value = '1';
    });

    eventBus.on('pagechanging', (e) => {
      App.state.currentPage = e.pageNumber;
      App.$('#page-input').value = String(e.pageNumber);
    });

    eventBus.on('scalechanging', () => {
      App.state.zoom = pdfViewer.currentScale;
      updateZoomLabel();
      refreshOverlays();
    });

    // A page (re)rendered — (re)build its markup layer and draw its items.
    eventBus.on('pagerendered', (e) => {
      const pageNum = e.pageNumber;
      const pv = pdfViewer.getPageView(pageNum - 1);
      if (pv && pv.pdfPage && !App.state.baseViewports[pageNum - 1]) {
        App.state.baseViewports[pageNum - 1] = pv.pdfPage.getViewport({ scale: 1 });
      }
      refreshOverlays();
    });

    eventBus.on('updatefindmatchescount', (e) => showFindCount(e.matchesCount));
    eventBus.on('updatefindcontrolstate', (e) => showFindCount(e.matchesCount));
  };

  function updateZoomLabel() {
    App.$('#zoom-label').textContent = `${Math.round(pdfViewer.currentScale * 100)}%`;
  }

  // ---- Rebuild pageEls from the currently-rendered pages, then draw overlays ----
  function syncPageEls() {
    const viewerEl = App.$('#viewer');
    App.state.pageEls = [];
    viewerEl.querySelectorAll('.page').forEach((div) => {
      const n = parseInt(div.dataset.pageNumber, 10);
      if (!n) return;
      const canvas = div.querySelector('canvas');
      if (!canvas) return; // page not rasterized yet (virtualized away)
      let layer = div.querySelector('.markup-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'markup-layer';
        div.appendChild(layer);
      }
      layer.style.width = canvas.style.width || div.clientWidth + 'px';
      layer.style.height = canvas.style.height || div.clientHeight + 'px';
      App.state.pageEls[n - 1] = { holder: layer, overlay: layer, pageDiv: div };
    });
  }

  function refreshOverlays() {
    App.state.zoom = pdfViewer.currentScale;
    syncPageEls();
    if (App.Placement) App.Placement.repositionAll();
    if (App.Measure) App.Measure.repositionAll();
    if (App.Markup) App.Markup.repositionAll();
  }
  Viewer.refreshOverlays = refreshOverlays;

  // ---- Load a document ----
  Viewer.load = async function (arrayBuffer, name, filePath) {
    Viewer.init();
    App.showLoading('Opening PDF…');
    try {
      const original = new Uint8Array(arrayBuffer.byteLength);
      original.set(new Uint8Array(arrayBuffer));
      const forPdfJs = new Uint8Array(arrayBuffer.byteLength);
      forPdfJs.set(new Uint8Array(arrayBuffer));

      const doc = await pdfjsLib.getDocument({
        data: forPdfJs,
        cMapUrl: VENDOR + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: VENDOR + 'standard_fonts/'
      }).promise;

      // reset state for the new document
      Viewer._clearState();
      App.state.pdfDoc = doc;
      App.state.pdfBytes = original;
      App.state.fileName = name || 'document.pdf';
      App.state.filePath = filePath || null;
      App.state.numPages = doc.numPages;
      App.state.currentPage = 1;
      App.state.baseViewports = [];

      App.$('#empty-state').classList.add('hidden');
      App.$('#viewerContainer').classList.add('active');
      document.title = `${App.state.fileName} — PDF Signer`;

      pdfViewer.setDocument(doc);
      linkService.setDocument(doc, null);

      if (App.Measure) App.Measure.renderPanel();
      App.toast(`Opened ${App.state.fileName}`, 'success');
    } catch (err) {
      console.error(err);
      Viewer._clearState();
      Viewer._updateControls(false);
      App.$('#empty-state').classList.remove('hidden');
      App.$('#viewerContainer').classList.remove('active');
      const msg = /password|encrypted/i.test(err.message || '')
        ? 'This PDF is password-protected / encrypted and cannot be opened.'
        : 'Could not open this file. It may be corrupt or not a valid PDF.';
      App.toast(msg, 'error', 6000);
    } finally {
      App.hideLoading();
    }
  };

  Viewer._clearState = function () {
    App.state.pageEls = [];
    App.state.placements = [];
    App.state.selectedId = null;
    App.state.scales = {};
    App.state.viewports = {};
    App.state.measurements = [];
    App.state.measureSelectedId = null;
    App.state.annotations = [];
    App.state.annoSelectedId = null;
    App.state.annoUndo = [];
    App.state.annoRedo = [];
    App.setMode && App.setMode(null);
  };

  // ---- Zoom ----
  Viewer.setZoom = function (z) {
    if (!pdfViewer) return;
    pdfViewer.currentScale = App.clamp(z, ZOOM_MIN, ZOOM_MAX);
  };
  Viewer.zoomIn = () => pdfViewer && (pdfViewer.currentScale = App.clamp(pdfViewer.currentScale + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
  Viewer.zoomOut = () => pdfViewer && (pdfViewer.currentScale = App.clamp(pdfViewer.currentScale - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
  Viewer.fitWidth = () => { if (pdfViewer) pdfViewer.currentScaleValue = 'page-width'; };

  // ---- Navigation ----
  Viewer.goToPage = function (n) {
    if (!pdfViewer) return;
    n = App.clamp(Math.round(n), 1, App.state.numPages);
    pdfViewer.currentPageNumber = n;
    App.$('#page-input').value = String(n);
  };
  Viewer.next = () => Viewer.goToPage(App.state.currentPage + 1);
  Viewer.prev = () => Viewer.goToPage(App.state.currentPage - 1);

  // ---- Find ----
  Viewer.openFind = function () {
    App.$('#find-bar').classList.remove('hidden');
    const inp = App.$('#find-input');
    inp.focus(); inp.select();
  };
  Viewer.closeFind = function () {
    App.$('#find-bar').classList.add('hidden');
    dispatchFind('', false, false); // clear highlights
  };
  Viewer.find = function (query, findPrevious) {
    dispatchFind(query, true, !!findPrevious);
  };
  function dispatchFind(query, highlightAll, findPrevious) {
    if (!eventBus) return;
    eventBus.dispatch('find', {
      source: null, type: query ? 'again' : '', query,
      caseSensitive: false, entireWord: false,
      highlightAll, findPrevious
    });
  }
  function showFindCount(mc) {
    if (!mc) return;
    const el = App.$('#find-count');
    if (el && typeof mc.total === 'number') {
      el.textContent = mc.total ? `${mc.current}/${mc.total}` : 'No results';
    }
  }

  // trackScroll kept for boot compatibility; PDFViewer manages scrolling.
  Viewer.trackScroll = function () { Viewer.init(); };

  // ---- Enable/disable toolbar controls ----
  Viewer._updateControls = function (enabled) {
    ['#btn-sign', '#btn-initials', '#btn-date', '#btn-measure', '#btn-markup',
     '#btn-zoom-out', '#btn-zoom-in', '#btn-fit-width', '#btn-prev', '#btn-next',
     '#btn-save', '#btn-save-as', '#page-input']
      .forEach((s) => { App.$(s).disabled = !enabled; });
  };

  App.Viewer = Viewer;
})();
