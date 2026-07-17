'use strict';

/*
 * Viewer built on the official PDF.js viewer component (pdfjsViewer.PDFViewer).
 * This gives virtualized rendering (only visible pages are rasterized), a text
 * layer (selection), and find/search — the foundation for large plan sets.
 *
 * Our markup overlays (signatures, dates, measurements) attach a per-page
 * `.markup-layer` div inside each rendered `.page` div. Geometry stays in
 * scale-1 viewport points; `App.state.zoom` is the CSS-pixels-per-scale-1-point
 * ratio, so the existing placement/measure code positions items with `pt * zoom`
 * and exports them with `viewport.convertToPdfPoint(pt)` (1 scale-1 point == 1
 * PDF point).
 *
 * NOTE: PDF.js renders a page at `currentScale * CSS_UNITS` CSS pixels per PDF
 * point (CSS_UNITS = 96/72). `currentScale` alone is NOT the on-screen ratio, so
 * App.state.zoom must fold in CSS_UNITS — otherwise captured points come out
 * CSS_UNITS× too large and, while they look right on screen (the factor cancels
 * on redraw), they flatten to the wrong spot on save.
 */
(function () {
  const pdfjsLib = window.pdfjsLib;
  const pdfjsViewer = window.pdfjsViewer;
  // PDF.js CSS unit factor (96 CSS px per inch / 72 PDF pt per inch).
  const CSS_UNITS = 96 / 72;
  const cssScale = () => (pdfViewer ? pdfViewer.currentScale * CSS_UNITS : CSS_UNITS);
  // Where the bundled PDF.js assets (worker) live. Electron loads the renderer
  // straight from the source tree, so it resolves them under node_modules. The
  // mobile/web build (scripts/build-web.js) copies them into a self-contained
  // www/ and sets window.PDFJS_VENDOR before this module runs to point here.
  const VENDOR = window.PDFJS_VENDOR || '../../node_modules/pdfjs-dist/';
  pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'build/pdf.worker.min.js';

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

    // Per-page canvas budget. PDF.js rasterizes each page to a single canvas and,
    // once a page's pixel area (viewportW*viewportH * devicePixelRatio^2) exceeds
    // this cap, clamps the render scale and upscales the smaller bitmap to fit —
    // which is the blur seen when zooming into dense vector sheets (large
    // FDOT/engineering plans). The old value was PDF.js's 2^24 (~16.7M px)
    // default, which hits that clamp at only modest zoom on D-size sheets. Give a
    // much larger budget so zoomed-in linework stays crisp, scaled by dpr^2 so
    // high-DPI/retina screens (which need dpr^2 more pixels for equal sharpness)
    // get their share, and ceiling it at 2^28 — Chromium's practical single-
    // canvas limit — to keep memory bounded. This is a ceiling on the zoomed-in
    // case, not a constant allocation: normal views render far below it.
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const maxCanvasPixels = Math.min(268435456, Math.round(67108864 * dpr * dpr));

    pdfViewer = new pdfjsViewer.PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
      l10n: pdfjsViewer.NullL10n,
      textLayerMode: 1, // enable text selection
      // ENABLE_FORMS renders interactive AcroForm widgets as real inputs and
      // keeps edits in the document's annotationStorage (baked in on save).
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS || 2,
      // Disable PDF.js's own annotation EDITOR (we use our own markup layer).
      // Left enabled, its UIManager is created with a null altTextManager and
      // crashes in destroy() on the second setDocument — which broke switching
      // between open documents (tabs).
      annotationEditorMode: (pdfjsLib.AnnotationEditorType && pdfjsLib.AnnotationEditorType.DISABLE) != null
        ? pdfjsLib.AnnotationEditorType.DISABLE : -1,
      removePageBorders: true,
      maxCanvasPixels // dpr-aware cap (see above) — crisp zoom on large plans
    });
    linkService.setViewer(pdfViewer);
    Viewer._pdfViewer = pdfViewer;
    Viewer._findController = findController;
    Viewer._eventBus = eventBus;

    eventBus.on('pagesinit', () => {
      // On a tab switch we restore the saved zoom + page; on a fresh open we
      // fit to width. `_restore` is set by Viewer._showActive() before setDocument.
      const r = Viewer._restore; Viewer._restore = null;
      if (r) {
        try { if (r.scaleValue) pdfViewer.currentScaleValue = r.scaleValue; } catch (_) { /* ignore */ }
        if (r.page) { try { pdfViewer.currentPageNumber = r.page; } catch (_) { /* ignore */ } }
      } else {
        pdfViewer.currentScaleValue = 'page-width';
      }
      App.state.zoom = cssScale();
      updateZoomLabel();
      Viewer._updateControls(true);
      App.$('#page-total').textContent = String(App.state.numPages);
      App.$('#page-input').value = String((r && r.page) || 1);
    });

    eventBus.on('pagechanging', (e) => {
      App.state.currentPage = e.pageNumber;
      App.$('#page-input').value = String(e.pageNumber);
    });

    eventBus.on('scalechanging', () => {
      App.state.zoom = cssScale();
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
      scheduleOverlays();
    });

    eventBus.on('updatefindmatchescount', (e) => showFindCount(e.matchesCount));
    eventBus.on('updatefindcontrolstate', (e) => showFindCount(e.matchesCount));

    setupWheelZoom(container);
    setupTouchZoom(container);
  };

  // ---- Trackpad pinch + Ctrl/Cmd + scroll-wheel zoom ----
  // In Chromium (Electron) a trackpad pinch is delivered as a `wheel` event
  // with `ctrlKey` set — the same shape as a real Ctrl+wheel — so one handler
  // covers pinch-to-zoom on macOS and Windows precision trackpads as well as
  // Ctrl/Cmd + mouse-wheel. Native visual zoom (which would otherwise swallow
  // these gestures) is disabled in preload.js via setVisualZoomLevelLimits.
  //
  // Listen on `window` in the capture phase so we see the event no matter which
  // inner element (canvas, text layer, annotation layer) is under the cursor,
  // then zoom toward the pointer and swallow the event so no scroll/zoom
  // default also fires.
  function setupWheelZoom(container) {
    window.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain scroll → let it through
      if (!App.state.pdfDoc) return;
      if (!container.contains(e.target)) return; // only over the page area
      e.preventDefault();

      // Normalize delta across wheel modes (0=pixel, 1=line, 2=page). Pinch
      // gestures report small pixel deltas; a mouse notch reports ~100px.
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;       // lines → px
      else if (e.deltaMode === 2) delta *= container.clientHeight; // pages → px

      // Exponential so zoom feels consistent at every scale. Negative delta
      // (scroll up / pinch out) zooms in. Preview via CSS transform; commit the
      // real re-render when the gesture settles.
      const factor = Math.exp(-delta * 0.0025);
      Viewer.zoomPreviewBy(factor, e.clientX, e.clientY);
    }, { passive: false, capture: true });
  }

  // ---- Two-finger pinch-to-zoom (touchscreens) ----
  // On a touch device there is no `wheel` event for a pinch (that would be a
  // native browser page-zoom, which the mobile viewport disables). So drive the
  // same Viewer.zoomByAt from raw touch points: track the distance between two
  // fingers and zoom by its ratio, centered on the gesture midpoint. Single-
  // finger touches are left alone so normal scrolling still works.
  function setupTouchZoom(container) {
    let lastDist = 0;
    const dist = (t) => Math.hypot(
      t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2
    });
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && App.state.pdfDoc) lastDist = dist(e.touches);
    }, { passive: true });
    container.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !App.state.pdfDoc || !lastDist) return;
      e.preventDefault();               // suppress scroll while pinching
      const d = dist(e.touches);
      if (d <= 0) return;
      const m = mid(e.touches);
      Viewer.zoomPreviewBy(d / lastDist, m.x, m.y);
      lastDist = d;
    }, { passive: false });
    const end = (e) => {
      if (e.touches.length < 2) { lastDist = 0; if (Viewer.isZoomPreviewing()) Viewer.commitZoomPreview(); }
    };
    container.addEventListener('touchend', end, { passive: true });
    container.addEventListener('touchcancel', end, { passive: true });
  }

  function updateZoomLabel() {
    App.$('#zoom-label').textContent = `${Math.round(pdfViewer.currentScale * 100)}%`;
  }

  // ---- Rebuild pageEls from the currently-rendered pages, then draw overlays ----
  function syncPageEls() {
    const viewerEl = App.$('#viewer');
    // View rotation applies to every page uniformly (PDF.js pagesRotation).
    const rot = pdfViewer ? (((pdfViewer.pagesRotation || 0) % 360) + 360) % 360 : 0;
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
      // Overlays are drawn in the page's UNROTATED scale-1 viewport space
      // (see the coordinate note at the top of this file). PDF.js re-renders
      // the canvas at `rot`, swapping its on-screen width/height for 90°/270°.
      // Rather than reproject every overlay point, we keep them in unrotated
      // space and rigid-rotate the whole layer to sit on the rotated canvas —
      // exact, because a page rotation is a rigid rotation of the page box.
      const cw = parseFloat(canvas.style.width) || div.clientWidth;
      const ch = parseFloat(canvas.style.height) || div.clientHeight;
      let w = cw, h = ch, tf = '';
      if (rot === 90) { w = ch; h = cw; tf = `translate(${h}px,0) rotate(90deg)`; }
      else if (rot === 180) { w = cw; h = ch; tf = `translate(${w}px,${h}px) rotate(180deg)`; }
      else if (rot === 270) { w = ch; h = cw; tf = `translate(0,${w}px) rotate(270deg)`; }
      layer.style.width = w + 'px';
      layer.style.height = h + 'px';
      layer.style.transformOrigin = '0 0';
      layer.style.transform = tf;
      App.state.pageEls[n - 1] = { holder: layer, overlay: layer, pageDiv: div };
    });
  }

  function refreshOverlays() {
    App.state.zoom = cssScale();
    syncPageEls();
    if (App.Placement) App.Placement.repositionAll();
    if (App.Measure) App.Measure.repositionAll();
    if (App.Markup) App.Markup.repositionAll();
    if (App.DocStamp) App.DocStamp.repositionAll();
  }
  Viewer.refreshOverlays = refreshOverlays;

  // Coalesce bursts of overlay refreshes (e.g. many pages rendering while
  // scrolling fast) into one rebuild per animation frame, so redrawing the
  // markup/measure SVGs never stutters the scroll.
  let _overlayRAF = 0;
  function scheduleOverlays() {
    if (_overlayRAF) return;
    _overlayRAF = requestAnimationFrame(() => { _overlayRAF = 0; refreshOverlays(); });
  }

  // ---- Load a document ----
  // Parse a PDF's bytes with PDF.js. Returns { doc, original } or throws.
  Viewer._parse = async function (arrayBuffer) {
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
    return { doc, original };
  };

  // Read the editable-round-trip attachments from a parsed pdf.js doc.
  // Returns { data, base } when our marks model is present (base may be null),
  // or null when the file has no sidecar.
  Viewer._readSidecar = async function (doc) {
    try {
      const att = await doc.getAttachments();
      if (!att) return null;
      const modelEntry = att[App.SIDECAR.MODEL];
      if (!modelEntry || !modelEntry.content) return null;
      const data = JSON.parse(new TextDecoder().decode(modelEntry.content));
      const baseEntry = att[App.SIDECAR.BASE];
      return { data, base: baseEntry && baseEntry.content ? baseEntry.content : null };
    } catch (_) { return null; }
  };

  // Restore the in-app marks from a serialized model onto fresh state. Called
  // right after _clearState, so it simply repopulates the arrays; the overlay
  // draws them as each page renders.
  Viewer._rehydrate = function (m) {
    if (!m) return;
    const st = App.state;
    st.placements = Array.isArray(m.placements) ? m.placements : [];
    st.measurements = Array.isArray(m.measurements) ? m.measurements : [];
    st.annotations = Array.isArray(m.annotations) ? m.annotations : [];
    st.scales = m.scales && typeof m.scales === 'object' ? m.scales : {};
    st.viewports = m.viewports && typeof m.viewports === 'object' ? m.viewports : {};
    st.saveAnnots = !!m.saveAnnots;
    const maxId = (arr) => arr.reduce((n, o) => Math.max(n, o && o.id || 0), 0);
    const s = m.seqs || {};
    st.placementSeq = Math.max(s.placementSeq || 0, maxId(st.placements));
    st.measureSeq = Math.max(s.measureSeq || 0, maxId(st.measurements));
    st.viewportSeq = s.viewportSeq || 0;
    st.annoSeq = Math.max(s.annoSeq || 0, maxId(st.annotations));
    st.dirty = false;
  };

  // Show the document currently in App.state (its pdfDoc/arrays) in the viewer.
  // `restore` = { scaleValue, page } to reapply on a tab switch (else fit-width).
  Viewer._showActive = function (restore) {
    Viewer.init();
    Viewer._restore = restore || null;
    App.state.pageEls = [];
    App.$('#empty-state').classList.add('hidden');
    App.$('#viewerContainer').classList.add('active');
    document.title = `${App.state.fileName || 'PDF'} — FieldMark`;
    pdfViewer.setDocument(App.state.pdfDoc);
    linkService.setDocument(App.state.pdfDoc, null);
    if (App.Measure) App.Measure.renderPanel();
  };

  // Public open entry point — delegates to the tab manager so every open adds a
  // tab (the first open creates the first tab). Kept as Viewer.load so existing
  // callers (dialog / drop / "Open with") don't change.
  Viewer.load = async function (arrayBuffer, name, filePath) {
    if (App.Tabs) return App.Tabs.open(arrayBuffer, name, filePath);
    // Fallback (no tabs module): original single-document behavior.
    return Viewer._loadInto(arrayBuffer, name, filePath, true);
  };

  // Load bytes into the ACTIVE document (fresh state). Used by the tab manager
  // and by the organizer (which rebuilds the current doc's pages in place).
  Viewer._loadInto = async function (arrayBuffer, name, filePath) {
    Viewer.init();
    App.showLoading('Opening PDF…');
    try {
      let { doc, original } = await Viewer._parse(arrayBuffer);
      // Editable round-trip: if this file carries our sidecar (a marks model + a
      // pristine base), reopen the pristine base as the working document and
      // restore the marks as live objects — so nothing saved here is stuck to
      // the page. Requires the base attachment; without it we'd double-draw the
      // flattened copy, so fall back to opening the file as-is.
      const sidecar = await Viewer._readSidecar(doc);
      if (sidecar && sidecar.base) {
        const reparsed = await Viewer._parse(sidecar.base);
        doc = reparsed.doc; original = reparsed.original;
      }
      Viewer._clearState();
      App.state.pdfDoc = doc;
      App.state.pdfBytes = original;
      App.state.fileName = name || 'document.pdf';
      App.state.filePath = filePath || null;
      App.state.numPages = doc.numPages;
      App.state.currentPage = 1;
      App.state.baseViewports = [];
      if (sidecar && sidecar.base) Viewer._rehydrate(sidecar.data);
      Viewer._showActive(null);
      App.toast(`Opened ${App.state.fileName}`, 'success');
      return true;
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
      return false;
    } finally {
      App.hideLoading();
    }
  };

  // Clear the viewer entirely (no document) and show the empty state.
  Viewer.showEmpty = function () {
    Viewer._clearState();
    App.state.pdfDoc = null;
    App.state.pdfBytes = null;
    App.state.fileName = null;
    App.state.filePath = null;
    App.state.numPages = 0;
    try { if (pdfViewer) pdfViewer.setDocument(null); } catch (_) { /* ignore */ }
    Viewer._updateControls(false);
    App.$('#empty-state').classList.remove('hidden');
    App.$('#viewerContainer').classList.remove('active');
    document.title = 'FieldMark';
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
    App.state.flattenForms = false;
    if (App.Snap) App.Snap.clear(); // page geometry is per-document; drop stale index
    if (App.History) App.History.reset();
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
  // Rotate the whole view by `delta` degrees (default 90°, clockwise). PDF.js
  // reflows the pages; the markup overlay reprojects through the viewport, so
  // placements/measurements stay pinned to the page.
  Viewer.rotate = (delta = 90) => {
    if (!pdfViewer) return;
    pdfViewer.pagesRotation = (((pdfViewer.pagesRotation || 0) + delta) % 360 + 360) % 360;
  };
  // Current view rotation, normalized to 0/90/180/270.
  Viewer.rotation = () => (pdfViewer ? (((pdfViewer.pagesRotation || 0) % 360) + 360) % 360 : 0);

  // Map a pointer event to an unrotated scale-1 viewport point {vx, vy} on the
  // given markup layer. This is the single place that inverts the layer's rigid
  // rotation (see syncPageEls + App.Geom.unrotatePoint), so every click/drag tool
  // — markup, measure, placement, signatures — lands under the pointer at any
  // orientation instead of only at 0°.
  Viewer.pointFromEvent = function (layer, e) {
    const rect = layer.getBoundingClientRect();
    const z = App.state.zoom || 1;
    const lw = parseFloat(layer.style.width) || layer.offsetWidth || rect.width;
    const lh = parseFloat(layer.style.height) || layer.offsetHeight || rect.height;
    return App.Geom.unrotatePoint(
      e.clientX - rect.left, e.clientY - rect.top, lw, lh, Viewer.rotation(), z);
  };
  // Reset to 100% (actual size) — bound to the "0" shortcut.
  Viewer.resetZoom = () => { if (pdfViewer) pdfViewer.currentScale = 1.0; };

  // Zoom to an absolute scale while keeping the content point under (clientX,
  // clientY) visually fixed. Used by trackpad pinch / Ctrl+wheel so the page
  // zooms toward the cursor instead of the top-left corner.
  Viewer.zoomToAt = function (targetScale, clientX, clientY) {
    if (!pdfViewer) return;
    const container = App.$('#viewerContainer');
    const oldScale = pdfViewer.currentScale;
    const newScale = App.clamp(targetScale, ZOOM_MIN, ZOOM_MAX);
    if (newScale === oldScale) return;

    // Anchor point in scrollable-content coordinates (pre-zoom).
    const rect = container.getBoundingClientRect();
    const offsetX = (clientX == null ? rect.width / 2 : clientX - rect.left);
    const offsetY = (clientY == null ? rect.height / 2 : clientY - rect.top);
    const contentX = container.scrollLeft + offsetX;
    const contentY = container.scrollTop + offsetY;

    pdfViewer.currentScale = newScale;

    // After scaling, the same content grows by ratio; shift scroll so the
    // anchor stays under the cursor.
    const ratio = pdfViewer.currentScale / oldScale;
    container.scrollLeft = contentX * ratio - offsetX;
    container.scrollTop = contentY * ratio - offsetY;
  };

  // Multiply the current scale by `factor`, anchored at the cursor.
  Viewer.zoomByAt = function (factor, clientX, clientY) {
    if (!pdfViewer) return;
    Viewer.zoomToAt(pdfViewer.currentScale * factor, clientX, clientY);
  };

  // ---- Smooth (preview) zoom ----
  // Re-rasterizing every PDF page on every wheel/pinch tick is what makes zoom
  // stutter. Instead, during the gesture we apply a cheap GPU-composited CSS
  // transform to the page container for instant feedback, and only commit the
  // real (crisp) re-render once the gesture settles. The markup/text overlays
  // live inside #viewer, so they scale with the transform for free.
  let _zoom = null; // { base, scale, ox, oy, cx, cy, timer }

  Viewer.zoomPreviewBy = function (factor, clientX, clientY) {
    if (!pdfViewer) return;
    const container = App.$('#viewerContainer');
    const viewerEl = App.$('#viewer');
    if (!_zoom) {
      const rect = container.getBoundingClientRect();
      const cx = clientX == null ? rect.width / 2 : clientX - rect.left;
      const cy = clientY == null ? rect.height / 2 : clientY - rect.top;
      _zoom = {
        base: pdfViewer.currentScale, scale: 1,
        // transform-origin fixed at the gesture's start point (in #viewer space)
        ox: container.scrollLeft + cx, oy: container.scrollTop + cy,
        cx: clientX, cy: clientY, timer: 0
      };
      viewerEl.style.transformOrigin = _zoom.ox + 'px ' + _zoom.oy + 'px';
      viewerEl.style.willChange = 'transform';
    }
    const target = App.clamp(_zoom.base * _zoom.scale * factor, ZOOM_MIN, ZOOM_MAX);
    _zoom.scale = target / _zoom.base;
    viewerEl.style.transform = 'scale(' + _zoom.scale + ')';
    App.$('#zoom-label').textContent = Math.round(_zoom.base * _zoom.scale * 100) + '%';
    clearTimeout(_zoom.timer);
    _zoom.timer = setTimeout(Viewer.commitZoomPreview, 140);
  };

  // Drop the preview transform and apply the real scale (one crisp re-render),
  // anchored at the gesture's start point so there's no visible jump.
  Viewer.commitZoomPreview = function () {
    if (!_zoom) return;
    const p = _zoom; _zoom = null;
    clearTimeout(p.timer);
    const viewerEl = App.$('#viewer');
    viewerEl.style.transform = '';
    viewerEl.style.transformOrigin = '';
    viewerEl.style.willChange = '';
    Viewer.zoomToAt(App.clamp(p.base * p.scale, ZOOM_MIN, ZOOM_MAX), p.cx, p.cy);
  };
  Viewer.isZoomPreviewing = () => !!_zoom;

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
    ['#btn-select', '#btn-sign', '#btn-initials', '#btn-date', '#btn-measure', '#btn-markup',
     '#btn-document',
     '#btn-zoom-out', '#btn-zoom-in', '#btn-fit-width', '#btn-rotate', '#btn-prev', '#btn-next',
     '#btn-save', '#btn-save-as', '#page-input']
      .forEach((s) => { const el = App.$(s); if (el) el.disabled = !enabled; });
    // Select is the resting/default tool: highlight it whenever a document is
    // open and no drawing tool is armed. setMode() keeps it in sync afterwards.
    const sel = App.$('#btn-select');
    if (sel) sel.classList.toggle('armed', !!enabled && !App.state.mode);
  };

  App.Viewer = Viewer;
})();
