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

  function gutPage(doc, page) {
    const { PDFName } = window.PDFLib;
    const node = page.node;
    node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('')));
    node.set(PDFName.of('Resources'), doc.context.obj({}));
    ['Annots', 'Thumb', 'PieceInfo', 'Metadata', 'StructParents', 'B', 'AA', 'Group'].forEach((k) => node.delete(PDFName.of(k)));
  }
  R._gutPage = gutPage;

  // Is box `inner` (x,y,w,h) entirely inside box `outer`?
  function inside(inner, outer) {
    return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 &&
      inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
  }
  // FieldMark's own marks that sit wholly under a redaction box go too, the
  // way Revu removes markups inside a redaction area: a text box or comment
  // saved on top of the burned-out image would put the secret straight back.
  R.dropCovered = function (model, marks) {
    const boxes = {};
    marks.forEach((m) => { (boxes[m.page] = boxes[m.page] || []).push(App.Geom.bbox(m.pts)); });
    const covered = (page, b) => (boxes[page] || []).some((o) => inside(b, o));
    const annBox = (a) => {
      if (a.quads && a.quads.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        a.quads.forEach((q) => { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x + q.w); y1 = Math.max(y1, q.y + q.h); });
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      if (a.type === 'note') return { x: a.pts[0].vx, y: a.pts[0].vy, w: 22, h: 22 };
      return App.Geom.bbox(a.pts || []);
    };
    let dropped = 0;
    const keep = (arr, boxOf) => (arr || []).filter((x) => { const c = covered(x.page, boxOf(x)); if (c) dropped++; return !c; });
    model.annotations = keep((model.annotations || []).filter((a) => a.type !== 'redact'), annBox);
    model.placements = keep(model.placements, (p) => ({ x: p.vx, y: p.vy, w: p.vw, h: p.vh }));
    model.measurements = keep(model.measurements, (m) => App.Geom.bbox(m.pts || []));
    return dropped;
  };

  // Destination arrays are [page /Fit ...]. Swap the page reference for its
  // index (and back), and drop annotation /P back-pointers, which the copy
  // would otherwise follow to clone whole pages.
  const FITS = { XYZ: 1, Fit: 1, FitH: 1, FitV: 1, FitR: 1, FitB: 1, FitBH: 1, FitBV: 1 };
  function eachContainer(doc, fn) {
    const { PDFDict, PDFArray } = window.PDFLib;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const seen = new Set();
      const walk = (o) => {
        if (!o || seen.has(o)) return;
        seen.add(o);
        if (o instanceof PDFArray) { fn(o); o.asArray().forEach(walk); }
        else if (o instanceof PDFDict) { fn(o); for (const [, v] of o.entries()) walk(v); }
        else if (o.dict instanceof PDFDict) walk(o.dict);
      };
      walk(obj);
    }
  }
  function isDest(arr) {
    const { PDFName } = window.PDFLib;
    const a = arr.asArray();
    return a.length >= 2 && a[1] instanceof PDFName && FITS[a[1].decodeText ? a[1].decodeText() : String(a[1]).slice(1)];
  }
  function unpinDestinations(doc, pageRefs) {
    const { PDFArray, PDFDict, PDFNumber, PDFName, PDFRef } = window.PDFLib;
    const index = new Map(pageRefs.map((r, i) => [r.toString(), i]));
    eachContainer(doc, (o) => {
      if (o instanceof PDFArray && isDest(o)) {
        const first = o.get(0);
        if (first instanceof PDFRef && index.has(first.toString())) o.set(0, PDFNumber.of(index.get(first.toString())));
      } else if (o instanceof PDFDict && o.get(PDFName.of('Type')) !== PDFName.of('Page')) {
        const pRef = o.get(PDFName.of('P'));
        if (pRef instanceof PDFRef && index.has(pRef.toString())) o.delete(PDFName.of('P'));
      }
    });
  }
  function repinDestinations(doc, pageRefs) {
    const { PDFArray, PDFNumber } = window.PDFLib;
    eachContainer(doc, (o) => {
      if (o instanceof PDFArray && isDest(o)) {
        const first = o.get(0);
        if (first instanceof PDFNumber) {
          const i = first.asNumber();
          if (pageRefs[i]) o.set(0, pageRefs[i]);
        }
      }
    });
  }
  R._unpin = unpinDestinations;

  // Build the redacted document bytes from App.state.pdfBytes.
  R.buildBytes = async function (marks) {
    const { PDFDocument } = window.PDFLib;
    const byPage = {};
    marks.forEach((m) => { (byPage[m.page] = byPage[m.page] || []).push(App.Geom.bbox(m.pts)); });
    const src = await PDFDocument.load(App.state.pdfBytes);
    const n = src.getPageCount();
    // Each redacted page is turned into its image IN PLACE in the source:
    // gutted (contents, resources, annotations, thumbnails all dropped), resized
    // to its displayed box with no rotation, and the burned-in bitmap drawn on
    // it. Done in place rather than as a new page so every reference to it --
    // a sheet-index link's /Dest on another page, a GoTo action, a field's /P
    // -- still lands on the right page instead of dragging the original page
    // object (and the text under the black box) into the output.
    for (let i = 0; i < n; i++) {
      if (!byPage[i + 1]) continue;
      const r = await R.rasterizePage(App.state.pdfDoc, i + 1, byPage[i + 1]);
      const page = src.getPage(i);
      gutPage(src, page);
      const { PDFName, degrees } = window.PDFLib;
      ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox'].forEach((k) => page.node.delete(PDFName.of(k)));
      page.setMediaBox(0, 0, r.width, r.height);
      page.setRotation(degrees(0));
      const img = await src.embedPng(r.png);
      page.drawImage(img, { x: 0, y: 0, width: r.width, height: r.height });
    }
    // Then copy every page into a fresh document. copyPages brings only what
    // the pages reference, so the gutted content streams (now unreferenced)
    // and anything else that hung off the old pages stay behind.
    //
    // pdf-lib copies each page by cloning it without recording the clone, so a
    // link whose destination names another page would get a SECOND, orphan
    // copy of that page and jump to it instead of the real one. Destinations
    // are therefore swapped to page numbers before the copy and back to the
    // copied pages after it.
    const srcRefs = src.getPages().map((pg) => pg.ref);
    unpinDestinations(src, srcRefs);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((pg) => out.addPage(pg));
    repinDestinations(out, out.getPages().map((pg) => pg.ref));
    try { const t = src.getTitle(); if (t) out.setTitle(t); } catch (_) { /* no title */ }
    out.setProducer('FieldMark (redacted)');
    return { bytes: await out.save(), pages: Object.keys(byPage).map(Number).sort((a, b) => a - b) };
  };

  // Swap the redacted document into the tab, keeping every other mark
  // editable (same approach as OCR's swapIn).
  async function swapIn(bytes, marks) {
    const model = App.Save.serializeModel();
    delete model.__count;
    R.dropCovered(model, marks);
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
        "The original file's own bookmarks and form fields are not carried over, and FieldMark markups lying entirely inside a box are removed too. " +
        'This cannot be undone, but nothing is written to disk until you save.',
        { title: 'Apply redactions', okLabel: 'Redact', danger: true });
      if (!ok) return false;
    }
    try {
      App.toast('Applying redactions…', 'info', 2500);
      const built = await R.buildBytes(marks);
      await swapIn(built.bytes, marks);
      App.toast(`Redacted ${built.pages.length} page${built.pages.length === 1 ? '' : 's'}. Save to write the redacted file.`, 'success', 6000);
      return true;
    } catch (e) {
      App.toast('Could not apply redactions: ' + (e && e.message), 'error', 8000);
      return false;
    }
  };

  App.Redact = R;
})();
