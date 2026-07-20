'use strict';

/*
 * Document Overlay — superimpose two PDFs one on top of the other.
 *
 * Where Compare produces a red/blue *difference* map, Overlay reproduces
 * Bluebeam's "Overlay Pages": both documents are drawn on the same page, each
 * tinted its own color, and multiply-blended. Shared linework lands on top of
 * itself and reads dark; content unique to one revision shows in that layer's
 * color. Per-layer color, opacity and visibility let you fade one drawing under
 * the other to check alignment — exactly the field use case for revision A vs B.
 *
 * Renderer-only (PDF.js + canvas), so it ships to Windows, macOS and Android
 * from the one implementation, like Compare.
 */
(function () {
  const O = {};
  const $ = (s) => App.$(s);
  const pdfjs = () => window.pdfjsLib;
  const TARGET_W = 900;

  let docA = null, docB = null, nameA = '', nameB = '';
  // The PDF.js document Overlay itself opened (document B before any swap). Only
  // this one is ours to destroy on close — docA/docB get swapped by the Swap
  // button, and the open viewer's document must never be torn down here.
  let ownDoc = null;
  let pageNum = 1, maxPages = 1, busy = false;
  // Zoom state (mirrors compare.js): fitMode scales the page to the window;
  // zooming switches to a fixed display scale relative to the composited canvas.
  let curCanvas = null, zoom = 1, fitMode = true;
  const MIN_ZOOM = 0.1, MAX_ZOOM = 8, ZOOM_STEP = 1.2;

  // Cached source renders for the current page, so tweaking a color/opacity
  // slider recomposites instantly without re-rasterizing the PDFs.
  let srcA = null, srcB = null, srcPage = 0;

  function fitScale(cv) {
    const host = $('#ovl-view');
    if (!host || !cv || !cv.width || !cv.height) return 1;
    const cs = getComputedStyle(host);
    const availW = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 0 || availH <= 0) return 1;
    return Math.min(availW / cv.width, availH / cv.height);
  }

  function applyZoom() {
    const cv = curCanvas;
    if (!cv) return;
    if (fitMode) zoom = fitScale(cv);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    cv.style.maxWidth = 'none';
    cv.style.width = Math.round(cv.width * zoom) + 'px';
    cv.style.height = 'auto';
    const lbl = $('#ovl-zoom'); if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
    const fitBtn = $('#ovl-fit'); if (fitBtn) fitBtn.classList.toggle('active', fitMode);
  }

  function setZoom(next) { fitMode = false; zoom = next; applyZoom(); }

  async function renderPage(doc, n) {
    if (!doc || n < 1 || n > doc.numPages) return null;
    const page = await doc.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: TARGET_W / v1.width });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width);
    cv.height = Math.ceil(vp.height);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    return cv;
  }

  // Luminance; transparent pixels count as white (blank).
  function lum(d, i) { return d[i + 3] === 0 ? 255 : 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; }

  function dataOf(cv, w, h) {
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    const c = t.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
    if (cv) c.drawImage(cv, 0, 0);
    return c.getImageData(0, 0, w, h).data;
  }

  function hexRGB(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
  }

  function opts() {
    return {
      aOn: $('#ovl-a-on').checked, bOn: $('#ovl-b-on').checked,
      aColor: hexRGB($('#ovl-a-color').value), bColor: hexRGB($('#ovl-b-color').value),
      aOp: (parseInt($('#ovl-a-opacity').value, 10) || 100) / 100,
      bOp: (parseInt($('#ovl-b-opacity').value, 10) || 100) / 100
    };
  }

  // Multiply-blend two tinted ink layers over white. `ink` is 0..1 darkness of a
  // source pixel; coverage = ink × opacity; each layer multiplies the running
  // color toward its tint, so overlapping ink darkens (shared → near-black) while
  // unique ink stays its layer's color.
  function buildOverlay(cvA, cvB, o) {
    const w = Math.max(cvA ? cvA.width : 1, cvB ? cvB.width : 1);
    const h = Math.max(cvA ? cvA.height : 1, cvB ? cvB.height : 1);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const a = dataOf(cvA, w, h), b = dataOf(cvB, w, h);
    const img = octx.createImageData(w, h);
    const d = img.data;
    let overlap = 0, unique = 0;
    const useA = o.aOn && cvA, useB = o.bOn && cvB;
    for (let i = 0; i < d.length; i += 4) {
      const inkA = useA ? (255 - lum(a, i)) / 255 : 0;
      const inkB = useB ? (255 - lum(b, i)) / 255 : 0;
      const covA = inkA * o.aOp, covB = inkB * o.bOp;
      const hasA = inkA > 0.18, hasB = inkB > 0.18;
      if (hasA && hasB) overlap++;
      else if (hasA || hasB) unique++;
      for (let c = 0; c < 3; c++) {
        // start white, multiply each layer's tint in
        let v = 255;
        v = v * (1 - covA * (1 - o.aColor[c] / 255));
        v = v * (1 - covB * (1 - o.bColor[c] / 255));
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      d[i + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return { canvas: out, overlap, unique };
  }

  function note(text) {
    const el = document.createElement('div');
    el.className = 'cmp-note';
    el.textContent = text;
    return el;
  }

  // Recomposite only (colors/opacity/visibility changed) — reuses cached renders.
  function recomposite() {
    const host = $('#ovl-view');
    if (!host || !srcA && !srcB || srcPage !== pageNum) return;
    const { canvas, overlap, unique } = buildOverlay(srcA, srcB, opts());
    host.innerHTML = '';
    if (!srcA) host.appendChild(note(`Document A has no page ${pageNum}.`));
    if (!srcB) host.appendChild(note(`Document B has no page ${pageNum}.`));
    host.appendChild(canvas);
    curCanvas = canvas;
    applyZoom();
    $('#ovl-hint').textContent = (srcA && srcB)
      ? `${overlap.toLocaleString()} px overlap · ${unique.toLocaleString()} px unique`
      : '';
  }

  async function renderCurrent() {
    const host = $('#ovl-view');
    if (!host || busy) return;
    busy = true;
    host.textContent = 'Rendering…';
    try {
      const [ca, cb] = await Promise.all([renderPage(docA, pageNum), renderPage(docB, pageNum)]);
      srcA = ca; srcB = cb; srcPage = pageNum;
      recomposite();
      $('#ovl-page').textContent = `Page ${pageNum} of ${maxPages}`;
      $('#ovl-prev').disabled = pageNum <= 1;
      $('#ovl-next').disabled = pageNum >= maxPages;
    } catch (e) {
      host.textContent = 'Could not render this page: ' + (e && e.message);
    } finally {
      busy = false;
    }
  }

  function refreshNames() {
    $('#ovl-a-name').textContent = 'A: ' + (nameA || 'current');
    $('#ovl-b-name').textContent = 'B: ' + (nameB || 'chosen file');
  }

  // Load `data` (PDF bytes) as document B alongside the open document as A, and
  // show the overlay. Split out from open() so it can be driven without the file
  // dialog (the e2e smoke harness relies on this).
  O.overlayData = async function (data, name) {
    docA = App.state.pdfDoc;
    nameA = App.state.fileName || '';
    docB = ownDoc = await pdfjs().getDocument({ data: new Uint8Array(data) }).promise;
    nameB = name || '';
    maxPages = Math.max(docA.numPages, docB.numPages);
    pageNum = 1;
    fitMode = true; zoom = 1; curCanvas = null; srcA = srcB = null; srcPage = 0;
    refreshNames();
    $('#overlay-modal').classList.remove('hidden');
    await renderCurrent();
  };

  O.open = async function () {
    if (!App.state.pdfDoc) { App.toast('Open a PDF first — it becomes document A.', 'error'); return; }
    const res = await window.api.openPdfDialog();
    if (!res) return;
    if (!res.ok) { App.toast('Could not read the overlay file: ' + (res.error || ''), 'error'); return; }
    try {
      await O.overlayData(res.data, res.name);
    } catch (e) {
      App.toast('Could not open the overlay file: ' + (e && e.message), 'error', 5000);
    }
  };

  O.close = function () {
    $('#overlay-modal').classList.add('hidden');
    // Destroy only the document Overlay opened — never App.state.pdfDoc, which
    // may currently sit in docA or docB after a Swap.
    if (ownDoc && ownDoc.destroy) { try { ownDoc.destroy(); } catch (_) { /* ignore */ } }
    docA = docB = ownDoc = null; srcA = srcB = null;
    const host = $('#ovl-view'); if (host) host.innerHTML = '';
  };

  O.init = function () {
    const wire = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    wire('#ovl-close', 'click', O.close);
    wire('#ovl-done', 'click', O.close);
    wire('#ovl-prev', 'click', () => { if (pageNum > 1) { pageNum--; renderCurrent(); } });
    wire('#ovl-next', 'click', () => { if (pageNum < maxPages) { pageNum++; renderCurrent(); } });
    wire('#ovl-fit', 'click', () => { fitMode = true; applyZoom(); });
    wire('#ovl-zoom-in', 'click', () => setZoom(zoom * ZOOM_STEP));
    wire('#ovl-zoom-out', 'click', () => setZoom(zoom / ZOOM_STEP));
    wire('#ovl-swap', 'click', () => {
      [docA, docB] = [docB, docA];
      [nameA, nameB] = [nameB, nameA];
      refreshNames();
      srcA = srcB = null; srcPage = 0;
      renderCurrent();
    });
    // Live re-tint: color/opacity/visibility changes recomposite from cache.
    ['#ovl-a-on', '#ovl-b-on', '#ovl-a-color', '#ovl-b-color'].forEach((id) => wire(id, 'input', recomposite));
    ['#ovl-a-opacity', '#ovl-b-opacity'].forEach((id) => wire(id, 'input', recomposite));
    window.addEventListener('resize', () => { if (fitMode) applyZoom(); });
  };

  App.Overlay = O;
})();
