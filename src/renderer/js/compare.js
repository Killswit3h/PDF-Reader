'use strict';

/*
 * Document Compare — overlay two PDFs page-by-page and highlight the differences.
 *
 * Renders matching pages of document A (the one open in the viewer) and a
 * chosen document B to canvases at the same width, then composites a per-pixel
 * overlay: shared content is gray, content only in A is red, content only in B
 * is blue. Renderer-only (PDF.js + canvas), so it ships to all three platforms.
 *
 * This is a pixel overlay, not content-aware alignment — it's most useful for
 * comparing revisions of the same drawing/layout (the common case), where a
 * shift is a real change. Very different page layouts will show as mostly
 * colored; that's expected.
 */
(function () {
  const C = {};
  const $ = (s) => App.$(s);
  const pdfjs = () => window.pdfjsLib;
  const TARGET_W = 900;

  let docA = null, docB = null, pageNum = 1, maxPages = 1, busy = false;

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

  function buildDiff(cvA, cvB) {
    const w = Math.max(cvA ? cvA.width : 1, cvB ? cvB.width : 1);
    const h = Math.max(cvA ? cvA.height : 1, cvB ? cvB.height : 1);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const a = dataOf(cvA, w, h), b = dataOf(cvB, w, h);
    const o = octx.createImageData(w, h);
    let changed = 0;
    for (let i = 0; i < o.data.length; i += 4) {
      const aDark = lum(a, i) < 210, bDark = lum(b, i) < 210;
      let r = 255, g = 255, bl = 255;
      if (aDark && bDark) { r = g = bl = 168; }                    // shared → gray
      else if (aDark && !bDark) { r = 228; g = 52; bl = 52; changed++; }  // only in A → red
      else if (!aDark && bDark) { r = 44; g = 110; bl = 228; changed++; } // only in B → blue
      o.data[i] = r; o.data[i + 1] = g; o.data[i + 2] = bl; o.data[i + 3] = 255;
    }
    octx.putImageData(o, 0, 0);
    return { canvas: out, changed };
  }

  async function renderCurrent() {
    const host = $('#cmp-view');
    if (!host || busy) return;
    busy = true;
    host.textContent = 'Rendering…';
    try {
      const [ca, cb] = await Promise.all([renderPage(docA, pageNum), renderPage(docB, pageNum)]);
      const { canvas, changed } = buildDiff(ca, cb);
      host.innerHTML = '';
      if (!ca) host.appendChild(note(`Document A has no page ${pageNum}.`));
      if (!cb) host.appendChild(note(`Document B has no page ${pageNum}.`));
      host.appendChild(canvas);
      $('#cmp-page').textContent = `Page ${pageNum} of ${maxPages}`;
      $('#cmp-changed').textContent = changed ? `${changed.toLocaleString()} pixels differ` : 'No differences on this page';
      $('#cmp-prev').disabled = pageNum <= 1;
      $('#cmp-next').disabled = pageNum >= maxPages;
    } catch (e) {
      host.textContent = 'Could not render this page: ' + (e && e.message);
    } finally {
      busy = false;
    }
  }

  function note(text) {
    const d = document.createElement('div');
    d.className = 'cmp-note';
    d.textContent = text;
    return d;
  }

  C.open = async function () {
    if (!App.state.pdfDoc) { App.toast('Open a PDF first — it becomes document A.', 'error'); return; }
    const res = await window.api.openPdfDialog();
    if (!res) return;
    if (!res.ok) { App.toast('Could not read the comparison file: ' + (res.error || ''), 'error'); return; }
    try {
      docA = App.state.pdfDoc;
      docB = await pdfjs().getDocument({ data: new Uint8Array(res.data) }).promise;
      maxPages = Math.max(docA.numPages, docB.numPages);
      pageNum = 1;
      $('#cmp-names').textContent = `A: ${App.state.fileName || 'current'}  ·  B: ${res.name || 'chosen file'}`;
      $('#compare-modal').classList.remove('hidden');
      await renderCurrent();
    } catch (e) {
      App.toast('Could not open the comparison file: ' + (e && e.message), 'error', 5000);
    }
  };

  C.close = function () {
    $('#compare-modal').classList.add('hidden');
    if (docB && docB.destroy) { try { docB.destroy(); } catch (_) { /* ignore */ } }
    docA = null; docB = null;
    const host = $('#cmp-view'); if (host) host.innerHTML = '';
  };

  C.init = function () {
    const wire = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    wire('#cmp-close', C.close);
    wire('#cmp-done', C.close);
    wire('#cmp-prev', () => { if (pageNum > 1) { pageNum--; renderCurrent(); } });
    wire('#cmp-next', () => { if (pageNum < maxPages) { pageNum++; renderCurrent(); } });
  };

  App.Compare = C;
})();
