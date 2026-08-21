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
    length: '#2f6fed', continuous: '#0891b2', perimeter: '#7b61ff', area: '#21a366',
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
  // One timestamp for the whole export, so every annotation in a saved file
  // agrees rather than drifting by a second across a large plan set. Set at the
  // top of buildBytes; the fallback keeps the writers usable on their own.
  let exportStamp = null;

  // /CreationDate + /M on every exported annotation. Acrobat and Bluebeam show
  // these in their markup list and update /M when a recipient edits a mark, so
  // this is the only part of a change log that survives the file being edited
  // in other software. No /T (author): this app has no accounts, and stamping a
  // name was declined -- marks made here are deliberately anonymous.
  function setAnnotDates(set, PDFString, mark) {
    const stamp = exportStamp || App.pdfDateString();
    // Prefer the mark's own creation time when it has one. The model does not
    // carry createdAt yet (the document change log adds it); until then the
    // export time is the honest answer, and is still better than the blank
    // column every other viewer shows today.
    const created = (mark && mark.createdAt)
      ? App.pdfDateString(new Date(mark.createdAt))
      : stamp;
    set('CreationDate', PDFString.of(created));
    set('M', PDFString.of(stamp));
  }

  function writeRealAnnot(pdfDoc, page, an, vp) {
    const { PDFName, PDFArray, PDFNumber, PDFString } = window.PDFLib;
    const ctx = pdfDoc.context;
    const s = an.style || {};
    // Freehand ink/highlight export the same curve-fit points the screen shows.
    const src = (App.Markup && App.Markup.smoothStroke) ? App.Markup.smoothStroke(an) : an.pts;
    const P = src.map((pt) => vp.convertToPdfPoint(pt.vx, pt.vy));
    // Loop rather than Math.min(...xs): a long freehand stroke can exceed the
    // engine's argument limit and spreading it throws RangeError — which would
    // fail the whole save, losing the user's work. See Geom.bbox for the twin.
    if (!P.length) return;
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    for (const p of P) {
      if (p[0] < rx0) rx0 = p[0];
      if (p[0] > rx1) rx1 = p[0];
      if (p[1] < ry0) ry0 = p[1];
      if (p[1] > ry1) ry1 = p[1];
    }
    const rect = [rx0 - 2, ry0 - 2, rx1 + 2, ry1 + 2];
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
    setAnnotDates(set, PDFString, an);
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
        const da = (App.Markup && App.Markup.fontById) ? App.Markup.fontById(s.fontFamily).da : 'Helv';
        set('DA', PDFString.of(`/${da} ${size} Tf ${col[0].toFixed(3)} ${col[1].toFixed(3)} ${col[2].toFixed(3)} rg`));
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

  // Append an annotation reference to a page's /Annots, creating the array on
  // first use. Shared by the annotation writers below.
  function pushAnnot(pdfDoc, page, dict) {
    const { PDFName } = window.PDFLib;
    const ref = pdfDoc.context.register(dict);
    let annots = page.node.Annots();
    if (!annots) { annots = pdfDoc.context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
    annots.push(ref);
  }

  // Quad-based text markups (highlight / underline / strikeout) as REAL
  // annotations. These are the subtypes Acrobat and Bluebeam create for the
  // same three tools, so exporting them keeps the mark selectable,
  // recolourable, repliable and listed in the other tool's markup panel —
  // instead of baked into the page content where nothing can touch it.
  //
  // Every one carries a generated /AP appearance stream. Without /AP the viewer
  // has to synthesise the appearance itself: Acrobat does, plenty of others do
  // not, and the mark would render as nothing in some of the very software this
  // is meant to interoperate with. Verified rendering pixel-wise through pdf.js.
  function writeTextMarkupAnnot(pdfDoc, page, an, vp) {
    const { PDFName, PDFArray, PDFNumber, PDFString, PDFRawStream } = window.PDFLib;
    const ctx = pdfDoc.context;
    const s = an.style || {};
    const quads = an.quads || [];
    const SUB = { texthighlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' };
    const subtype = SUB[an.type];
    if (!subtype || !quads.length) return;

    const col = hexArr(s.stroke || '#ffd400');
    const numArr = (arr) => { const a = PDFArray.withContext(ctx); arr.forEach((n) => a.push(PDFNumber.of(n))); return a; };

    // Map each viewport quad to an axis-aligned box in PDF user space. Page
    // rotation is always a multiple of 90 degrees, so an axis-aligned quad stays
    // axis-aligned and min/max of the two mapped corners is exact.
    const boxes = quads.map((q) => {
      const a0 = vp.convertToPdfPoint(q.x, q.y);
      const a1 = vp.convertToPdfPoint(q.x + q.w, q.y + q.h);
      return {
        x: Math.min(a0[0], a1[0]), y: Math.min(a0[1], a1[1]),
        w: Math.abs(a1[0] - a0[0]), h: Math.abs(a1[1] - a0[1])
      };
    });

    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    for (const b of boxes) {
      if (b.x < rx0) rx0 = b.x;
      if (b.y < ry0) ry0 = b.y;
      if (b.x + b.w > rx1) rx1 = b.x + b.w;
      if (b.y + b.h > ry1) ry1 = b.y + b.h;
    }
    const rect = [rx0 - 1, ry0 - 1, rx1 + 1, ry1 + 1];

    // /QuadPoints runs upper-left, upper-right, lower-left, lower-right per
    // quad — the order Acrobat writes and every real viewer expects, whatever
    // the spec's own prose says about counter-clockwise ordering.
    const qp = [];
    boxes.forEach((b) => {
      qp.push(b.x, b.y + b.h, b.x + b.w, b.y + b.h, b.x, b.y, b.x + b.w, b.y);
    });

    const lw = Math.max(1, s.width || 1.5);
    const c3 = `${col[0].toFixed(3)} ${col[1].toFixed(3)} ${col[2].toFixed(3)}`;
    let ops, resources;
    if (an.type === 'texthighlight') {
      // Multiply keeps the text underneath readable the way a real highlighter
      // does; a plain opaque fill would bury it.
      ops = ['/GS0 gs', `${c3} rg`].concat(boxes.map((b) => `${b.x} ${b.y} ${b.w} ${b.h} re f`));
      resources = ctx.obj({ ExtGState: ctx.obj({ GS0: ctx.obj({ Type: 'ExtGState', BM: 'Multiply', ca: 1 }) }) });
    } else {
      ops = [`${c3} RG`, `${lw} w`].concat(boxes.map((b) => {
        const yy = an.type === 'underline' ? b.y + lw : b.y + b.h / 2;
        return `${b.x} ${yy} m ${b.x + b.w} ${yy} l S`;
      }));
      resources = ctx.obj({});
    }

    const apDict = ctx.obj({
      Type: 'XObject', Subtype: 'Form',
      BBox: numArr(rect), Matrix: numArr([1, 0, 0, 1, 0, 0]), Resources: resources
    });
    const apRef = ctx.register(PDFRawStream.of(apDict, new TextEncoder().encode(ops.join('\n'))));

    const d = ctx.obj({});
    const set = (k, v) => d.set(PDFName.of(k), v);
    set('Type', PDFName.of('Annot'));
    setAnnotDates(set, PDFString, an);
    set('Subtype', PDFName.of(subtype));
    set('Rect', numArr(rect));
    set('QuadPoints', numArr(qp));
    set('C', numArr(col));
    set('F', PDFNumber.of(4));                       // Print
    set('AP', ctx.obj({ N: apRef }));
    if (an.text) set('Contents', PDFString.of(an.text));
    pushAnnot(pdfDoc, page, d);
  }

  // Escape a literal string for a content stream's ( ) operand.
  function pdfEsc(s) {
    return String(s == null ? '' : s).replace(/([\\()])/g, '\\$1');
  }

  // A circle as four cubic Beziers — the count tool's dot, drawn in an /AP where
  // there is no drawCircle helper to lean on.
  function circleOps(cx, cy, r) {
    const k = 0.5523 * r;
    return [
      `${cx + r} ${cy} m`,
      `${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c`,
      `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c`,
      `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c`,
      `${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c`,
      'f'
    ].join('\n');
  }

  // One NumberFormat entry (ISO 32000 Table 271): how a measured axis converts
  // into a named unit and how it prints.
  function numberFormat(ctx, unit, conversion) {
    const { PDFName, PDFNumber, PDFString } = window.PDFLib;
    const d = ctx.obj({});
    d.set(PDFName.of('Type'), PDFName.of('NumberFormat'));
    d.set(PDFName.of('U'), PDFString.of(unit));      // unit label the viewer shows
    d.set(PDFName.of('C'), PDFNumber.of(conversion)); // user-space units -> `unit`
    d.set(PDFName.of('F'), PDFName.of('D'));         // decimal
    d.set(PDFName.of('D'), PDFNumber.of(100));       // to two places
    return d;
  }

  // Measurements as real annotations carrying a /Measure dictionary.
  //
  // Bluebeam and Acrobat keep a measurement live by storing the calibration
  // beside the geometry, so the recipient can select it, read the calibrated
  // value and keep measuring on the same scale. PDF expresses that with
  // /Measure (ISO 32000 s12.9). Drawing the numbers into page content — what
  // this used to do — exports a picture of a takeoff rather than a takeoff.
  //
  // The annotation carries its own /AP reproducing exactly what the flattened
  // path drew, including the rotation-corrected label, so the visual result is
  // unchanged everywhere while the geometry, scale and value become readable.
  function writeMeasureAnnot(pdfDoc, page, m, vp, scale, fontRef) {
    const { PDFName, PDFArray, PDFNumber, PDFString, PDFRawStream } = window.PDFLib;
    const ctx = pdfDoc.context;
    const pts = m.pts || [];
    if (!pts.length) return false;
    const P = pts.map((pt) => vp.convertToPdfPoint(pt.vx, pt.vy));
    const numArr = (arr) => { const a = PDFArray.withContext(ctx); arr.forEach((n) => a.push(PDFNumber.of(n))); return a; };
    const col = hexArr(m.color || M_COLORS[m.type] || '#2f6fed');
    const c3 = `${col[0].toFixed(3)} ${col[1].toFixed(3)} ${col[2].toFixed(3)}`;
    const lw = Math.max(0.5, m.width || 1.4);

    // Geometry subtype. Angle is a PolyLine too, but carries no /Measure: it is
    // degrees, which no scale affects.
    const MAP = {
      length: ['Line', 'LineDimension'],
      perimeter: ['PolyLine', 'PolyLineDimension'],
      continuous: ['PolyLine', 'PolyLineDimension'],
      area: ['Polygon', 'PolygonDimension'],
      angle: ['PolyLine', null],
      count: ['Polygon', null]
    };
    const [subtype, it] = MAP[m.type] || ['PolyLine', null];

    // ---- appearance: the same strokes and label the flattened path draws ----
    const ops = [];
    if (m.type === 'count') {
      ops.push(`${c3} rg`);
      P.forEach((c) => ops.push(circleOps(c[0], c[1], 5)));
    } else {
      const seq = m.type === 'area' ? P.concat([P[0]]) : P;
      ops.push(`${c3} RG`, `${lw} w`);
      seq.forEach((p, i) => ops.push(i === 0 ? `${p[0]} ${p[1]} m` : `${p[0]} ${p[1]} l`));
      ops.push('S');
    }

    // Label anchor, resolved in scale-1 viewport space so the on-screen writing
    // direction survives page rotation — the same technique the flattened path
    // and the free-text export use.
    let av;
    if (m.type === 'area' || m.type === 'count') av = App.Geom.centroid(pts);
    else if (m.type === 'angle') av = pts[1];
    else av = pts[0];
    const anchor = vp.convertToPdfPoint(av.vx + 3, av.vy - 3);
    const dirPt = vp.convertToPdfPoint(av.vx + 4, av.vy - 3);
    const ang = Math.atan2(dirPt[1] - anchor[1], dirPt[0] - anchor[0]);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    if (m.label) {
      ops.push('BT', `/Helv 9 Tf`, `${c3} rg`,
        `${ca.toFixed(6)} ${sa.toFixed(6)} ${(-sa).toFixed(6)} ${ca.toFixed(6)} ${anchor[0]} ${anchor[1]} Tm`,
        `(${pdfEsc(m.label)}) Tj`, 'ET');
    }

    // Rect must contain the strokes AND the rotated label, so pad generously.
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    for (const p of P.concat([anchor])) {
      if (p[0] < rx0) rx0 = p[0];
      if (p[0] > rx1) rx1 = p[0];
      if (p[1] < ry0) ry0 = p[1];
      if (p[1] > ry1) ry1 = p[1];
    }
    const pad = 12 + lw;
    const rect = [rx0 - pad, ry0 - pad, rx1 + pad, ry1 + pad];

    const resources = ctx.obj({ Font: ctx.obj({ Helv: fontRef }) });
    const apDict = ctx.obj({
      Type: 'XObject', Subtype: 'Form',
      BBox: numArr(rect), Matrix: numArr([1, 0, 0, 1, 0, 0]), Resources: resources
    });
    const apRef = ctx.register(PDFRawStream.of(apDict, new TextEncoder().encode(ops.join('\n'))));

    // ---- the annotation ----
    const d = ctx.obj({});
    const set = (k, v) => d.set(PDFName.of(k), v);
    set('Type', PDFName.of('Annot'));
    setAnnotDates(set, PDFString, m);
    set('Subtype', PDFName.of(subtype));
    set('Rect', numArr(rect));
    set('C', numArr(col));
    set('F', PDFNumber.of(4));
    set('AP', ctx.obj({ N: apRef }));
    const bs = ctx.obj({}); bs.set(PDFName.of('W'), PDFNumber.of(lw)); set('BS', bs);
    if (it) set('IT', PDFName.of(it));
    if (m.label) set('Contents', PDFString.of(String(m.label)));

    const flat = [].concat.apply([], P);
    if (subtype === 'Line') set('L', numArr([P[0][0], P[0][1], P[1][0], P[1][1]]));
    else set('Vertices', numArr(flat));

    // ---- /Measure: the calibration itself ----
    // `scale.factor` is real units per PDF user-space unit, which is exactly the
    // conversion /X wants. /D and /A then read in those same units, so their
    // conversion is 1.
    if (scale && scale.factor && it) {
      const md = ctx.obj({});
      md.set(PDFName.of('Type'), PDFName.of('Measure'));
      md.set(PDFName.of('Subtype'), PDFName.of('RL'));   // rectilinear
      const perInch = scale.factor * 72;
      md.set(PDFName.of('R'), PDFString.of(`1 in = ${(+perInch.toFixed(4))} ${scale.unit}`));
      const mk = (arr) => { const a = PDFArray.withContext(ctx); arr.forEach((o) => a.push(o)); return a; };
      md.set(PDFName.of('X'), mk([numberFormat(ctx, scale.unit, scale.factor)]));
      md.set(PDFName.of('D'), mk([numberFormat(ctx, scale.unit, 1)]));
      md.set(PDFName.of('A'), mk([numberFormat(ctx, `${scale.unit}²`, 1)]));
      set('Measure', md);
    }

    pushAnnot(pdfDoc, page, d);
    return true;
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
  // Returns { attempted, failed } so the caller can tell the user how many of
  // their typed values did not make it into the saved file. Previously every
  // failure here was swallowed at three separate levels, so a form could save
  // with none of its values and no indication anything went wrong.
  async function applyFormEdits(pdfDoc) {
    let attempted = 0, failed = 0;
    try {
      const src = App.state.pdfDoc;
      const store = src && src.annotationStorage;
      const all = store && store.getAll ? store.getAll() : null;
      if (!all || !Object.keys(all).length) return { attempted, failed };
      const fieldObjs = await src.getFieldObjects();
      if (!fieldObjs) return { attempted, failed };
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
        attempted++;
        let field;
        try { field = form.getField(name); } catch (_) { failed++; continue; }
        const v = entry.value;
        try {
          if (typeof field.setText === 'function') {
            field.setText(v == null ? '' : String(v));
          } else if (typeof field.check === 'function' && typeof field.uncheck === 'function') {
            (v && v !== 'Off' && v !== 'off' && v !== false) ? field.check() : field.uncheck();
          } else if (typeof field.select === 'function' && v != null && v !== 'Off') {
            field.select(String(v));
          }
        } catch (_) { failed++; /* field type/value mismatch — leave as-is */ }
      }
    } catch (_) {
      // The whole block failed: every value the user typed is missing from the
      // output. Report it as such rather than as "forms are optional".
      if (attempted === 0) attempted = 1;
      failed = attempted;
    }
    return { attempted, failed };
  }

  // Build the final PDF bytes with all placements flattened onto their pages.
  // opts.noSidecar skips the editable round-trip attachments — used when signing,
  // where the output must be a final, flattened document (an embedded editable
  // copy would let a later edit silently break the signature).
  S.buildBytes = async function (opts) {
    opts = opts || {};
    const { PDFDocument, StandardFonts, degrees, rgb } = window.PDFLib;

    exportStamp = App.pdfDateString();
    const pdfDoc = await PDFDocument.load(App.state.pdfBytes);
      // If the user typed into interactive form fields (PDF.js ENABLE_FORMS keeps
      // their edits in annotationStorage), write those values into the fields with
      // pdf-lib so they persist in the saved file. (PDF.js's own saveDocument()
      // emits an incremental update that doesn't survive pdf-lib's full rewrite,
      // so we fill the fields directly instead.)
      const formResult = await applyFormEdits(pdfDoc);
      if (formResult && formResult.failed) {
        const n = formResult.failed;
        App.toast(`${n} form field${n === 1 ? '' : 's'} could not be saved — check ${n === 1 ? 'its value' : 'their values'} in the saved file.`, 'error');
      }
      const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
      // Text boxes can pick one of the three PDF standard-font families; embed
      // each lazily and map the annotation's fontFamily to the matching font so
      // a flattened box looks like it did on screen.
      const STD_FONT = {
        Helvetica: StandardFonts.Helvetica,
        TimesRoman: StandardFonts.TimesRoman,
        Courier: StandardFonts.Courier
      };
      const fontCache = { Helvetica: helv };
      const fontFor = async (fontFamily) => {
        const pdfName = (App.Markup && App.Markup.fontById) ? App.Markup.fontById(fontFamily).pdf : 'Helvetica';
        if (!fontCache[pdfName]) fontCache[pdfName] = await pdfDoc.embedFont(STD_FONT[pdfName] || StandardFonts.Helvetica);
        return fontCache[pdfName];
      };

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
        // With editable annotations on, a measurement exports as a real
        // dimension annotation carrying its calibration, so Bluebeam/Acrobat can
        // still read and extend the takeoff. Falls through to flattening if the
        // writer declines (e.g. no geometry).
        if (App.state.saveAnnots) {
          const sc = (App.Measure && App.Measure.scaleFor)
            ? App.Measure.scaleFor(m.page, m.pts) : null;
          if (writeMeasureAnnot(pdfDoc, page, m, vp, sc, helv.ref)) continue;
        }
        const color = hexRgb(m.color || M_COLORS[m.type] || '#2f6fed');
        // vertices -> PDF user space (rotation-safe)
        const P = m.pts.map((pt) => vp.convertToPdfPoint(pt.vx, pt.vy));

        if (m.type === 'count') {
          P.forEach((c) => page.drawCircle({ x: c[0], y: c[1], size: 5, color, opacity: 0.85 }));
        } else {
          const seq = m.type === 'area' ? P.concat([P[0]]) : P; // close polygons
          const thickness = Math.max(0.5, m.width || 1.4); // honor the line's thickness
          for (let i = 0; i < seq.length - 1; i++) {
            page.drawLine({
              start: { x: seq[i][0], y: seq[i][1] },
              end: { x: seq[i + 1][0], y: seq[i + 1][1] },
              thickness, color
            });
          }
        }

        // Label near an anchor point. Anchor in SCALE-1 VIEWPORT space so we can
        // derive the on-screen writing direction and rotate the glyphs to match
        // the page — the same rotation-safe technique the placement/free-text
        // paths use. Drawing without this rotation makes the label save/print out
        // vertical on a /Rotate page (positioned right, oriented wrong).
        let av;
        if (m.type === 'area') {
          av = {
            vx: m.pts.reduce((s, p) => s + p.vx, 0) / m.pts.length,
            vy: m.pts.reduce((s, p) => s + p.vy, 0) / m.pts.length
          };
        } else if (m.type === 'angle') {
          av = { vx: m.pts[1].vx, vy: m.pts[1].vy };
        } else {
          av = { vx: m.pts[0].vx, vy: m.pts[0].vy };
        }
        // Nudge up-and-right of the anchor on screen (viewport +x / -y).
        const anchor = vp.convertToPdfPoint(av.vx + 3, av.vy - 3);
        const dir = vp.convertToPdfPoint(av.vx + 3 + 1, av.vy - 3);
        page.drawText(String(m.label), {
          x: anchor[0], y: anchor[1], size: 9, font: helv, color,
          rotate: degrees(angleDeg(anchor, dir))
        });
      }

      // ---- markup annotations: real annotations (interop) or flattened ----
      for (const an of App.state.annotations) {
        const vp = App.state.baseViewports[an.page - 1];
        if (!vp) continue;
        const page = pdfDoc.getPage(an.page - 1);
        // Text markups (highlight/underline/strikeout) are quad-based, so they
        // take the QuadPoints writer rather than writeRealAnnot. With editable
        // annotations on they export as real Highlight/Underline/StrikeOut
        // objects; otherwise they flatten into page content as before.
        if (an.type === 'texthighlight' || an.type === 'underline' || an.type === 'strikeout') {
          if (App.state.saveAnnots) { writeTextMarkupAnnot(pdfDoc, page, an, vp); continue; }
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
          // Freehand highlighter: one wide, translucent, round-capped band along
          // the pen path (matches the on-screen SVG stroke). It MUST be drawn as a
          // single stroked path: drawing it segment-by-segment (each its own 0.35
          // opacity) makes the round end-caps overlap and stack into a chain of
          // dark blobs — a beaded line instead of a clean highlight. drawSvgPath
          // strokes the whole path under one shared ExtGState, so the 0.35 alpha
          // applies once and overlaps don't darken.
          const hw = (App.Markup && App.Markup.highlightWidth) ? App.Markup.highlightWidth(s) : Math.max(10, (s.width || 2) * 6);
          const { LineCapStyle, LineJoinStyle, setLineJoin } = window.PDFLib;
          if (P.length === 1) {
            page.drawCircle({ x: P[0][0], y: P[0][1], size: hw / 2, color: col, opacity: 0.35 });
          } else {
            // drawSvgPath maps a path point (px,py) to PDF user space as
            // (x+px, y-py) — its Y axis is flipped — so with x:0,y:0 we negate Y
            // to place each point. Round joins keep the corners smooth.
            const d = 'M ' + P.map((p) => p[0] + ' ' + (-p[1])).join(' L ');
            if (setLineJoin && LineJoinStyle) page.pushOperators(setLineJoin(LineJoinStyle.Round));
            page.drawSvgPath(d, {
              x: 0, y: 0,
              borderColor: col,
              borderWidth: hw,
              borderOpacity: 0.35,
              borderLineCap: LineCapStyle ? LineCapStyle.Round : undefined,
            });
          }
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
          const font = await fontFor(s.fontFamily);
          const lines = String(an.text || '').split('\n');
          // Lay each line out along the page's on-screen horizontal so the text
          // stays horizontal even on a rotated page. Work in scale-1 viewport
          // space (top-left origin, y-down) from the box's top-left corner, then
          // map the baseline anchor and a +1px direction point through
          // convertToPdfPoint and rotate the glyphs to match — the same
          // rotation-safe technique the placement text path uses. Drawing without
          // this rotation makes text on a /Rotate page save out vertical.
          const vLeft = Math.min(an.pts[0].vx, an.pts[1].vx) + 2;
          const vTop = Math.min(an.pts[0].vy, an.pts[1].vy);
          lines.forEach((ln, i) => {
            const baseY = vTop + size * (i + 1);
            const anchor = vp.convertToPdfPoint(vLeft, baseY);
            const dir = vp.convertToPdfPoint(vLeft + 1, baseY);
            page.drawText(ln, { x: anchor[0], y: anchor[1], size, font, color: col, rotate: degrees(angleDeg(anchor, dir)) });
          });
        }
      }

      // Optional: flatten interactive form fields into static page content.
      if (App.state.flattenForms) {
        try {
          pdfDoc.getForm().flatten();
        } catch (e) {
          // The user ticked "flatten form fields"; if it did not happen they are
          // about to hand someone an editable form believing it is locked.
          App.toast('Form fields could not be flattened — they are still editable in the saved file.', 'error');
        }
      }

      // Document stamps: Bates/page numbering, header/footer, watermark. Drawn
      // last so they sit above the flattened content.
      if (App.DocStamp) App.DocStamp.applyToPdf(pdfDoc, helv);

      // Editable round-trip: embed a JSON copy of the marks plus a pristine copy
      // of the base PDF (the same bytes we flattened onto — form values included,
      // our marks excluded). Reopening in this app restores every mark as a live,
      // movable object; other viewers just see the flattened content above and
      // ignore these attachments. Only embed when there's something to preserve.
      //
      // Order matters. The base is built BEFORE anything is attached, so every
      // step that can realistically throw — loading pdfBytes, applying form
      // edits, re-saving the base — runs while the document carries no sidecar
      // at all, and a failure leaves a clean file rather than half of one.
      // Attaching the model first (as this used to) could write a file holding a
      // complete record of the user's marks with no base to lay them over, which
      // the open path can only refuse. pdf-lib has no detach and no transaction,
      // so this ordering IS the guarantee — not an atomic write.
      try {
        const model = S.serializeModel();
        if (!opts.noSidecar && model.__count > 0) {
          delete model.__count;
          // Sidecar base = the document with form edits applied but our marks NOT
          // flattened, so reopening restores editable marks over the filled form.
          const baseDoc = await PDFDocument.load(App.state.pdfBytes);
          await applyFormEdits(baseDoc);
          const baseBytes = new Uint8Array(await baseDoc.save());
          const json = new TextEncoder().encode(JSON.stringify(model));
          // Nothing between these two that can fail.
          await pdfDoc.attach(json, App.SIDECAR.MODEL, {
            mimeType: 'application/json', description: 'FieldMark editable markups'
          });
          await pdfDoc.attach(baseBytes, App.SIDECAR.BASE, {
            mimeType: 'application/pdf', description: 'FieldMark base document'
          });
        }
      } catch (e) {
        if (window.console) console.warn('sidecar embed skipped:', e && e.message);
        // Highest-severity silent failure in the app before this: the file saves
        // fine and looks right, but reopening it gives flattened pixels instead
        // of editable marks, with nothing to explain why.
        // The marks are still live in this session, so say so: the user can act
        // on it now (save elsewhere, or copy them out) instead of finding out
        // when they reopen the file tomorrow and it is too late.
        App.toast('Saved, but the editable copy could not be embedded — reopening this file will show flattened marks. Your markups are still editable in this window.', 'error', 11000);
      }

      return await pdfDoc.save();
  };

  // Serialize the in-app marks (geometry in scale-1 viewport points) so a saved
  // PDF can be reopened here with everything still editable. __count lets the
  // caller skip embedding when there's nothing to preserve.
  // Thin wrapper over the shared model. The shape is the round-trip contract,
  // so it lives in src/shared where Node can unit-test it; this keeps
  // App.Save.serializeModel as the renderer-facing name its callers already use.
  S.serializeModel = function () {
    return App.serializeMarkupModel(App.state);
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

      // Editable annotations turned off: name the cost at the moment it is
      // incurred, rather than leaving it to be discovered by whoever opens the
      // file. Only fires when there is something to flatten, and only for the
      // minority who deliberately unticked the box — the default is on.
      if (!App.state.saveAnnots) {
        const n = (App.state.annotations || []).length + (App.state.measurements || []).length;
        if (n) {
          App.toast(`${n} mark${n === 1 ? '' : 's'} flattened — they will not be editable in other PDF apps.`,
            'info', 6000);
        }
      }

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
        const res = await window.api.savePdfDialog(`${base}.pdf`, bytes);
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
      if (saved && App.refreshDirtyIndicator) App.refreshDirtyIndicator();
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
