'use strict';

/*
 * Apply Redactions — Revu's Document > Apply Redactions, done honestly.
 *
 * Drawing a black box over text does not remove the text: it is still in the
 * file and can be copied out. The only reliable removal without a commercial
 * PDF engine is to rasterize each page that carries a redaction mark: render it
 * with PDF.js, paint the marked areas solid black on the bitmap, and replace
 * the page with that image. Text, vectors, images and annotations under the
 * marks are then genuinely gone.
 *
 * The output document is BUILT FRESH: untouched pages are copied across with
 * pdf-lib's copyPages, which brings only what those pages reference. Editing
 * the original in place would leave the replaced page's objects (and the text
 * in its content stream) sitting in the file, unreferenced but recoverable.
 * The cost, stated in the confirm dialog: the original file's own bookmarks
 * and form-field tree do not carry over, and redacted pages lose selectable
 * text. FieldMark's own marks and bookmarks are kept and saved as usual.
 */
(function () {
  const R = {};
  const DPI = 200;
  const MAX_PX = 8000;

  R.marks = () => (App.state.annotations || []).filter((a) => a.type === 'redact');

  // Rasterize one page with the given redaction boxes (scale-1 viewport
  // points) burned in black. Returns { png: Uint8Array, width, height } in
  // points (the page's displayed size, its own /Rotate applied).
  R.rasterizePage = async function (pdfJsDoc, pageNo, boxes) {
    const page = await pdfJsDoc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(DPI / 72, MAX_PX / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const lib = window.pdfjsLib || {};
    const mode = lib.AnnotationMode ? lib.AnnotationMode.ENABLE_STORAGE : undefined;
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: mode }).promise;
    ctx.fillStyle = '#000000';
    boxes.forEach((b) => ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale));
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const png = new Uint8Array(await blob.arrayBuffer());
    canvas.width = canvas.height = 0; // release the bitmap now, not at GC
    return { png, width: base.width, height: base.height };
  };

  // Build the redacted document bytes from App.state.pdfBytes.
  R.buildBytes = async function (marks) {
    const { PDFDocument } = window.PDFLib;
    const byPage = {};
    marks.forEach((m) => { (byPage[m.page] = byPage[m.page] || []).push(App.Geom.bbox(m.pts)); });
    const src = await PDFDocument.load(App.state.pdfBytes);
    const out = await PDFDocument.create();
    const n = src.getPageCount();
    const keepIdx = [];
    for (let i = 0; i < n; i++) if (!byPage[i + 1]) keepIdx.push(i);
    const kept = keepIdx.length ? await out.copyPages(src, keepIdx) : [];
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!byPage[i + 1]) { out.addPage(kept[k++]); continue; }
      const r = await R.rasterizePage(App.state.pdfDoc, i + 1, byPage[i + 1]);
      const img = await out.embedPng(r.png);
      const pg = out.addPage([r.width, r.height]);
      pg.drawImage(img, { x: 0, y: 0, width: r.width, height: r.height });
    }
    try { const t = src.getTitle(); if (t) out.setTitle(t); } catch (_) { /* no title */ }
    out.setProducer('FieldMark (redacted)');
    return { bytes: await out.save(), pages: Object.keys(byPage).map(Number).sort((a, b) => a - b) };
  };

  // Swap the redacted document into the tab, keeping every other mark
  // editable (same approach as OCR's swapIn).
  async function swapIn(bytes) {
    const model = App.Save.serializeModel();
    delete model.__count;
    model.annotations = (model.annotations || []).filter((a) => a.type !== 'redact');
    const name = App.state.fileName || 'document.pdf';
    const filePath = App.state.filePath;
    const ok = App.Tabs
      ? await App.Tabs.replaceActive(bytes.buffer, name, filePath)
      : await App.Viewer._loadInto(bytes.buffer, name, filePath);
    if (!ok) throw new Error('could not reopen the redacted document');
    App.Viewer._rehydrate(model);
    App.Viewer.refreshOverlays();
    if (App.Tabs && App.Tabs.snapshotActive) App.Tabs.snapshotActive();
    App.state.dirty = true;
    if (App.refreshDirtyIndicator) App.refreshDirtyIndicator();
    const save = App.$('#btn-save');
    if (save) save.disabled = false;
  }

  R.apply = async function (opts) {
    const o = opts || {};
    const marks = R.marks();
    if (!marks.length) {
      App.toast('No redaction marks. Use Markup > Mark for Redaction to draw boxes over what to remove.', 'info', 5000);
      return false;
    }
    const pages = Array.from(new Set(marks.map((m) => m.page))).sort((a, b) => a - b);
    if (!o.skipConfirm) {
      const ok = await App.confirm(
        `Permanently remove everything under ${marks.length} redaction mark${marks.length === 1 ? '' : 's'} on page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}? ` +
        'Those pages become images: their text can no longer be selected or searched. ' +
        "The original file's own bookmarks and form fields are not carried over. " +
        'This cannot be undone, but nothing is written to disk until you save.',
        { title: 'Apply redactions', okLabel: 'Redact', danger: true });
      if (!ok) return false;
    }
    try {
      App.toast('Applying redactions…', 'info', 2500);
      const built = await R.buildBytes(marks);
      await swapIn(built.bytes);
      App.toast(`Redacted ${built.pages.length} page${built.pages.length === 1 ? '' : 's'}. Save to write the redacted file.`, 'success', 6000);
      return true;
    } catch (e) {
      App.toast('Could not apply redactions: ' + (e && e.message), 'error', 8000);
      return false;
    }
  };

  App.Redact = R;
})();
