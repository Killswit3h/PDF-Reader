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

  // Build the final PDF bytes.
  //   mode 'flatten'  (default): draw everything as static vector graphics.
  //   mode 'editable': signatures/dates/measurements flatten, but markup
  //                    annotations are written as real, re-editable PDF
  //                    annotation dictionaries (see interop.js).
  S.buildBytes = async function (mode) {
    mode = mode || 'flatten';
    const { PDFDocument, StandardFonts, degrees, rgb } = window.PDFLib;

    const pdfDoc = await PDFDocument.load(App.state.pdfBytes);
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
        const color = hexRgb(M_COLORS[m.type] || '#2f6fed');
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

      // ---- markup annotations ----
      if (mode === 'editable' && App.Interop) {
        // Write real, re-editable PDF annotation dicts (with appearance streams).
        App.Interop.writeAnnotations(pdfDoc);
      } else {
        // Flatten as static vector graphics.
        await S.flattenAnnotations(pdfDoc, helv);
      }

      return await pdfDoc.save();
  };

  // Flatten markup annotations onto their pages as vector graphics.
  // Geometry maps from scale-1 viewport points to PDF user space via
  // viewport.convertToPdfPoint (rotation-safe), identical to placements.
  S.flattenAnnotations = async function (pdfDoc, helv) {
    const { rgb, degrees } = window.PDFLib;
    const toRgb = (hex) => hexRgb(hex || '#000000');

    for (const ann of App.state.annotations) {
      const vp = App.state.baseViewports[ann.page - 1];
      if (!vp) continue;
      const page = pdfDoc.getPage(ann.page - 1);
      const s = ann.style || {};
      const stroke = toRgb(s.stroke);
      const fill = toRgb(s.fill);
      const width = s.width || 2;
      const opacity = s.opacity == null ? 1 : s.opacity;
      // map every vertex to PDF user space
      const P = ann.pts.map((pt) => vp.convertToPdfPoint(pt.vx, pt.vy));
      const seg = (a, b, w, col, op) => page.drawLine({
        start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] },
        thickness: w == null ? width : w, color: col || stroke, opacity: op == null ? opacity : op
      });

      if (ann.type === 'line' || ann.type === 'arrow') {
        seg(P[0], P[1]);
        const wantEnd = ann.type === 'arrow' || s.arrow === 'end' || s.arrow === 'both';
        if (wantEnd) drawArrowHead(page, P[0], P[1], stroke, width, opacity);
        if (s.arrow === 'both') drawArrowHead(page, P[1], P[0], stroke, width, opacity);
      } else if (ann.type === 'rect' || ann.type === 'highlight') {
        // axis-aligned in viewport space -> map 3 corners
        const b = bbox2(ann.pts);
        const A = vp.convertToPdfPoint(b.minx, b.miny);
        const B = vp.convertToPdfPoint(b.minx, b.maxy);
        const C = vp.convertToPdfPoint(b.maxx, b.maxy);
        const w = Math.hypot(C[0] - B[0], C[1] - B[1]);
        const h = Math.hypot(A[0] - B[0], A[1] - B[1]);
        const rot = degrees(Math.atan2(C[1] - B[1], C[0] - B[0]) * 180 / Math.PI);
        if (ann.type === 'highlight') {
          page.drawRectangle({ x: B[0], y: B[1], width: w, height: h, rotate: rot, color: fill, opacity: 0.4 });
        } else {
          page.drawRectangle({
            x: B[0], y: B[1], width: w, height: h, rotate: rot,
            borderColor: stroke, borderWidth: width, borderOpacity: opacity,
            color: fill, opacity: Math.min(0.35, opacity * 0.35)
          });
        }
      } else if (ann.type === 'ellipse') {
        const b = bbox2(ann.pts);
        const c = vp.convertToPdfPoint((b.minx + b.maxx) / 2, (b.miny + b.maxy) / 2);
        const ex = vp.convertToPdfPoint(b.maxx, (b.miny + b.maxy) / 2);
        const ey = vp.convertToPdfPoint((b.minx + b.maxx) / 2, b.miny);
        const rx = Math.hypot(ex[0] - c[0], ex[1] - c[1]);
        const ry = Math.hypot(ey[0] - c[0], ey[1] - c[1]);
        page.drawEllipse({
          x: c[0], y: c[1], xScale: rx, yScale: ry,
          borderColor: stroke, borderWidth: width, borderOpacity: opacity,
          color: fill, opacity: Math.min(0.35, opacity * 0.35)
        });
      } else if (ann.type === 'polyline' || ann.type === 'ink') {
        for (let i = 0; i < P.length - 1; i++) seg(P[i], P[i + 1]);
      } else if (ann.type === 'polygon') {
        for (let i = 0; i < P.length - 1; i++) seg(P[i], P[i + 1]);
        if (P.length > 2) seg(P[P.length - 1], P[0]);
      } else if (ann.type === 'cloud') {
        // approximate the cloud outline with its straight polygon edges
        const closed = P.concat([P[0]]);
        for (let i = 0; i < closed.length - 1; i++) seg(closed[i], closed[i + 1]);
      } else if (ann.type === 'underline' || ann.type === 'strikeout') {
        const b = bbox2(ann.pts);
        const yv = ann.type === 'underline' ? b.maxy - 1 : (b.miny + b.maxy) / 2;
        const a = vp.convertToPdfPoint(b.minx, yv);
        const c = vp.convertToPdfPoint(b.maxx, yv);
        seg(a, c, Math.max(1.5, width), stroke, 1);
      } else if (ann.type === 'text' || ann.type === 'callout') {
        drawTextBox(page, vp, ann, helv, stroke, width, degrees);
      }
    }
  };

  function bbox2(pts) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    pts.forEach((p) => {
      if (p.vx < minx) minx = p.vx; if (p.vy < miny) miny = p.vy;
      if (p.vx > maxx) maxx = p.vx; if (p.vy > maxy) maxy = p.vy;
    });
    return { minx, miny, maxx, maxy };
  }

  function drawArrowHead(page, from, to, color, width, opacity) {
    const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const size = 5 + width * 2;
    const left = [to[0] - size * Math.cos(ang - 0.4), to[1] - size * Math.sin(ang - 0.4)];
    const right = [to[0] - size * Math.cos(ang + 0.4), to[1] - size * Math.sin(ang + 0.4)];
    page.drawLine({ start: { x: to[0], y: to[1] }, end: { x: left[0], y: left[1] }, thickness: width, color, opacity });
    page.drawLine({ start: { x: to[0], y: to[1] }, end: { x: right[0], y: right[1] }, thickness: width, color, opacity });
  }

  function drawTextBox(page, vp, ann, helv, stroke, width, degrees) {
    const s = ann.style || {};
    const box = ann.type === 'callout' ? ann.pts[1] : ann.pts[0];
    const fontPt = s.fontSize || 14;
    if (ann.type === 'callout' && ann.pts[0]) {
      const tip = vp.convertToPdfPoint(ann.pts[0].vx, ann.pts[0].vy);
      const corner = vp.convertToPdfPoint(box.vx, box.vy);
      page.drawLine({ start: { x: tip[0], y: tip[1] }, end: { x: corner[0], y: corner[1] }, thickness: width, color: stroke });
    }
    const lines = String(ann.text || '').split('\n');
    lines.forEach((ln, i) => {
      const baselineY = box.vy + fontPt * (i + 1) * 1.1;
      const anchor = vp.convertToPdfPoint(box.vx + 3, baselineY);
      const dir = vp.convertToPdfPoint(box.vx + 4, baselineY);
      const rot = degrees(Math.atan2(dir[1] - anchor[1], dir[0] - anchor[0]) * 180 / Math.PI);
      page.drawText(ln, { x: anchor[0], y: anchor[1], size: fontPt, font: helv, color: stroke, rotate: rot });
    });
  }

  // Current export mode: 'flatten' (default) or 'editable'.
  S.exportMode = 'flatten';

  // Save: overwrite the file that was opened, in place, with no dialog.
  // Falls back to Save As when there's no known path (e.g. dropped bytes).
  S.save = () => doSave(false, S.exportMode);

  // Save As: always prompt for a location / name.
  S.saveAs = () => doSave(true, S.exportMode);

  // Explicit-mode entry points (used by the Save dropdown).
  S.saveFlatten = () => { S.exportMode = 'flatten'; doSave(false, 'flatten'); };
  S.saveEditable = () => { S.exportMode = 'editable'; doSave(true, 'editable'); };

  async function doSave(forceDialog, mode) {
    if (!App.state.pdfDoc) return;
    App.showLoading('Saving…');
    try {
      const bytes = await S.buildBytes(mode);
      const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');

      if (!forceDialog && App.state.filePath) {
        // Overwrite the opened document in place.
        const res = await window.api.writePdf(App.state.filePath, bytes);
        if (res && res.ok) App.toast(`Saved: ${res.path}`, 'success', 4000);
        else if (res && res.error) App.toast(`Could not save: ${res.error}`, 'error', 6000);
      } else {
        const res = await window.api.savePdfDialog(`${base}-signed.pdf`, bytes);
        if (res && res.ok) {
          App.toast(`Saved: ${res.path}`, 'success', 5000);
          // Remember the new location so later Saves overwrite it too.
          App.state.filePath = res.path;
          App.state.fileName = res.path.replace(/^.*[\\/]/, '');
        } else if (res && res.error) {
          App.toast(`Could not save: ${res.error}`, 'error', 6000);
        }
      }
    } catch (err) {
      console.error(err);
      App.toast('Failed to save the PDF. ' + (err.message || ''), 'error', 6000);
    } finally {
      App.hideLoading();
    }
  }

  App.Save = S;
})();
