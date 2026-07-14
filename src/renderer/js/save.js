'use strict';

/*
 * Export the signed PDF with pdf-lib.
 *
 * Coordinate mapping (the important bit)
 * --------------------------------------
 * Placements are stored in *scale-1 viewport points*, top-left origin
 * (vx, vy, vw, vh). pdf-lib draws in PDF user space, bottom-left origin.
 * Instead of hand-rolling the flip (and getting page rotation wrong), we
 * reuse PDF.js's own transform: viewport.convertToPdfPoint(x, y) maps any
 * viewport point straight into PDF user space for ANY page rotation.
 *
 * For an on-screen axis-aligned box we map three corners:
 *   A = top-left     (vx,       vy)
 *   B = bottom-left  (vx,       vy+vh)   -> image/text anchor (lower-left)
 *   C = bottom-right (vx+vw,    vy+vh)
 * Then:
 *   width  = |C - B|   (distance in user space along the on-screen x axis)
 *   height = |A - B|
 *   angle  = atan2(C.y-B.y, C.x-B.x)   (CCW from user-space +x)
 * For an unrotated page this reduces to the textbook flip
 *   x = vx,  y = pageHeight - vy - vh,  angle = 0.
 */
(function () {
  const S = {};

  function dataUrlToBytes(dataUrl) {
    const b64 = dataUrl.split(',')[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  const angleDeg = (p, q) =>
    (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;

  const M_COLORS = {
    length: '#2f6fed', perimeter: '#7b61ff', area: '#21a366',
    angle: '#d1348c', count: '#e5a300'
  };
  function hexRgb(hex) {
    const { rgb } = window.PDFLib;
    const n = parseInt(hex.slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  function hexArr(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  // Write a standard PDF annotation dictionary (interoperable/editable) instead
  // of flattening. Geometry via convertToPdfPoint. Verified structurally by
  // re-parsing with PDF.js (subtype + rect); validate visual fidelity in Acrobat.
  function writeRealAnnot(pdfDoc, page, an, vp) {
    const { PDFName, PDFArray, PDFNumber, PDFString } = window.PDFLib;
    const ctx = pdfDoc.context;
    const s = an.style || {};
    // Freehand ink/highlight export the same curve-fit points the screen shows.
    const src = (App.Markup && App.Markup.smoothStroke) ? App.Markup.smoothStroke(an) : an.pts;
    const P = src.map((pt) => vp.convertToPdfPoint(pt.vx, pt.vy));
    const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
    const rect = [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2];
    const col = hexArr(s.stroke || '#e5484d');
    // Highlighter exports as a wide Ink stroke; everything else uses its style width.
    const hlWidth = (App.Markup && App.Markup.highlightWidth) ? App.Markup.highlightWidth(s) : Math.max(10, (s.width || 2) * 6);
    const width = an.type === 'highlight' ? hlWidth : (s.width || 2);
    const op = s.opacity == null ? 1 : s.opacity;
    const hasFill = s.fill && s.fill !== 'none';
    const numArr = (arr) => { const a = PDFArray.withContext(ctx); arr.forEach((n) => a.push(PDFNumber.of(n))); return a; };
    const nameArr = (arr) => { const a = PDFArray.withContext(ctx); arr.forEach((n) => a.push(PDFName.of(n))); return a; };
    const d = ctx.obj({});
    const set = (k, v) => d.set(PDFName.of(k), v);
    set('Type', PDFName.of('Annot'));
    set('Rect', numArr(rect));
    set('C', numArr(col));
    if (op < 1) set('CA', PDFNumber.of(op));
    const bs = ctx.obj({}); bs.set(PDFName.of('W'), PDFNumber.of(width)); set('BS', bs);

    switch (an.type) {
      case 'rect':
        set('Subtype', PDFName.of('Square'));
        if (hasFill) set('IC', numArr(hexArr(s.fill)));
        break;
      case 'ellipse':
        set('Subtype', PDFName.of('Circle'));
        if (hasFill) set('IC', numArr(hexArr(s.fill)));
        break;
      case 'line': case 'arrow':
        set('Subtype', PDFName.of('Line'));
        set('L', numArr([P[0][0], P[0][1], P[1][0], P[1][1]]));
        if (an.type === 'arrow') set('LE', nameArr(['None', 'OpenArrow']));
        break;
      case 'polyline':
        set('Subtype', PDFName.of('PolyLine'));
        set('Vertices', numArr([].concat.apply([], P)));
        break;
      case 'polygon': case 'cloud':
        set('Subtype', PDFName.of('Polygon'));
        set('Vertices', numArr([].concat.apply([], P)));
        if (hasFill) set('IC', numArr(hexArr(s.fill)));
        if (an.type === 'cloud') { const be = ctx.obj({}); be.set(PDFName.of('S'), PDFName.of('C')); be.set(PDFName.of('I'), PDFNumber.of(2)); set('BE', be); }
        break;
      case 'ink': case 'highlight': {
        // Freehand ink and the freehand highlighter both round-trip as Ink
        // annotations; the highlighter just rides on the wide BS width + 0.35 CA.
        set('Subtype', PDFName.of('Ink'));
        const list = PDFArray.withContext(ctx); list.push(numArr([].concat.apply([], P))); set('InkList', list);
        if (an.type === 'highlight') set('CA', PDFNumber.of(0.35));
        break;
      }
      case 'text': case 'callout': {
        set('Subtype', PDFName.of('FreeText'));
        const size = s.fontSize || 14;
        set('DA', PDFString.of(`/Helv ${size} Tf ${col[0].toFixed(3)} ${col[1].toFixed(3)} ${col[2].toFixed(3)} rg`));
        set('Contents', PDFString.of(an.text || ''));
        if (an.type === 'callout' && P[2]) {
          set('IT', PDFName.of('FreeTextCallout'));
          set('CL', numArr([P[2][0], P[2][1], Math.min(P[0][0], P[1][0]), Math.max(P[0][1], P[1][1])]));
          set('LE', PDFName.of('OpenArrow'));
        }
        break;
      }
      default: return;
    }
    if (an.text && an.type !== 'text' && an.type !== 'callout') set('Contents', PDFString.of(an.text));

    const ref = ctx.register(d);
    let annots = page.node.Annots();
    if (!annots) { annots = ctx.obj([]); page.node.set(PDFName.of('Annots'), annots); }
    annots.push(ref);
  }

  function drawArrowPdf(page, from, to, color, width) {
    const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const len = 10 + width * 2;
    [ang + Math.PI - 0.4, ang + Math.PI + 0.4].forEach((a) => {
      page.drawLine({ start: { x: to[0], y: to[1] }, end: { x: to[0] + Math.cos(a) * len, y: to[1] + Math.sin(a) * len }, thickness: width, color });
    });
  }

  // Copy the user's interactive-form edits (kept by PDF.js in annotationStorage,
  // keyed by widget-annotation id) into `pdfDoc`'s AcroForm fields via pdf-lib,
  // resolving id -> field name through PDF.js's getFieldObjects(). Text, checkbox,
  // radio and dropdown/list fields are handled; anything unmapped is skipped.
  async function applyFormEdits(pdfDoc) {
    try {
      const src = App.state.pdfDoc;
      const store = src && src.annotationStorage;
      const all = store && store.getAll ? store.getAll() : null;
      if (!all || !Object.keys(all).length) return;
      const fieldObjs = await src.getFieldObjects();
      if (!fieldObjs) return;
      const idToName = {};
      for (const [name, arr] of Object.entries(fieldObjs)) {
        (arr || []).forEach((o) => { if (o && o.id != null) idToName[o.id] = name; });
      }
      const form = pdfDoc.getForm();
      const done = new Set();
      for (const [id, entry] of Object.entries(all)) {
        const name = idToName[id];
        if (!name || done.has(name) || !entry || !('value' in entry)) continue;
        done.add(name);
        let field;
        try { field = form.getField(name); } catch (_) { continue; }
        const v = entry.value;
        try {
          if (typeof field.setText === 'function') {
            field.setText(v == null ? '' : String(v));
          } else if (typeof field.check === 'function' && typeof field.uncheck === 'function') {
            (v && v !== 'Off' && v !== 'off' && v !== false) ? field.check() : field.uncheck();
          } else if (typeof field.select === 'function' && v != null && v !== 'Off') {
            field.select(String(v));
          }
        } catch (_) { /* field type/value mismatch — leave as-is */ }
      }
    } catch (_) { /* forms are optional */ }
  }

  // Build the final PDF bytes with all placements flattened onto their pages.
  // opts.noSidecar skips the editable round-trip attachments — used when signing,
  // where the output must be a final, flattened document (an embedded editable
  // copy would let a later edit silently break the signature).
  S.buildBytes = async function (opts) {
    opts = opts || {};
    const { PDFDocument, StandardFonts, degrees, rgb } = window.PDFLib;

    const pdfDoc = await PDFDocument.load(App.state.pdfBytes);
      // If the user typed into interactive form fields (PDF.js ENABLE_FORMS keeps
      // their edits in annotationStorage), write those values into the fields with
      // pdf-lib so they persist in the saved file. (PDF.js's own saveDocument()
      // emits an incremental update that doesn't survive pdf-lib's full rewrite,
      // so we fill the fields directly instead.)
      await applyFormEdits(pdfDoc);
      const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

      // Under virtualized rendering a page with items may never have been
      // rasterized, so its scale-1 viewport isn't cached yet. Fetch on demand.
      const pagesWithItems = new Set([
        ...App.state.placements.map((p) => p.page),
        ...App.state.measurements.map((m) => m.page),
        ...App.state.annotations.map((a) => a.page)
      ]);
      for (const pg of pagesWithItems) {
        if (!App.state.baseViewports[pg - 1]) {
          const page = await App.state.pdfDoc.getPage(pg);
          App.state.baseViewports[pg - 1] = page.getViewport({ scale: 1 });
        }
      }

      // Embed each distinct PNG only once.
      const pngCache = new Map();
      async function getPng(dataUrl) {
        if (!pngCache.has(dataUrl)) {
          pngCache.set(dataUrl, await pdfDoc.embedPng(dataUrlToBytes(dataUrl)));
        }
        return pngCache.get(dataUrl);
      }

      for (const p of App.state.placements) {
        const vp = App.state.baseViewports[p.page - 1];
        const page = pdfDoc.getPage(p.page - 1);

        const A = vp.convertToPdfPoint(p.vx, p.vy);
        const B = vp.convertToPdfPoint(p.vx, p.vy + p.vh);
        const C = vp.convertToPdfPoint(p.vx + p.vw, p.vy + p.vh);

        const width = dist(B, C);
        const height = dist(B, A);
        const rot = degrees(angleDeg(B, C));

        if (p.type === 'image') {
          const png = await getPng(p.dataUrl);
          page.drawImage(png, {
            x: B[0], y: B[1], width, height, rotate: rot
          });
        } else {
          // Date/text: anchor at the baseline. Map a baseline point directly
          // so vertical centering matches the on-screen box.
          const baselineY = p.vy + p.vh * 0.5 + p.fontPt * 0.34;
          const anchor = vp.convertToPdfPoint(p.vx + p.fontPt * 0.1, baselineY);
          // Writing direction (on-screen +x) for correct rotation.
          const dirPt = vp.convertToPdfPoint(p.vx + p.fontPt * 0.1 + 1, baselineY);
          const textRot = degrees(angleDeg(anchor, dirPt));
          page.drawText(p.text, {
            x: anchor[0],
            y: anchor[1],
            size: p.fontPt,
            font: helv,
            color: rgb(0.05, 0.05, 0.05),
            rotate: textRot
          });
        }
      }

      // ---- measurements ----
      for (const m of App.state.measurements) {
        const vp = App.state.baseViewports[m.page - 1];
        const page = pdfDoc.getPage(m.page - 1);
        const color = hexRgb(m.color || M_COLORS[m.type] || '#2f6fed');
        // vertices -> PDF user space (rotation-safe)
        const P = m.pts.map((pt) => vp.convertToPdfPoint(pt.vx, pt.vy));

        if (m.type === 'count') {
          P.forEach((c) => page.drawCircle({ x: c[0], y: c[1], size: 5, color, opacity: 0.85 }));
        } else {
          const seq = m.type === 'area' ? P.concat([P[0]]) : P; // close polygons
          for (let i = 0; i < seq.length - 1; i++) {
            page.drawLine({
              start: { x: seq[i][0], y: seq[i][1] },
              end: { x: seq[i + 1][0], y: seq[i + 1][1] },
              thickness: 1.4, color
            });
          }
        }

        // label near an anchor point
        let ax, ay;
        if (m.type === 'area') {
          ax = P.reduce((s, p) => s + p[0], 0) / P.length;
          ay = P.reduce((s, p) => s + p[1], 0) / P.length;
        } else if (m.type === 'angle') {
          ax = P[1][0]; ay = P[1][1];
        } else {
          ax = P[0][0]; ay = P[0][1];
        }
        page.drawText(String(m.label), {
          x: ax + 3, y: ay + 3, size: 9, font: helv, color
        });
      }

      // ---- markup annotations: real annotations (interop) or flattened ----
      for (const an of App.state.annotations) {
        const vp = App.state.baseViewports[an.page - 1];
        if (!vp) continue;
        const page = pdfDoc.getPage(an.page - 1);
        // Text markups (highlight/underline/strikeout) are quad-based; always
        // flatten-draw them (writeRealAnnot doesn't handle these types).
        if (an.type === 'texthighlight' || an.type === 'underline' || an.type === 'strikeout') {
          const tcol = hexRgb((an.style && an.style.stroke) || '#ffd400');
          (an.quads || []).forEach((q) => {
            const a0 = vp.convertToPdfPoint(q.x, q.y);
            const a1 = vp.convertToPdfPoint(q.x + q.w, q.y + q.h);
            const x = Math.min(a0[0], a1[0]), y = Math.min(a0[1], a1[1]);
            const w = Math.abs(a1[0] - a0[0]), h = Math.abs(a1[1] - a0[1]);
            if (an.type === 'texthighlight') {
              page.drawRectangle({ x, y, width: w, height: h, color: tcol, opacity: 0.35 });
            } else {
              const yy = an.type === 'underline' ? y : y + h / 2;
              page.drawLine({ start: { x, y: yy }, end: { x: x + w, y: yy }, thickness: Math.max(1, (an.style && an.style.width) || 1.5), color: tcol });
            }
          });
          continue;
        }
        if (App.state.saveAnnots) { writeRealAnnot(pdfDoc, page, an, vp); continue; }
        const s = an.style || {};
        const col = hexRgb(s.stroke || '#e5484d');
        const w = s.width || 2;
        const op = s.opacity == null ? 1 : s.opacity;
        const hasFill = s.fill && s.fill !== 'none';
        const fillCol = hasFill ? hexRgb(s.fill) : null;
        // Freehand ink/highlight export the same curve-fit points the screen shows.
        const src = (App.Markup && App.Markup.smoothStroke) ? App.Markup.smoothStroke(an) : an.pts;
        const P = src.map((pt) => vp.convertToPdfPoint(pt.vx, pt.vy));
        const corners = () => {
          const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
          return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        };
        const polyDraw = (close) => {
          const seq = close ? P.concat([P[0]]) : P;
          for (let i = 0; i < seq.length - 1; i++) {
            page.drawLine({ start: { x: seq[i][0], y: seq[i][1] }, end: { x: seq[i + 1][0], y: seq[i + 1][1] }, thickness: w, color: col, opacity: op });
          }
        };

        if (an.type === 'line' || an.type === 'arrow') {
          page.drawLine({ start: { x: P[0][0], y: P[0][1] }, end: { x: P[1][0], y: P[1][1] }, thickness: w, color: col, opacity: op });
          if (an.type === 'arrow') drawArrowPdf(page, P[0], P[1], col, w);
        } else if (an.type === 'rect') {
          const b = corners();
          page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, borderColor: col, borderWidth: w, borderOpacity: op, color: fillCol || undefined, opacity: fillCol ? op : undefined });
        } else if (an.type === 'highlight') {
          // Freehand highlighter: wide, translucent, round-jointed band along the
          // pen path (matches the on-screen SVG stroke).
          const hw = (App.Markup && App.Markup.highlightWidth) ? App.Markup.highlightWidth(s) : Math.max(10, (s.width || 2) * 6);
          const cap = window.PDFLib.LineCapStyle ? window.PDFLib.LineCapStyle.Round : undefined;
          for (let i = 0; i < P.length - 1; i++) {
            page.drawLine({ start: { x: P[i][0], y: P[i][1] }, end: { x: P[i + 1][0], y: P[i + 1][1] }, thickness: hw, color: col, opacity: 0.35, lineCap: cap });
          }
          if (P.length === 1) page.drawCircle({ x: P[0][0], y: P[0][1], size: hw / 2, color: col, opacity: 0.35 });
        } else if (an.type === 'ellipse') {
          const b = corners();
          page.drawEllipse({ x: b.x + b.w / 2, y: b.y + b.h / 2, xScale: b.w / 2, yScale: b.h / 2, borderColor: col, borderWidth: w, borderOpacity: op, color: fillCol || undefined, opacity: fillCol ? op : undefined });
        } else if (an.type === 'polyline' || an.type === 'ink') {
          polyDraw(false);
        } else if (an.type === 'polygon' || an.type === 'cloud') {
          polyDraw(true);
        } else if (an.type === 'text' || an.type === 'callout') {
          const size = s.fontSize || 14;
          if (an.type === 'callout' && P[2]) {
            const from = [P[0][0], Math.min(P[0][1], P[1][1])];
            page.drawLine({ start: { x: from[0], y: from[1] }, end: { x: P[2][0], y: P[2][1] }, thickness: w, color: col });
            drawArrowPdf(page, from, P[2], col, w);
          }
          const bx = Math.min(P[0][0], P[1][0]) + 2;
          const topY = Math.max(P[0][1], P[1][1]);
          const lines = String(an.text || '').split('\n');
          lines.forEach((ln, i) => page.drawText(ln, { x: bx, y: topY - size * (i + 1), size, font: helv, color: col }));
        }
      }

      // Optional: flatten interactive form fields into static page content.
      if (App.state.flattenForms) {
        try { pdfDoc.getForm().flatten(); } catch (_) { /* no form / nothing to flatten */ }
      }

      // Document stamps: Bates/page numbering, header/footer, watermark. Drawn
      // last so they sit above the flattened content.
      if (App.DocStamp) App.DocStamp.applyToPdf(pdfDoc, helv);

      // Editable round-trip: embed a JSON copy of the marks plus a pristine copy
      // of the base PDF (the same bytes we flattened onto — form values included,
      // our marks excluded). Reopening in this app restores every mark as a live,
      // movable object; other viewers just see the flattened content above and
      // ignore these attachments. Only embed when there's something to preserve.
      try {
        const model = S.serializeModel();
        if (!opts.noSidecar && model.__count > 0) {
          delete model.__count;
          const json = new TextEncoder().encode(JSON.stringify(model));
          await pdfDoc.attach(json, App.SIDECAR.MODEL, {
            mimeType: 'application/json', description: 'FieldMark editable markups'
          });
          // Sidecar base = the document with form edits applied but our marks NOT
          // flattened, so reopening restores editable marks over the filled form.
          const baseDoc = await PDFDocument.load(App.state.pdfBytes);
          await applyFormEdits(baseDoc);
          await pdfDoc.attach(new Uint8Array(await baseDoc.save()), App.SIDECAR.BASE, {
            mimeType: 'application/pdf', description: 'FieldMark base document'
          });
        }
      } catch (e) { if (window.console) console.warn('sidecar embed skipped:', e && e.message); }

      return await pdfDoc.save();
  };

  // Serialize the in-app marks (geometry in scale-1 viewport points) so a saved
  // PDF can be reopened here with everything still editable. __count lets the
  // caller skip embedding when there's nothing to preserve.
  S.serializeModel = function () {
    const st = App.state;
    const clone = (x) => JSON.parse(JSON.stringify(x || []));
    const m = {
      v: 1,
      seqs: {
        placementSeq: st.placementSeq || 0, measureSeq: st.measureSeq || 0,
        viewportSeq: st.viewportSeq || 0, annoSeq: st.annoSeq || 0
      },
      saveAnnots: !!st.saveAnnots,
      scales: JSON.parse(JSON.stringify(st.scales || {})),
      viewports: JSON.parse(JSON.stringify(st.viewports || {})),
      placements: clone(st.placements),
      measurements: clone(st.measurements),
      annotations: clone(st.annotations)
    };
    m.__count = m.placements.length + m.measurements.length + m.annotations.length;
    return m;
  };

  // Save: overwrite the file that was opened, in place, with no dialog.
  // Falls back to Save As when there's no known path (e.g. dropped bytes).
  S.save = () => doSave(false);

  // Save As: always prompt for a location / name.
  S.saveAs = () => doSave(true);

  // Save triggered by the "save before closing?" dialog: skip the overwrite
  // confirm (the close dialog already asked) and report whether it succeeded so
  // the main process knows whether it may proceed to close.
  S.saveForClose = function () {
    if (App.state.filePath) S._ackedPath = App.state.filePath;
    return doSave(!App.state.filePath); // no path yet → force Save As
  };

  // Returns true if bytes were written, false if cancelled/failed.
  async function doSave(forceDialog) {
    if (!App.state.pdfDoc) return false;
    App.showLoading('Saving…');
    let saved = false;
    try {
      const bytes = await S.buildBytes();
      const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');

      if (!forceDialog && App.state.filePath) {
        // Non-destructive default: confirm the first overwrite of each file so a
        // Save never silently replaces the original. "Save a copy…" routes to the
        // Save As dialog instead. Once acknowledged for this path, later Saves are
        // silent (the expected in-place behavior).
        if (S._ackedPath !== App.state.filePath) {
          App.hideLoading();
          const ok = await App.confirm(
            `Overwrite the original file on disk?\n\n${App.state.filePath}\n\n` +
            'Choose "Save a copy…" to keep the original untouched.',
            { title: 'Save — overwrite original?', okLabel: 'Overwrite' });
          if (!ok) return doSave(true); // Save As → a copy
          S._ackedPath = App.state.filePath;
          App.showLoading('Saving…');
        }
        // Overwrite the opened document in place.
        const res = await window.api.writePdf(App.state.filePath, bytes);
        if (res && res.ok) { App.toast(`Saved: ${res.path}`, 'success', 4000); saved = true; }
        else if (res && res.error) App.toast(`Could not save: ${res.error}`, 'error', 6000);
      } else {
        const res = await window.api.savePdfDialog(`${base}-signed.pdf`, bytes);
        if (res && res.ok) {
          App.toast(`Saved: ${res.path}`, 'success', 5000);
          // Remember the new location so later Saves overwrite it too.
          App.state.filePath = res.path;
          App.state.fileName = res.path.replace(/^.*[\\/]/, '');
          saved = true;
        } else if (res && res.error) {
          App.toast(`Could not save: ${res.error}`, 'error', 6000);
        }
      }
      if (saved) App.state.dirty = false; // changes are now on disk
    } catch (err) {
      console.error(err);
      App.toast('Failed to save the PDF. ' + (err.message || ''), 'error', 6000);
    } finally {
      App.hideLoading();
    }
    return saved;
  }

  App.Save = S;
})();
