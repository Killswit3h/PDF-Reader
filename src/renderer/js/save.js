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

  // Build the final PDF bytes with all placements flattened onto their pages.
  S.buildBytes = async function () {
    const { PDFDocument, StandardFonts, degrees, rgb } = window.PDFLib;

    const pdfDoc = await PDFDocument.load(App.state.pdfBytes);
      const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

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

      return await pdfDoc.save();
  };

  // Save: overwrite the file that was opened, in place, with no dialog.
  // Falls back to Save As when there's no known path (e.g. dropped bytes).
  S.save = () => doSave(false);

  // Save As: always prompt for a location / name.
  S.saveAs = () => doSave(true);

  async function doSave(forceDialog) {
    if (!App.state.pdfDoc) return;
    App.showLoading('Saving…');
    try {
      const bytes = await S.buildBytes();
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
