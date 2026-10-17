'use strict';

/*
 * Snapshot — Revu's Snapshot tool (G). Drag a box over a page; that area of
 * the rendered sheet is copied to the system clipboard as a PNG and armed as
 * an image to paste: the next click drops it on any page (a normal image
 * placement, so it moves, resizes and saves like a stamp).
 *
 * The capture comes from the page canvas PDF.js already rendered, at the
 * current zoom, so a closer zoom gives a sharper snapshot. Markups are not
 * part of the canvas and are not captured (Revu makes that optional too).
 */
(function () {
  const N = {};
  let box = null, drag = null;

  N.start = function () {
    if (!App.state.pdfDoc) return;
    App.setMode('snapshot');
    App.toast('Snapshot: drag a box over the area to copy. Esc cancels.', 'info', 3500);
  };

  function pageAt(e) {
    const div = e.target.closest && e.target.closest('.page');
    if (!div) return null;
    const canvas = div.querySelector('canvas');
    return canvas ? { div, canvas, page: parseInt(div.dataset.pageNumber, 10) } : null;
  }

  function onDown(e) {
    if (App.state.mode !== 'snapshot' || e.button > 0) return;
    const hit = pageAt(e);
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    drag = { x0: e.clientX, y0: e.clientY, hit };
    if (!box) { box = document.createElement('div'); box.id = 'snapshot-box'; document.body.appendChild(box); }
    box.classList.remove('hidden');
    paint(e);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }
  function paint(e) {
    const x = Math.min(drag.x0, e.clientX), y = Math.min(drag.y0, e.clientY);
    Object.assign(box.style, { left: x + 'px', top: y + 'px',
      width: Math.abs(e.clientX - drag.x0) + 'px', height: Math.abs(e.clientY - drag.y0) + 'px' });
  }
  function onMove(e) { if (drag) paint(e); }
  async function onUp(e) {
    window.removeEventListener('pointermove', onMove);
    if (box) box.classList.add('hidden');
    const d = drag; drag = null;
    if (!d) return;
    const r = { x0: Math.min(d.x0, e.clientX), y0: Math.min(d.y0, e.clientY),
      x1: Math.max(d.x0, e.clientX), y1: Math.max(d.y0, e.clientY) };
    if (r.x1 - r.x0 < 4 || r.y1 - r.y0 < 4) { App.toast('Drag a larger box to take a snapshot.', 'info'); return; }
    const shot = N.capture(d.hit.canvas, r);
    if (!shot) { App.toast('Nothing to capture there.', 'error'); return; }
    await N.deliver(shot);
  }

  // Crop a client-space rectangle out of a page canvas. Returns
  // { dataUrl, aspect, widthPt } or null when the box misses the canvas.
  N.capture = function (canvas, r) {
    const cr = canvas.getBoundingClientRect();
    const x0 = Math.max(r.x0, cr.left), y0 = Math.max(r.y0, cr.top);
    const x1 = Math.min(r.x1, cr.right), y1 = Math.min(r.y1, cr.bottom);
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    const sx = canvas.width / cr.width, sy = canvas.height / cr.height;
    const w = Math.round((x1 - x0) * sx), h = Math.round((y1 - y0) * sy);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, Math.round((x0 - cr.left) * sx), Math.round((y0 - cr.top) * sy), w, h, 0, 0, w, h);
    const z = App.state.zoom || 1;
    return { dataUrl: out.toDataURL('image/png'), aspect: w / h, widthPt: (x1 - x0) / z, canvas: out };
  };

  // Clipboard first (best effort: Android WebViews and some browsers refuse
  // image writes), then arm the paste so the snapshot is usable everywhere.
  N.deliver = async function (shot) {
    let copied = false;
    try {
      if (navigator.clipboard && window.ClipboardItem && shot.canvas) {
        const blob = await new Promise((res) => shot.canvas.toBlob(res, 'image/png'));
        if (blob) { await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]); copied = true; }
      }
    } catch (_) { /* clipboard refused; the paste below still works */ }
    App.Placement.arm({ type: 'image', dataUrl: shot.dataUrl, aspect: shot.aspect, defaultWidthPt: Math.max(24, shot.widthPt) });
    App.setMode('stamp');
    App.toast((copied ? 'Snapshot copied to the clipboard. ' : 'Snapshot taken. ') + 'Click on any page to paste it, or Esc to skip.', 'success', 4500);
    return copied;
  };

  N.init = function () {
    const v = App.$('#viewer');
    if (v) v.addEventListener('pointerdown', onDown, true);
  };

  App.Snapshot = N;
})();
