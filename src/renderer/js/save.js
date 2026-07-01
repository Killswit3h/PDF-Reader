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

      return await pdfDoc.save();
  };

  S.save = async function () {
    if (!App.state.pdfDoc) return;
    App.showLoading('Saving…');
    try {
      const bytes = await S.buildBytes();
      const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
      const res = await window.api.savePdfDialog(`${base}-signed.pdf`, bytes);
      if (res && res.ok) {
        App.toast(`Saved: ${res.path}`, 'success', 5000);
      } else if (res && res.error) {
        App.toast(`Could not save: ${res.error}`, 'error', 6000);
      }
    } catch (err) {
      console.error(err);
      App.toast('Failed to save the PDF. ' + (err.message || ''), 'error', 6000);
    } finally {
      App.hideLoading();
    }
  };

  App.Save = S;
})();
