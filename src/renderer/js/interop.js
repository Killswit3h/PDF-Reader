'use strict';

/*
 * Phase 3 — real PDF annotation interop.
 *
 * Export: write STANDARD PDF annotation dictionaries (Square, Circle, Line,
 * PolyLine, Polygon, Ink, FreeText, Highlight) via pdf-lib's low-level
 * context.obj(...) API, each with an appearance stream (/AP /N form XObject)
 * so they render in Acrobat AND macOS Preview. Attached to page.node.Annots.
 *
 * Import: on open, App.Interop.importFrom(pdfjsDoc) reads each page's
 * getAnnotations() and converts supported subtypes back into editable
 * App.state.annotations, reversing the coordinate map with
 * viewport.convertToViewportPoint.
 *
 * Coordinates: our annotations live in scale-1 viewport points (top-left
 * origin). PDF annotation Rect/geometry is in PDF user space (bottom-left).
 * We map every vertex with viewport.convertToPdfPoint (rotation-safe), the
 * same transform save.js uses for flattening.
 */
(function () {
  const I = {};

  function hexToRgb01(hex) {
    const n = parseInt((hex || '#000000').slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const f = (x) => (Math.round(x * 1000) / 1000);

  // ---- geometry helpers on PDF-space point arrays ([x,y]) ----
  function bounds(P) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    P.forEach((p) => {
      if (p[0] < minx) minx = p[0]; if (p[1] < miny) miny = p[1];
      if (p[0] > maxx) maxx = p[0]; if (p[1] > maxy) maxy = p[1];
    });
    return { minx, miny, maxx, maxy };
  }

  /* =============================================================
   * EXPORT — build editable annotation dicts with appearance streams
   * ============================================================= */
  I.writeAnnotations = function (pdfDoc) {
    const { PDFName } = window.PDFLib;
    const ctx = pdfDoc.context;

    // Group annotations per page.
    const byPage = new Map();
    App.state.annotations.forEach((a) => {
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(a);
    });

    byPage.forEach((anns, pageNum) => {
      const vp = App.state.baseViewports[pageNum - 1];
      if (!vp) return;
      const page = pdfDoc.getPage(pageNum - 1);
      let annots = page.node.Annots();
      if (!annots) { annots = ctx.obj([]); page.node.set(PDFName.of('Annots'), annots); }

      anns.forEach((ann) => {
        const built = buildAnnotDict(ctx, vp, ann);
        if (built) annots.push(ctx.register(built));
      });
    });
  };

  // Map an annotation's viewport points to PDF user space.
  function mapPts(vp, ann) {
    return ann.pts.map((pt) => vp.convertToPdfPoint(pt.vx, pt.vy)); // [x,y]
  }

  function buildAnnotDict(ctx, vp, ann) {
    const P = mapPts(vp, ann);
    const b = bounds(P);
    const s = ann.style || {};
    const color = hexToRgb01(s.stroke);
    const fillC = hexToRgb01(s.fill);
    const width = s.width || 2;
    const ca = s.opacity == null ? 1 : s.opacity;
    const rectPad = width + 6;
    const rect = [b.minx - rectPad, b.miny - rectPad, b.maxx + rectPad, b.maxy + rectPad];
    const common = {
      Type: 'Annot',
      Rect: rect.map(f),
      C: color.map(f),
      CA: f(ca),
      F: 4, // Print flag
      T: ann.author || 'User',
      NM: 'mk-' + ann.id
    };
    if (ann.comment) common.Contents = ann.comment;

    // Appearance stream drawn in page-space, offset so BBox == Rect.
    const ox = rect[0], oy = rect[1];
    const ap = (content, extra) => makeAP(ctx, rect, content, extra);

    switch (ann.type) {
      case 'line':
      case 'arrow': {
        const [a, c] = P;
        let content = `${strokeOps(color, width, ca)}${f(a[0] - ox)} ${f(a[1] - oy)} m ${f(c[0] - ox)} ${f(c[1] - oy)} l S`;
        const le = ann.type === 'arrow' ? ['None', 'OpenArrow']
          : s.arrow === 'both' ? ['OpenArrow', 'OpenArrow']
            : s.arrow === 'end' ? ['None', 'OpenArrow'] : ['None', 'None'];
        content += arrowOps(a, c, ox, oy, color, width, ca, le);
        return dict(ctx, Object.assign({}, common, {
          Subtype: 'Line',
          L: [a[0], a[1], c[0], c[1]].map(f),
          LE: le.map((n) => nameOf(ctx, n)),
          BS: bs(ctx, width),
          AP: ap(content)
        }));
      }
      case 'rect':
      case 'highlight': {
        // axis-aligned box in viewport space
        const bb = boundsVP(ann);
        const A = vp.convertToPdfPoint(bb.minx, bb.miny);
        const C = vp.convertToPdfPoint(bb.maxx, bb.maxy);
        const rb = bounds([A, C]);
        if (ann.type === 'highlight') {
          const quad = [rb.minx, rb.maxy, rb.maxx, rb.maxy, rb.minx, rb.miny, rb.maxx, rb.miny];
          const r2 = [rb.minx, rb.miny, rb.maxx, rb.maxy];
          const content = `${fillC.map(f).join(' ')} rg /GS gs ${f(rb.minx - r2[0])} ${f(rb.miny - r2[1])} ${f(rb.maxx - rb.minx)} ${f(rb.maxy - rb.miny)} re f`;
          return dict(ctx, Object.assign({}, common, {
            Subtype: 'Highlight',
            C: fillC.map(f),
            QuadPoints: quad.map(f),
            Rect: r2.map(f),
            AP: makeAP(ctx, r2, content, { gs: 0.4 })
          }));
        }
        const w2 = rb.maxx - rb.minx, h2 = rb.maxy - rb.miny;
        const content = `${strokeOps(color, width, ca)}${fillOps(fillC, Math.min(0.35, ca * 0.35))}${f(rb.minx - (rb.minx - rectPad))} ${f(rb.miny - (rb.miny - rectPad))} ${f(w2)} ${f(h2)} re B`;
        const rr = [rb.minx - rectPad, rb.miny - rectPad, rb.maxx + rectPad, rb.maxy + rectPad];
        const content2 = `${strokeOps(color, width, ca)}${fillOps(fillC, Math.min(0.35, ca * 0.35))}${f(rectPad)} ${f(rectPad)} ${f(w2)} ${f(h2)} re B`;
        return dict(ctx, Object.assign({}, common, {
          Subtype: 'Square',
          Rect: rr.map(f),
          IC: fillC.map(f),
          BS: bs(ctx, width),
          AP: makeAP(ctx, rr, content2)
        }));
      }
      case 'ellipse': {
        const bb = boundsVP(ann);
        const A = vp.convertToPdfPoint(bb.minx, bb.miny);
        const C = vp.convertToPdfPoint(bb.maxx, bb.maxy);
        const rb = bounds([A, C]);
        const rr = [rb.minx - rectPad, rb.miny - rectPad, rb.maxx + rectPad, rb.maxy + rectPad];
        const cx = (rb.maxx - rb.minx) / 2 + rectPad, cy = (rb.maxy - rb.miny) / 2 + rectPad;
        const rx = (rb.maxx - rb.minx) / 2, ry = (rb.maxy - rb.miny) / 2;
        const content = strokeOps(color, width, ca) + fillOps(fillC, Math.min(0.35, ca * 0.35)) + ellipseOps(cx, cy, rx, ry) + ' B';
        return dict(ctx, Object.assign({}, common, {
          Subtype: 'Circle',
          Rect: rr.map(f),
          IC: fillC.map(f),
          BS: bs(ctx, width),
          AP: makeAP(ctx, rr, content)
        }));
      }
      case 'polyline':
      case 'polygon': {
        const verts = [];
        P.forEach((p) => { verts.push(p[0], p[1]); });
        let content = strokeOps(color, width, ca);
        if (ann.type === 'polygon') content += fillOps(fillC, Math.min(0.35, ca * 0.35));
        content += pathOps(P, ox, oy, ann.type === 'polygon');
        content += ann.type === 'polygon' ? ' B' : ' S';
        return dict(ctx, Object.assign({}, common, {
          Subtype: ann.type === 'polygon' ? 'Polygon' : 'PolyLine',
          Vertices: verts.map(f),
          IC: ann.type === 'polygon' ? fillC.map(f) : undefined,
          BS: bs(ctx, width),
          AP: ap(content)
        }));
      }
      case 'cloud': {
        // Represent as a Polygon with a Border-Effect cloud (/BE) so Acrobat
        // renders the scallop; appearance approximates with straight edges.
        const verts = [];
        P.forEach((p) => { verts.push(p[0], p[1]); });
        const content = strokeOps(color, width, ca) + fillOps(fillC, Math.min(0.35, ca * 0.35)) + pathOps(P, ox, oy, true) + ' B';
        return dict(ctx, Object.assign({}, common, {
          Subtype: 'Polygon',
          Vertices: verts.map(f),
          IC: fillC.map(f),
          BS: bs(ctx, width),
          BE: ctx.obj({ S: nameOf(ctx, 'C'), I: 1 }),
          AP: ap(content)
        }));
      }
      case 'ink': {
        const paths = [P];
        const inkList = paths.map((path) => {
          const flat = []; path.forEach((p) => { flat.push(p[0], p[1]); });
          return ctx.obj(flat.map(f));
        });
        let content = strokeOps(color, width, ca);
        paths.forEach((path) => { content += pathOps(path, ox, oy, false) + ' S'; });
        return dict(ctx, Object.assign({}, common, {
          Subtype: 'Ink',
          InkList: ctx.obj(inkList),
          BS: bs(ctx, width),
          AP: ap(content)
        }));
      }
      case 'underline':
      case 'strikeout': {
        // Proper text-markup: Underline / StrikeOut with QuadPoints.
        const bb = boundsVP(ann);
        const tl = vp.convertToPdfPoint(bb.minx, bb.miny);
        const tr = vp.convertToPdfPoint(bb.maxx, bb.miny);
        const bl = vp.convertToPdfPoint(bb.minx, bb.maxy);
        const br = vp.convertToPdfPoint(bb.maxx, bb.maxy);
        const rb = bounds([tl, tr, bl, br]);
        const rr = [rb.minx, rb.miny, rb.maxx, rb.maxy];
        // QuadPoints order per spec: x1 y1 x2 y2 x3 y3 x4 y4 (TL TR BL BR)
        const quad = [tl[0], tl[1], tr[0], tr[1], bl[0], bl[1], br[0], br[1]];
        // appearance: a stroke line at the underline/strikeout position
        const lineY = ann.type === 'underline' ? f(rb.miny - rr[1] + 1) : f((rb.miny + rb.maxy) / 2 - rr[1]);
        const content = strokeOps(color, Math.max(1.5, width), ca) +
          `${f(0)} ${lineY} m ${f(rr[2] - rr[0])} ${lineY} l S`;
        return dict(ctx, Object.assign({}, common, {
          Subtype: ann.type === 'underline' ? 'Underline' : 'StrikeOut',
          QuadPoints: quad.map(f),
          Rect: rr.map(f),
          AP: makeAP(ctx, rr, content)
        }));
      }
      case 'text':
      case 'callout': {
        const box = ann.type === 'callout' ? ann.pts[1] : ann.pts[0];
        const fontPt = s.fontSize || 14;
        const lines = String(ann.text || '').split('\n');
        const boxPt = vp.convertToPdfPoint(box.vx, box.vy);
        const boxBotPt = vp.convertToPdfPoint(box.vx, box.vy + lines.length * fontPt * 1.3);
        const boxRightPt = vp.convertToPdfPoint(box.vx + estWidth(lines, fontPt), box.vy);
        const rb = bounds([boxPt, boxBotPt, boxRightPt]);
        const rr = [rb.minx, rb.miny, rb.maxx, rb.maxy];
        // appearance: white bg + border + text
        let content = `1 1 1 rg ${f(0)} ${f(0)} ${f(rr[2] - rr[0])} ${f(rr[3] - rr[1])} re f ` +
          strokeOps(color, s.width || 1, 1) + `${f(0)} ${f(0)} ${f(rr[2] - rr[0])} ${f(rr[3] - rr[1])} re S `;
        content += `BT /Helv ${f(fontPt)} Tf ${color.map(f).join(' ')} rg `;
        lines.forEach((ln, i) => {
          const ty = (rr[3] - rr[1]) - fontPt * (i + 1) * 1.1;
          content += `1 0 0 1 ${f(3)} ${f(ty)} Tm (${escPdfString(ln)}) Tj `;
        });
        content += 'ET';
        const extra = { font: true };
        const d = {
          Subtype: 'FreeText',
          DA: `${color.map(f).join(' ')} rg /Helv ${f(fontPt)} Tf`,
          Rect: rr.map(f),
          Contents: ann.text || '',
          AP: makeAP(ctx, rr, content, extra)
        };
        if (ann.type === 'callout') {
          const tip = vp.convertToPdfPoint(ann.pts[0].vx, ann.pts[0].vy);
          const knee = vp.convertToPdfPoint(box.vx, box.vy);
          d.CL = [tip[0], tip[1], knee[0], knee[1]].map(f);
          d.IT = nameOf(ctx, 'FreeTextCallout');
          d.LE = nameOf(ctx, 'OpenArrow');
          // widen Rect to include the leader tip
          const rb2 = bounds([boxPt, boxBotPt, boxRightPt, tip]);
          d.Rect = [rb2.minx, rb2.miny, rb2.maxx, rb2.maxy].map(f);
        }
        return dict(ctx, Object.assign({}, common, d, { C: undefined }));
      }
      default:
        return null;
    }
  }

  /* ---- low-level op builders (PDF content stream text) ---- */
  function strokeOps(rgb01, w, ca) { return `${rgb01.map(f).join(' ')} RG ${f(w)} w `; }
  function fillOps(rgb01) { return `${rgb01.map(f).join(' ')} rg `; }
  function pathOps(P, ox, oy, close) {
    let d = `${f(P[0][0] - ox)} ${f(P[0][1] - oy)} m `;
    for (let i = 1; i < P.length; i++) d += `${f(P[i][0] - ox)} ${f(P[i][1] - oy)} l `;
    if (close) d += 'h ';
    return d;
  }
  function ellipseOps(cx, cy, rx, ry) {
    const k = 0.5523;
    return `${f(cx + rx)} ${f(cy)} m ` +
      `${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ` +
      `${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c ` +
      `${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ` +
      `${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c h`;
  }
  function arrowOps(a, c, ox, oy, rgb01, width, ca, le) {
    // simple open-arrow strokes at the end (and start if 'both')
    let out = '';
    const head = (from, to) => {
      const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
      const size = 6 + width * 2;
      const l = [to[0] - size * Math.cos(ang - 0.4), to[1] - size * Math.sin(ang - 0.4)];
      const r = [to[0] - size * Math.cos(ang + 0.4), to[1] - size * Math.sin(ang + 0.4)];
      out += ` ${f(to[0] - ox)} ${f(to[1] - oy)} m ${f(l[0] - ox)} ${f(l[1] - oy)} l S`;
      out += ` ${f(to[0] - ox)} ${f(to[1] - oy)} m ${f(r[0] - ox)} ${f(r[1] - oy)} l S`;
    };
    if (le[1] && le[1] !== 'None') head(a, c);
    if (le[0] && le[0] !== 'None') head(c, a);
    return out;
  }

  function nameOf(ctx, n) { return window.PDFLib.PDFName.of(n); }
  function dict(ctx, obj) {
    // strip undefined keys before building the dict
    const clean = {};
    Object.keys(obj).forEach((k) => { if (obj[k] !== undefined) clean[k] = obj[k]; });
    return ctx.obj(clean);
  }
  function bs(ctx, width) { return ctx.obj({ W: window.PDFLib.PDFNumber.of(width), S: nameOf(ctx, 'S') }); }

  // Build an /AP /N appearance-stream form XObject for the given Rect.
  function makeAP(ctx, rect, content, extra) {
    const { PDFName } = window.PDFLib;
    const w = rect[2] - rect[0], h = rect[3] - rect[1];
    const resources = { ProcSet: ctx.obj(['PDF', 'Text']) };
    if (extra && extra.font) {
      resources.Font = ctx.obj({
        Helv: ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
      });
    }
    if (extra && typeof extra.gs === 'number') {
      resources.ExtGState = ctx.obj({ GS: ctx.obj({ Type: 'ExtGState', ca: window.PDFLib.PDFNumber.of(extra.gs) }) });
    }
    const stream = ctx.flateStream(content, {
      Type: 'XObject', Subtype: 'Form', FormType: 1,
      BBox: [0, 0, f(w), f(h)],
      Resources: ctx.obj(resources)
    });
    const ref = ctx.register(stream);
    return ctx.obj({ N: ref });
  }

  function boundsVP(ann) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    ann.pts.forEach((p) => {
      if (p.vx < minx) minx = p.vx; if (p.vy < miny) miny = p.vy;
      if (p.vx > maxx) maxx = p.vx; if (p.vy > maxy) maxy = p.vy;
    });
    return { minx, miny, maxx, maxy };
  }
  let ectx = null;
  function estWidth(lines, fontPt) {
    if (!ectx) ectx = document.createElement('canvas').getContext('2d');
    ectx.font = `${fontPt}px Helvetica, sans-serif`;
    return lines.reduce((m, l) => Math.max(m, ectx.measureText(l || ' ').width), 0) + 8;
  }
  function escPdfString(s) { return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

  /* =============================================================
   * IMPORT — read existing annotations into editable markups
   * ============================================================= */
  I.importFrom = async function (pdfjsDoc) {
    if (!pdfjsDoc) return 0;
    let imported = 0;
    for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
      let page, anns;
      try {
        page = await pdfjsDoc.getPage(pageNum);
        anns = await page.getAnnotations();
      } catch (_) { continue; }
      if (!anns || !anns.length) continue;
      const vp = page.getViewport({ scale: 1 }); // scale-1 viewport
      if (!App.state.baseViewports[pageNum - 1]) App.state.baseViewports[pageNum - 1] = vp;

      // Skip our OWN just-written markups on a round-trip? No — import lets the
      // user re-edit. We import supported subtypes and skip Link/Widget/Popup.
      for (const a of anns) {
        const mk = fromPdfAnnotation(vp, pageNum, a);
        if (mk) { App.state.annotations.push(mk); imported++; }
      }
    }
    if (imported) {
      App.$('#btn-save').disabled = false;
      if (App.Markup) { App.Markup.repositionAll(); App.Markup.renderPanel && App.Markup.renderPanel(); }
    }
    return imported;
  };

  // Reverse map: PDF user-space point -> scale-1 viewport point.
  function toVP(vp, x, y) {
    const p = vp.convertToViewportPoint(x, y);
    return { vx: p[0], vy: p[1] };
  }
  function rgbHex(arr) {
    if (!arr || arr.length < 3) return '#e5342b';
    const c = (v) => ('0' + Math.round(v * 255).toString(16)).slice(-2);
    return '#' + c(arr[0]) + c(arr[1]) + c(arr[2]);
  }

  function fromPdfAnnotation(vp, pageNum, a) {
    const sub = a.subtype;
    const stroke = rgbHex(a.color && a.color.map((v) => v / 255));
    const fill = rgbHex(a.interiorColor && a.interiorColor.map((v) => v / 255));
    const width = (a.borderStyle && a.borderStyle.width) || 2;
    const style = { stroke, fill, width, opacity: 1, arrow: 'none', font: 'Helvetica', fontSize: 14 };
    const base = { id: ++App.state.annotSeq, page: pageNum, style, author: a.titleObj && a.titleObj.str || 'Imported', comment: (a.contentsObj && a.contentsObj.str) || '', status: '' };
    const R = a.rect; // [x1,y1,x2,y2] user space

    if (sub === 'Square') {
      return Object.assign(base, { type: 'rect', pts: [toVP(vp, R[0], R[3]), toVP(vp, R[2], R[1])] });
    }
    if (sub === 'Circle') {
      return Object.assign(base, { type: 'ellipse', pts: [toVP(vp, R[0], R[3]), toVP(vp, R[2], R[1])] });
    }
    if (sub === 'Line' && a.lineCoordinates) {
      const L = a.lineCoordinates;
      style.arrow = 'end';
      return Object.assign(base, { type: 'line', pts: [toVP(vp, L[0], L[1]), toVP(vp, L[2], L[3])] });
    }
    if ((sub === 'PolyLine' || sub === 'Polygon') && a.vertices) {
      const pts = a.vertices.map((v) => toVP(vp, v.x, v.y));
      return Object.assign(base, { type: sub === 'Polygon' ? 'polygon' : 'polyline', pts });
    }
    if (sub === 'Ink' && a.inkLists && a.inkLists.length) {
      const path = a.inkLists[0].map((v) => toVP(vp, v.x, v.y));
      if (path.length < 2) return null;
      return Object.assign(base, { type: 'ink', pts: path });
    }
    if (sub === 'Highlight' && a.quadPoints && a.quadPoints.length) {
      const q = a.quadPoints[0]; // {x,y} corners: TL,TR,BL,BR (pdf.js normalizes)
      const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
      style.fill = stroke;
      return Object.assign(base, {
        type: 'highlight',
        pts: [toVP(vp, Math.min(...xs), Math.max(...ys)), toVP(vp, Math.max(...xs), Math.min(...ys))]
      });
    }
    if (sub === 'Underline' || sub === 'StrikeOut') {
      const src = a.quadPoints && a.quadPoints[0];
      let pts;
      if (src) {
        const xs = src.map((p) => p.x), ys = src.map((p) => p.y);
        pts = [toVP(vp, Math.min(...xs), Math.max(...ys)), toVP(vp, Math.max(...xs), Math.min(...ys))];
      } else {
        pts = [toVP(vp, R[0], R[3]), toVP(vp, R[2], R[1])];
      }
      return Object.assign(base, { type: sub === 'Underline' ? 'underline' : 'strikeout', pts });
    }
    if (sub === 'FreeText') {
      const box = toVP(vp, R[0], R[3]); // top-left
      const text = (a.contentsObj && a.contentsObj.str) || '';
      if (a.calloutLine && a.calloutLine.length >= 2) {
        const cl = a.calloutLine;
        return Object.assign(base, { type: 'callout', text, pts: [toVP(vp, cl[0], cl[1]), box] });
      }
      return Object.assign(base, { type: 'text', text, pts: [box] });
    }
    return null; // unsupported subtype
  }

  App.Interop = I;
})();
