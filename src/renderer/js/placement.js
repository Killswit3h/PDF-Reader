'use strict';

/*
 * Placement layer. A "placement" is stored in scale-1 viewport points
 * (top-left origin) so it survives zoom changes untouched:
 *
 *   { id, type:'image'|'date', page, vx, vy, vw, vh,
 *     dataUrl, aspect,            // image
 *     text, fontPt }              // date/text
 *
 * On every (re)render we rebuild the DOM from this data, scaling by zoom.
 * save.js converts vx/vy/vw/vh to PDF user space via viewport.convertToPdfPoint.
 */
(function () {
  const DATE_FONT_FAMILY = "'Segoe UI', system-ui, sans-serif";
  // No placement limits: a signature / date / text item can be positioned
  // ANYWHERE on the page — fully into the margins or overhanging any edge — with
  // no forced sliver kept on-page. (Markups are likewise unclamped.) Undo
  // (Ctrl+Z), arrow-key nudge, or the item's ✕ recover a stray item.
  // `size`/`extent` are kept in the signature for call-site compatibility.
  function clampAxis(v /* , size, extent */) {
    return v;
  }

  const P = {
    pending: null // { type:'image'|'date', dataUrl, aspect, kind }
  };

  // ---------- Arm a placement (called by toolbar buttons) ----------
  // For images: payload = { type:'image', dataUrl, aspect, defaultWidthPt }
  // For date  : payload = { type:'date' }
  P.arm = function (payload) {
    P.pending = payload;
    const holders = App.$$('.page-holder');
    holders.forEach((h) => h.classList.add('placing'));
  };

  P.disarm = function () {
    P.pending = null;
    App.$$('.page-holder').forEach((h) => h.classList.remove('placing'));
  };

  // ---------- Overlay click => create placement ----------
  P.handleOverlayClick = function (page, overlay, e) {
    if (!P.pending) return;
    const rect = overlay.getBoundingClientRect();
    const z = App.state.zoom;
    const cx = (e.clientX - rect.left) / z; // click in viewport points
    const cy = (e.clientY - rect.top) / z;

    const vpHeight = App.state.baseViewports[page - 1].height;
    const vpWidth = App.state.baseViewports[page - 1].width;

    let p;
    if (P.pending.type === 'image') {
      const vw = P.pending.defaultWidthPt;
      const vh = vw / (P.pending.aspect || 3);
      p = {
        id: ++App.state.placementSeq,
        type: 'image',
        page,
        vx: clampAxis(cx - vw / 2, vw, vpWidth),
        vy: clampAxis(cy - vh / 2, vh, vpHeight),
        vw, vh,
        dataUrl: P.pending.dataUrl,
        aspect: P.pending.aspect
      };
    } else {
      const fontPt = 14;
      const text = App.todayFormatted();
      const vw = measureTextPt(text, fontPt);
      const vh = fontPt * 1.35;
      p = {
        id: ++App.state.placementSeq,
        type: 'date',
        page,
        vx: clampAxis(cx, vw, vpWidth),
        vy: clampAxis(cy - vh / 2, vh, vpHeight),
        vw, vh,
        text,
        fontPt
      };
    }

    App.History.snapshot();
    App.state.placements.push(p);
    P.repositionAll();
    P.select(p.id);
    App.$('#btn-save').disabled = false;

    // Date items open straight into edit mode so the user can adjust text.
    if (p.type === 'date') {
      const el = elFor(p.id);
      if (el) startDateEdit(p, el.querySelector('.date-text'));
    }

    // Placement is one-shot: disarm and clear the toolbar mode.
    P.disarm();
    App.setMode(null);
  };

  // ---------- Measure text width in viewport points ----------
  let measureCtx = null;
  function measureTextPt(text, fontPt) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `${fontPt}px ${DATE_FONT_FAMILY}`;
    return Math.ceil(measureCtx.measureText(text || ' ').width) + 4;
  }

  // ---------- Build DOM for all placements ----------
  P.repositionAll = function () {
    // Clear existing placement DOM from every overlay.
    App.state.pageEls.forEach((pe) => {
      if (pe && pe.overlay) {
        pe.overlay.querySelectorAll('.placed').forEach((n) => n.remove());
      }
    });
    App.state.placements.forEach((p) => renderOne(p));
  };

  function elFor(id) {
    return document.querySelector(`.placed[data-id="${id}"]`);
  }

  function renderOne(p) {
    const pe = App.state.pageEls[p.page - 1];
    if (!pe) return;
    const z = App.state.zoom;

    const el = document.createElement('div');
    el.className = 'placed' + (App.state.selectedId === p.id ? ' selected' : '');
    el.dataset.id = String(p.id);
    el.style.left = `${p.vx * z}px`;
    el.style.top = `${p.vy * z}px`;
    el.style.width = `${p.vw * z}px`;
    el.style.height = `${p.vh * z}px`;

    const inner = document.createElement('div');
    inner.className = 'placed-inner';
    if (p.type === 'image') {
      const img = document.createElement('img');
      img.src = p.dataUrl;
      inner.appendChild(img);
    } else {
      const t = document.createElement('div');
      t.className = 'date-text';
      t.style.fontSize = `${p.fontPt * z}px`;
      t.style.fontFamily = DATE_FONT_FAMILY;
      t.textContent = p.text;
      inner.appendChild(t);
    }
    el.appendChild(inner);

    const move = document.createElement('div');
    move.className = 'move-layer';
    el.appendChild(move);

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.textContent = '✕';
    del.title = 'Delete';
    el.appendChild(del);

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    el.appendChild(handle);

    pe.overlay.appendChild(el);

    // ---- interactions ----
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      P.select(p.id);
    });
    del.addEventListener('click', (e) => { e.stopPropagation(); P.remove(p.id); });
    move.addEventListener('pointerdown', (e) => startDrag(e, p));
    handle.addEventListener('pointerdown', (e) => startResize(e, p));

    if (p.type === 'date') {
      const textEl = inner.querySelector('.date-text');
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startDateEdit(p, textEl);
      });
    }
  }

  // ---------- Selection ----------
  P.select = function (id) {
    App.state.selectedId = id;
    App.$$('.placed').forEach((n) =>
      n.classList.toggle('selected', n.dataset.id === String(id)));
  };
  P.deselect = function () {
    App.state.selectedId = null;
    App.$$('.placed').forEach((n) => n.classList.remove('selected'));
  };

  // ---------- Keyboard nudge (arrow keys) ----------
  P.nudge = function (dx, dy) {
    const p = App.state.placements.find((x) => x.id === App.state.selectedId);
    if (!p) return;
    App.History.snapshot();
    const vp = App.state.baseViewports[p.page - 1];
    p.vx = clampAxis(p.vx + dx, p.vw, vp.width);
    p.vy = clampAxis(p.vy + dy, p.vh, vp.height);
    P.repositionAll();
  };

  // ---------- Remove ----------
  P.remove = function (id) {
    App.History.snapshot();
    App.state.placements = App.state.placements.filter((p) => p.id !== id);
    const el = elFor(id);
    if (el) el.remove();
    if (App.state.selectedId === id) App.state.selectedId = null;
    if (!App.state.placements.length) App.$('#btn-save').disabled = false; // still allow saving a copy
  };

  // ---------- Drag ----------
  function startDrag(e, p) {
    e.preventDefault();
    e.stopPropagation();
    P.select(p.id);
    const z = App.state.zoom;
    const startX = e.clientX, startY = e.clientY;
    const ox = p.vx, oy = p.vy;
    const vp = App.state.baseViewports[p.page - 1];
    const el = elFor(p.id);
    el.classList.add('dragging');
    let snapped = false;

    function onMove(ev) {
      if (!snapped) { App.History.snapshot(); snapped = true; }
      let dx = (ev.clientX - startX) / z;
      let dy = (ev.clientY - startY) / z;
      // Shift → orthogonal drag (lock to the dominant axis).
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      p.vx = clampAxis(ox + dx, p.vw, vp.width);
      p.vy = clampAxis(oy + dy, p.vh, vp.height);
      el.style.left = `${p.vx * z}px`;
      el.style.top = `${p.vy * z}px`;
    }
    function onUp() {
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ---------- Resize ----------
  function startResize(e, p) {
    e.preventDefault();
    e.stopPropagation();
    P.select(p.id);
    const z = App.state.zoom;
    const startX = e.clientX;
    const startW = p.vw;
    const startFont = p.fontPt;
    const vp = App.state.baseViewports[p.page - 1];
    const el = elFor(p.id);
    let snapped = false;

    function onMove(ev) {
      if (!snapped) { App.History.snapshot(); snapped = true; }
      const dx = (ev.clientX - startX) / z;
      if (p.type === 'image') {
        // Size freely (may overhang the edge); just keep it sane.
        const w = App.clamp(startW + dx, 24, vp.width * 2);
        p.vw = w; p.vh = w / p.aspect;
      } else {
        // Date: width drives font size.
        const w = App.clamp(startW + dx, 20, vp.width * 2);
        const scale = w / startW;
        p.fontPt = App.clamp(startFont * scale, 6, 96);
        p.vw = measureTextPt(p.text, p.fontPt);
        p.vh = p.fontPt * 1.35;
        const txt = el.querySelector('.date-text');
        if (txt) txt.style.fontSize = `${p.fontPt * z}px`;
      }
      el.style.width = `${p.vw * z}px`;
      el.style.height = `${p.vh * z}px`;
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ---------- Inline date editing ----------
  function startDateEdit(p, textEl) {
    if (!textEl) return;
    textEl.setAttribute('contenteditable', 'true');
    textEl.style.outline = '1px solid #2f6fed';
    textEl.focus();
    // select all
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function commit() {
      textEl.removeAttribute('contenteditable');
      textEl.style.outline = 'none';
      const val = textEl.textContent.trim() || App.todayFormatted();
      p.text = val;
      p.vw = measureTextPt(p.text, p.fontPt);
      const el = elFor(p.id);
      if (el) el.style.width = `${p.vw * App.state.zoom}px`;
      textEl.textContent = p.text;
      textEl.removeEventListener('blur', commit);
      textEl.removeEventListener('keydown', onKey);
    }
    function onKey(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); textEl.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); textEl.blur(); }
    }
    textEl.addEventListener('blur', commit);
    textEl.addEventListener('keydown', onKey);
  }

  App.Placement = P;
})();
