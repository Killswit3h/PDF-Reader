'use strict';

/*
 * Markup / annotation engine (Phase 2).
 *
 * Generalizes measure.js's SVG-per-page model into a reusable vector markup
 * layer. All geometry lives in scale-1 viewport points (top-left origin), the
 * same space as placements/measurements — so it renders at `pt * zoom` and
 * exports to PDF user space via viewport.convertToPdfPoint (see save.js).
 *
 * Annotation record (App.state.annotations):
 *   { id, page, type, pts:[{vx,vy}],
 *     style:{stroke,fill,width,opacity,arrow,font,fontSize},
 *     text, author, comment, status }
 *
 * type ∈ line | arrow | rect | ellipse | cloud | polygon | polyline | ink |
 *        text | callout | highlight | underline | strikeout
 *
 * Undo/redo is a command stack of snapshots (the annotation array is small).
 */
(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';

  // Which tools finish with a fixed number of clicks vs. multi-vertex (Enter/dblclick).
  const FIXED_PTS = { line: 2, arrow: 2, rect: 2, ellipse: 2, callout: 2, text: 1 };
  const MULTI = { polygon: true, polyline: true, cloud: true };
  const CLOSED = { rect: true, ellipse: true, cloud: true, polygon: true };
  const TEXTUAL = { text: true, callout: true };
  const TEXT_MARKUP = { highlight: true, underline: true, strikeout: true };

  const K = {
    _tool: null,       // active drawing tool or null
    _active: null,     // { tool, page, pts:[{vx,vy}], hover, style }
    _ink: null,        // freehand capture buffer { page, pts, style, layerEl }
    _drag: null,       // active move/resize gesture
    _undo: [],
    _redo: []
  };

  /* ---------------- geometry helpers (scale-1 points) ---------------- */
  const dist = (a, b) => Math.hypot(b.vx - a.vx, b.vy - a.vy);
  function bbox(pts) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    pts.forEach((p) => {
      if (p.vx < minx) minx = p.vx; if (p.vy < miny) miny = p.vy;
      if (p.vx > maxx) maxx = p.vx; if (p.vy > maxy) maxy = p.vy;
    });
    return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny };
  }
  function rectPts(a, b) {
    return [
      { vx: Math.min(a.vx, b.vx), vy: Math.min(a.vy, b.vy) },
      { vx: Math.max(a.vx, b.vx), vy: Math.max(a.vy, b.vy) }
    ];
  }

  /* ---------------- undo / redo ---------------- */
  function snapshot() {
    return JSON.stringify(App.state.annotations);
  }
  function pushUndo() {
    K._undo.push(snapshot());
    if (K._undo.length > 100) K._undo.shift();
    K._redo.length = 0;
    updateUndoButtons();
  }
  K.undo = function () {
    if (!K._undo.length) return;
    K._redo.push(snapshot());
    App.state.annotations = JSON.parse(K._undo.pop());
    App.state.annotSelectedId = null;
    updateUndoButtons();
    K.repositionAll();
    K.renderPanel && K.renderPanel();
  };
  K.redo = function () {
    if (!K._redo.length) return;
    K._undo.push(snapshot());
    App.state.annotations = JSON.parse(K._redo.pop());
    App.state.annotSelectedId = null;
    updateUndoButtons();
    K.repositionAll();
    K.renderPanel && K.renderPanel();
  };
  function updateUndoButtons() {
    const u = App.$('#mk-undo'), r = App.$('#mk-redo');
    if (u) u.disabled = !K._undo.length;
    if (r) r.disabled = !K._redo.length;
  }

  /* ---------------- tool lifecycle ---------------- */
  K.startTool = function (tool) {
    K._commitActive();
    if (TEXT_MARKUP[tool]) { startTextMarkup(tool); return; }
    K._tool = tool;
    K._active = null;
    App.setMode('markup');
    showPropsBar(true);
    const hint = MULTI[tool]
      ? `click to add points — Enter/double-click to finish, Esc to cancel`
      : tool === 'ink' ? 'draw freehand — release to finish'
        : tool === 'text' ? 'click to place a text box'
          : 'click two points';
    App.toast(`Markup: ${tool} — ${hint}`, 'info', 4000);
  };

  K.stop = function () {
    K._commitActive();
    K._tool = null;
    K._active = null;
    K._ink = null;
    showPropsBar(false);
    K.repositionAll();
  };

  K.cancelActive = function () {
    K._active = null;
    K._ink = null;
    K.repositionAll();
  };

  K._commitActive = function () {
    const a = K._active;
    K._active = null;
    if (!a || !a.pts || !a.pts.length) return;
    if (MULTI[a.tool]) {
      const need = a.tool === 'polyline' ? 2 : 3;
      if (a.pts.length < need) return;
      finalize(a);
    }
  };

  function finalize(a) {
    pushUndo();
    const ann = {
      id: ++App.state.annotSeq,
      page: a.page,
      type: a.tool,
      pts: a.pts.map((p) => ({ vx: p.vx, vy: p.vy })),
      style: Object.assign({}, App.state.markupStyle),
      text: TEXTUAL[a.tool] ? (a.text || 'Text') : undefined,
      author: App.state.author,
      comment: '',
      status: ''
    };
    App.state.annotations.push(ann);
    App.$('#btn-save').disabled = false;
    K.repositionAll();
    K.select(ann.id);
    K.renderPanel && K.renderPanel();
    // Text/callout: drop straight into edit mode.
    if (TEXTUAL[a.tool]) startTextEdit(ann);
  }

  /* ---------------- interaction (from app.js delegation) ---------------- */
  K.handleClick = function (page, layer, e) {
    const tool = K._tool;
    if (!tool || tool === 'ink') return;
    const p = pointFromEvent(layer, e);

    if (!K._active || K._active.page !== page) K._active = { tool, page, pts: [] };
    if (K._active.page !== page) return;

    // de-dupe accidental double register
    const last = K._active.pts[K._active.pts.length - 1];
    if (last && dist(last, p) < 1.2) { K.repositionAll(); return; }

    K._active.pts.push({ vx: p.vx, vy: p.vy });

    const fixed = FIXED_PTS[tool];
    if (fixed && K._active.pts.length >= fixed) {
      const a = K._active; K._active = null; finalize(a);
    } else {
      K.repositionAll();
    }
  };

  K.handleMove = function (page, layer, e) {
    if (!K._active || K._active.page !== page || !K._active.pts.length) return;
    K._active.hover = pointFromEvent(layer, e);
    K.repositionAll();
  };

  K.finishDrawing = function () {
    if (!K._active) return;
    K._commitActive();
    K.repositionAll();
  };

  /* ---------------- freehand ink (pointer capture) ---------------- */
  // Reuses the same math signature_pad uses: sample points on pointermove.
  K.handlePointerDown = function (page, layer, e) {
    if (K._tool !== 'ink') return false;
    e.preventDefault();
    const p = pointFromEvent(layer, e);
    K._ink = { page, pts: [{ vx: p.vx, vy: p.vy }], style: Object.assign({}, App.state.markupStyle) };
    try { layer.setPointerCapture(e.pointerId); } catch (_) {}
    K._ink._pointerId = e.pointerId;
    K._ink._layer = layer;
    layer.addEventListener('pointermove', onInkMove);
    layer.addEventListener('pointerup', onInkUp);
    layer.addEventListener('pointercancel', onInkUp);
    return true;
  };
  function onInkMove(e) {
    if (!K._ink) return;
    const p = pointFromEvent(K._ink._layer, e);
    const last = K._ink.pts[K._ink.pts.length - 1];
    if (!last || Math.hypot(p.vx - last.vx, p.vy - last.vy) > 1.0) {
      K._ink.pts.push({ vx: p.vx, vy: p.vy });
      K.repositionAll();
    }
  }
  function onInkUp() {
    const ink = K._ink;
    if (!ink) return;
    const layer = ink._layer;
    layer.removeEventListener('pointermove', onInkMove);
    layer.removeEventListener('pointerup', onInkUp);
    layer.removeEventListener('pointercancel', onInkUp);
    K._ink = null;
    if (ink.pts.length >= 2) {
      pushUndo();
      const ann = {
        id: ++App.state.annotSeq, page: ink.page, type: 'ink',
        pts: ink.pts, style: ink.style,
        author: App.state.author, comment: '', status: ''
      };
      App.state.annotations.push(ann);
      App.$('#btn-save').disabled = false;
      K.repositionAll();
      K.select(ann.id);
      K.renderPanel && K.renderPanel();
    } else {
      K.repositionAll();
    }
  }

  /* ---------------- text-selection markup (highlight/underline/strikeout) --- */
  function startTextMarkup(tool) {
    K._tool = null;
    App.setMode(null);
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      App.toast('Select text first, then choose ' + tool + '.', 'info', 4000);
      return;
    }
    const rects = collectSelectionRects(sel);
    if (!rects.length) { App.toast('Could not map the selection to a page.', 'error'); return; }
    pushUndo();
    rects.forEach((r) => {
      App.state.annotations.push({
        id: ++App.state.annotSeq, page: r.page, type: tool,
        pts: [{ vx: r.vx, vy: r.vy }, { vx: r.vx + r.vw, vy: r.vy + r.vh }],
        style: Object.assign({}, App.state.markupStyle),
        text: r.text, author: App.state.author, comment: '', status: ''
      });
    });
    sel.removeAllRanges();
    App.$('#btn-save').disabled = false;
    K.repositionAll();
    K.renderPanel && K.renderPanel();
    App.toast(`${tool} added (${rects.length} line${rects.length > 1 ? 's' : ''})`, 'success');
  }

  // Map DOM selection client rects into per-page scale-1 viewport points.
  function collectSelectionRects(sel) {
    const out = [];
    const z = App.state.zoom;
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const clientRects = range.getClientRects();
      for (const cr of clientRects) {
        if (cr.width < 1 || cr.height < 1) continue;
        // find which page div contains this rect's center
        const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
        const el = document.elementFromPoint(cx, cy);
        const pageDiv = el && el.closest('.page');
        if (!pageDiv) continue;
        const page = parseInt(pageDiv.dataset.pageNumber, 10);
        const layer = pageDiv.querySelector('.markup-layer');
        if (!page || !layer) continue;
        const lr = layer.getBoundingClientRect();
        out.push({
          page,
          vx: (cr.left - lr.left) / z,
          vy: (cr.top - lr.top) / z,
          vw: cr.width / z,
          vh: cr.height / z,
          text: (range.toString() || '').slice(0, 120)
        });
      }
    }
    return out;
  }

  /* ---------------- coord mapping ---------------- */
  function pointFromEvent(layer, e) {
    const rect = layer.getBoundingClientRect();
    const z = App.state.zoom;
    const raw = { vx: (e.clientX - rect.left) / z, vy: (e.clientY - rect.top) / z };
    // Shift = ortho constraint relative to the last point.
    if (K._active && K._active.pts.length && e.shiftKey) {
      const a = K._active.pts[K._active.pts.length - 1];
      const ang = Math.round(Math.atan2(raw.vy - a.vy, raw.vx - a.vx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(raw.vx - a.vx, raw.vy - a.vy);
      return { vx: a.vx + Math.cos(ang) * len, vy: a.vy + Math.sin(ang) * len };
    }
    return raw;
  }

  /* ---------------- rendering (SVG per page) ---------------- */
  function ns(tag) { return document.createElementNS(SVGNS, tag); }

  K.repositionAll = function () {
    const z = App.state.zoom;
    App.state.pageEls.forEach((pe, i) => {
      if (!pe) return;
      const page = i + 1;
      let layer = pe.holder.querySelector('.markup-svg');
      if (layer) layer.remove();
      layer = ns('svg');
      layer.setAttribute('class', 'markup-svg');
      layer.setAttribute('width', pe.holder.style.width);
      layer.setAttribute('height', pe.holder.style.height);
      // Insert BEFORE the measure-layer/placed items so those stay clickable.
      pe.holder.insertBefore(layer, pe.holder.firstChild);

      App.state.annotations.forEach((ann) => {
        if (ann.page === page) drawAnnotation(layer, ann, z, ann.id === App.state.annotSelectedId);
      });
      if (K._active && K._active.page === page) drawPreview(layer, K._active, z);
      if (K._ink && K._ink.page === page) drawInk(layer, K._ink.pts, K._ink.style, z, false);
    });
  };

  function pathFrom(pts, z, close) {
    let d = '';
    pts.forEach((p, i) => { d += (i === 0 ? 'M' : 'L') + (p.vx * z) + ' ' + (p.vy * z) + ' '; });
    if (close) d += 'Z';
    return d;
  }

  // Revision-cloud path: scalloped arcs along the polygon edges.
  function cloudPath(pts, z, close) {
    const R = 8; // arc radius in screen px
    const segs = close ? pts.concat([pts[0]]) : pts;
    let d = `M ${segs[0].vx * z} ${segs[0].vy * z} `;
    for (let i = 0; i < segs.length - 1; i++) {
      const a = { x: segs[i].vx * z, y: segs[i].vy * z };
      const b = { x: segs[i + 1].vx * z, y: segs[i + 1].vy * z };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.round(len / (R * 2)));
      for (let j = 1; j <= n; j++) {
        const t = j / n;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        d += `A ${R} ${R} 0 0 1 ${x} ${y} `;
      }
    }
    return d;
  }

  function styleAttrs(el, style, filled) {
    el.setAttribute('stroke', style.stroke);
    el.setAttribute('stroke-width', style.width);
    el.setAttribute('stroke-opacity', style.opacity);
    el.setAttribute('fill', filled ? style.fill : 'none');
    if (filled) el.setAttribute('fill-opacity', Math.min(0.35, style.opacity * 0.35));
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
  }

  function arrowHead(layer, from, to, z, color, width) {
    const ang = Math.atan2((to.vy - from.vy), (to.vx - from.vx));
    const size = 6 + width * 2;
    const tip = { x: to.vx * z, y: to.vy * z };
    const left = { x: tip.x - size * Math.cos(ang - 0.4), y: tip.y - size * Math.sin(ang - 0.4) };
    const right = { x: tip.x - size * Math.cos(ang + 0.4), y: tip.y - size * Math.sin(ang + 0.4) };
    const poly = ns('polygon');
    poly.setAttribute('points', `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`);
    poly.setAttribute('fill', color);
    layer.appendChild(poly);
  }

  function drawInk(layer, pts, style, z) {
    const path = ns('path');
    path.setAttribute('d', pathFrom(pts, z, false));
    styleAttrs(path, style, false);
    path.setAttribute('class', 'mk-shape');
    layer.appendChild(path);
  }

  function drawAnnotation(layer, ann, z, selected) {
    const s = ann.style;
    const g = ns('g');
    g.setAttribute('class', 'mk-item' + (selected ? ' selected' : ''));
    g.dataset.id = String(ann.id);
    layer.appendChild(g);

    if (ann.type === 'line' || ann.type === 'arrow') {
      const [a, b] = ann.pts;
      const line = ns('line');
      line.setAttribute('x1', a.vx * z); line.setAttribute('y1', a.vy * z);
      line.setAttribute('x2', b.vx * z); line.setAttribute('y2', b.vy * z);
      styleAttrs(line, s, false);
      g.appendChild(line);
      if (ann.type === 'arrow' || s.arrow === 'end' || s.arrow === 'both') {
        arrowHead(g, a, b, z, s.stroke, s.width);
        if (s.arrow === 'both') arrowHead(g, b, a, z, s.stroke, s.width);
      }
    } else if (ann.type === 'rect') {
      const [p, q] = rectPts(ann.pts[0], ann.pts[1]);
      const r = ns('rect');
      r.setAttribute('x', p.vx * z); r.setAttribute('y', p.vy * z);
      r.setAttribute('width', (q.vx - p.vx) * z); r.setAttribute('height', (q.vy - p.vy) * z);
      styleAttrs(r, s, true);
      g.appendChild(r);
    } else if (ann.type === 'ellipse') {
      const [p, q] = rectPts(ann.pts[0], ann.pts[1]);
      const el = ns('ellipse');
      el.setAttribute('cx', (p.vx + q.vx) / 2 * z); el.setAttribute('cy', (p.vy + q.vy) / 2 * z);
      el.setAttribute('rx', (q.vx - p.vx) / 2 * z); el.setAttribute('ry', (q.vy - p.vy) / 2 * z);
      styleAttrs(el, s, true);
      g.appendChild(el);
    } else if (ann.type === 'polyline') {
      const path = ns('path');
      path.setAttribute('d', pathFrom(ann.pts, z, false));
      styleAttrs(path, s, false);
      g.appendChild(path);
    } else if (ann.type === 'polygon') {
      const path = ns('path');
      path.setAttribute('d', pathFrom(ann.pts, z, true));
      styleAttrs(path, s, true);
      g.appendChild(path);
    } else if (ann.type === 'cloud') {
      const path = ns('path');
      path.setAttribute('d', cloudPath(ann.pts, z, true));
      styleAttrs(path, s, true);
      g.appendChild(path);
    } else if (ann.type === 'ink') {
      const path = ns('path');
      path.setAttribute('d', pathFrom(ann.pts, z, false));
      styleAttrs(path, s, false);
      g.appendChild(path);
    } else if (ann.type === 'highlight') {
      const [p, q] = rectPts(ann.pts[0], ann.pts[1]);
      const r = ns('rect');
      r.setAttribute('x', p.vx * z); r.setAttribute('y', p.vy * z);
      r.setAttribute('width', (q.vx - p.vx) * z); r.setAttribute('height', (q.vy - p.vy) * z);
      r.setAttribute('fill', s.fill); r.setAttribute('fill-opacity', '0.4');
      r.setAttribute('stroke', 'none');
      g.appendChild(r);
    } else if (ann.type === 'underline' || ann.type === 'strikeout') {
      const [p, q] = rectPts(ann.pts[0], ann.pts[1]);
      const y = (ann.type === 'underline' ? q.vy - 1 : (p.vy + q.vy) / 2) * z;
      const line = ns('line');
      line.setAttribute('x1', p.vx * z); line.setAttribute('y1', y);
      line.setAttribute('x2', q.vx * z); line.setAttribute('y2', y);
      line.setAttribute('stroke', s.stroke); line.setAttribute('stroke-width', Math.max(1.5, s.width));
      g.appendChild(line);
    } else if (ann.type === 'text' || ann.type === 'callout') {
      drawText(g, ann, z);
    }

    // Selection handles + hit target (skip text-markup which are non-interactive geometry).
    if (!TEXT_MARKUP[ann.type]) addHandles(g, ann, z, selected);
  }

  function drawText(g, ann, z) {
    const s = ann.style;
    const pts = ann.pts;
    // For a callout, pts = [tip, boxCorner]; for text, pts = [boxCorner].
    let box, tip = null;
    if (ann.type === 'callout') { tip = pts[0]; box = pts[1]; }
    else box = pts[0];

    const fs = s.fontSize * z;
    const padX = 4 * z, padY = 3 * z;
    const lines = String(ann.text || '').split('\n');
    const textW = Math.max(40, maxLineW(lines, s.fontSize) * z + padX * 2);
    const boxH = lines.length * fs * 1.25 + padY * 2;
    const bx = box.vx * z, by = box.vy * z;

    if (tip) {
      const leader = ns('line');
      leader.setAttribute('x1', tip.vx * z); leader.setAttribute('y1', tip.vy * z);
      leader.setAttribute('x2', bx); leader.setAttribute('y2', by);
      leader.setAttribute('stroke', s.stroke); leader.setAttribute('stroke-width', s.width);
      g.appendChild(leader);
    }
    const rect = ns('rect');
    rect.setAttribute('x', bx); rect.setAttribute('y', by);
    rect.setAttribute('width', textW); rect.setAttribute('height', boxH);
    rect.setAttribute('fill', '#ffffff'); rect.setAttribute('fill-opacity', '0.9');
    rect.setAttribute('stroke', s.stroke); rect.setAttribute('stroke-width', s.width);
    rect.setAttribute('rx', 3);
    g.appendChild(rect);
    lines.forEach((ln, i) => {
      const t = ns('text');
      t.setAttribute('x', bx + padX);
      t.setAttribute('y', by + padY + fs * (i + 0.9));
      t.setAttribute('font-size', fs);
      t.setAttribute('font-family', s.font + ', sans-serif');
      t.setAttribute('fill', s.stroke);
      t.textContent = ln;
      g.appendChild(t);
    });
    // cache computed box size for hit-testing/resize
    ann._boxW = textW / z; ann._boxH = boxH / z;
  }
  let mctx = null;
  function maxLineW(lines, fontSize) {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = `${fontSize}px Helvetica, sans-serif`;
    return lines.reduce((m, l) => Math.max(m, mctx.measureText(l || ' ').width), 0);
  }

  // Interactive handles: a hit rect for selection, corner handle for resize,
  // vertex dots for polylines. Clicking selects; dragging moves.
  function addHandles(g, ann, z, selected) {
    const b = annBBox(ann);
    // invisible hit target
    const hit = ns('rect');
    hit.setAttribute('class', 'mk-hit');
    hit.setAttribute('x', b.minx * z - 4); hit.setAttribute('y', b.miny * z - 4);
    hit.setAttribute('width', b.w * z + 8); hit.setAttribute('height', b.h * z + 8);
    hit.setAttribute('fill', 'transparent');
    hit.style.pointerEvents = 'all';
    hit.style.cursor = 'move';
    g.appendChild(hit);
    hit.addEventListener('pointerdown', (e) => startMove(e, ann));

    if (!selected) return;
    // bounding outline
    const out = ns('rect');
    out.setAttribute('class', 'mk-selbox');
    out.setAttribute('x', b.minx * z); out.setAttribute('y', b.miny * z);
    out.setAttribute('width', b.w * z); out.setAttribute('height', b.h * z);
    g.appendChild(out);
    // resize handle bottom-right (scales the whole annotation)
    const h = ns('rect');
    h.setAttribute('class', 'mk-handle');
    h.setAttribute('x', b.maxx * z - 5); h.setAttribute('y', b.maxy * z - 5);
    h.setAttribute('width', 10); h.setAttribute('height', 10);
    h.style.pointerEvents = 'all';
    h.style.cursor = 'nwse-resize';
    g.appendChild(h);
    h.addEventListener('pointerdown', (e) => startResize(e, ann));
  }

  function annBBox(ann) {
    if (TEXTUAL[ann.type]) {
      const box = ann.type === 'callout' ? ann.pts[1] : ann.pts[0];
      const w = ann._boxW || 80, hgt = ann._boxH || 24;
      const pts = [{ vx: box.vx, vy: box.vy }, { vx: box.vx + w, vy: box.vy + hgt }];
      if (ann.type === 'callout') pts.push(ann.pts[0]);
      return bbox(pts);
    }
    return bbox(ann.pts);
  }

  /* ---------------- preview while drawing ---------------- */
  function drawPreview(layer, a, z) {
    const s = App.state.markupStyle;
    const pts = a.pts.slice();
    const live = pts.concat(a.hover ? [a.hover] : []);
    const g = ns('g'); g.setAttribute('class', 'mk-preview'); layer.appendChild(g);

    if (a.tool === 'rect' && live.length >= 2) {
      const [p, q] = rectPts(live[0], live[1]);
      const r = ns('rect');
      r.setAttribute('x', p.vx * z); r.setAttribute('y', p.vy * z);
      r.setAttribute('width', (q.vx - p.vx) * z); r.setAttribute('height', (q.vy - p.vy) * z);
      styleAttrs(r, s, true); r.setAttribute('stroke-dasharray', '5 4'); g.appendChild(r);
    } else if (a.tool === 'ellipse' && live.length >= 2) {
      const [p, q] = rectPts(live[0], live[1]);
      const el = ns('ellipse');
      el.setAttribute('cx', (p.vx + q.vx) / 2 * z); el.setAttribute('cy', (p.vy + q.vy) / 2 * z);
      el.setAttribute('rx', Math.abs(q.vx - p.vx) / 2 * z); el.setAttribute('ry', Math.abs(q.vy - p.vy) / 2 * z);
      styleAttrs(el, s, true); el.setAttribute('stroke-dasharray', '5 4'); g.appendChild(el);
    } else if ((a.tool === 'line' || a.tool === 'arrow' || a.tool === 'callout') && live.length >= 2) {
      const ln = ns('line');
      ln.setAttribute('x1', live[0].vx * z); ln.setAttribute('y1', live[0].vy * z);
      ln.setAttribute('x2', live[1].vx * z); ln.setAttribute('y2', live[1].vy * z);
      styleAttrs(ln, s, false); ln.setAttribute('stroke-dasharray', '5 4'); g.appendChild(ln);
      if (a.tool === 'arrow') arrowHead(g, live[0], live[1], z, s.stroke, s.width);
    } else if (a.tool === 'cloud' && live.length >= 2) {
      const path = ns('path');
      path.setAttribute('d', cloudPath(live, z, false));
      styleAttrs(path, s, false); g.appendChild(path);
    } else if (live.length >= 2) {
      const path = ns('path');
      path.setAttribute('d', pathFrom(live, z, false));
      styleAttrs(path, s, false); path.setAttribute('stroke-dasharray', '5 4'); g.appendChild(path);
    }
    live.forEach((pt) => {
      const c = ns('circle');
      c.setAttribute('cx', pt.vx * z); c.setAttribute('cy', pt.vy * z); c.setAttribute('r', 3);
      c.setAttribute('fill', s.stroke); g.appendChild(c);
    });
  }

  /* ---------------- move / resize gestures ---------------- */
  function startMove(e, ann) {
    e.preventDefault(); e.stopPropagation();
    K.select(ann.id);
    pushUndo();
    const z = App.state.zoom;
    const sx = e.clientX, sy = e.clientY;
    const orig = ann.pts.map((p) => ({ vx: p.vx, vy: p.vy }));
    function mv(ev) {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      ann.pts = orig.map((p) => ({ vx: p.vx + dx, vy: p.vy + dy }));
      K.repositionAll();
    }
    function up() {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      K.renderPanel && K.renderPanel();
    }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  function startResize(e, ann) {
    e.preventDefault(); e.stopPropagation();
    K.select(ann.id);
    pushUndo();
    const z = App.state.zoom;
    const b = annBBox(ann);
    const anchor = { vx: b.minx, vy: b.miny };
    const sx = e.clientX, sy = e.clientY;
    const orig = ann.pts.map((p) => ({ vx: p.vx, vy: p.vy }));
    const startW = Math.max(1, b.w), startH = Math.max(1, b.h);
    function mv(ev) {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      const sxr = Math.max(0.05, (startW + dx) / startW);
      const syr = Math.max(0.05, (startH + dy) / startH);
      const r = TEXTUAL[ann.type] ? Math.max(sxr, syr) : null; // text scales font uniformly
      if (TEXTUAL[ann.type]) {
        ann.style.fontSize = Math.max(6, Math.min(96, ann.style.fontSize * ((startW + dx) / startW)));
      } else {
        ann.pts = orig.map((p) => ({
          vx: anchor.vx + (p.vx - anchor.vx) * sxr,
          vy: anchor.vy + (p.vy - anchor.vy) * syr
        }));
      }
      K.repositionAll();
    }
    function up() {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      K.renderPanel && K.renderPanel();
    }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  /* ---------------- selection / removal ---------------- */
  K.select = function (id) {
    App.state.annotSelectedId = id;
    // reflect the selected item's style in the props bar
    const ann = App.state.annotations.find((a) => a.id === id);
    if (ann && ann.style) { Object.assign(App.state.markupStyle, ann.style); syncPropsBar(); }
    K.repositionAll();
    K.renderPanel && K.renderPanel();
  };
  K.deselect = function () {
    App.state.annotSelectedId = null;
    K.repositionAll();
  };
  K.remove = function (id) {
    pushUndo();
    App.state.annotations = App.state.annotations.filter((a) => a.id !== id);
    if (App.state.annotSelectedId === id) App.state.annotSelectedId = null;
    K.repositionAll();
    K.renderPanel && K.renderPanel();
  };
  K.removeSelected = function () {
    if (App.state.annotSelectedId != null) K.remove(App.state.annotSelectedId);
  };

  /* ---------------- text editing (HTML textarea overlay) ---------------- */
  function startTextEdit(ann) {
    const pe = App.state.pageEls[ann.page - 1];
    if (!pe) return;
    const z = App.state.zoom;
    const box = ann.type === 'callout' ? ann.pts[1] : ann.pts[0];
    const ta = document.createElement('textarea');
    ta.className = 'mk-text-edit';
    ta.value = ann.text || '';
    ta.style.left = (box.vx * z) + 'px';
    ta.style.top = (box.vy * z) + 'px';
    ta.style.fontSize = (ann.style.fontSize * z) + 'px';
    ta.style.color = ann.style.stroke;
    pe.holder.appendChild(ta);
    ta.focus(); ta.select();
    function commit() {
      ann.text = ta.value.trim() || 'Text';
      ta.remove();
      K.repositionAll();
      K.renderPanel && K.renderPanel();
    }
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ta.blur(); }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ta.blur(); }
    });
  }
  K.editSelectedText = function () {
    const ann = App.state.annotations.find((a) => a.id === App.state.annotSelectedId);
    if (ann && TEXTUAL[ann.type]) startTextEdit(ann);
  };

  /* ---------------- properties bar ---------------- */
  function showPropsBar(show) {
    const bar = App.$('#markup-props');
    if (!bar) return;
    bar.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-props', !!show);
    if (show) syncPropsBar();
  }
  function syncPropsBar() {
    const s = App.state.markupStyle;
    const set = (id, v) => { const el = App.$(id); if (el) el.value = v; };
    set('#mk-stroke', s.stroke);
    set('#mk-fill', s.fill);
    set('#mk-width', s.width);
    set('#mk-opacity', Math.round(s.opacity * 100));
    set('#mk-arrow', s.arrow);
    set('#mk-font', s.font);
    set('#mk-fontsize', s.fontSize);
  }
  // Live style edit: update markupStyle and, if an annotation is selected, it too.
  function applyStyleChange(patch) {
    Object.assign(App.state.markupStyle, patch);
    const ann = App.state.annotations.find((a) => a.id === App.state.annotSelectedId);
    if (ann) {
      pushUndo();
      Object.assign(ann.style, patch);
      K.repositionAll();
      K.renderPanel && K.renderPanel();
    }
  }
  K.showProps = () => showPropsBar(true);

  /* ---------------- markups list panel (Phase 3 wires columns) ---------- */
  K.togglePanel = function () {
    const panel = App.$('#markup-panel');
    if (!panel) return;
    const hidden = panel.classList.toggle('hidden');
    document.body.classList.toggle('has-kpanel', !hidden);
    if (!hidden) K.renderPanel();
  };

  K.renderPanel = function () {
    const list = App.$('#kp-list');
    if (!list) return;
    const anns = App.state.annotations;
    list.innerHTML = '';
    if (!anns.length) {
      list.innerHTML = '<div class="mp-empty">No markups yet.<br>Use the Markup menu to add some.</div>';
      return;
    }
    anns.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'mp-row' + (a.id === App.state.annotSelectedId ? ' selected' : '');
      const swatchColor = TEXT_MARKUP[a.type] && a.type === 'highlight' ? a.style.fill : a.style.stroke;
      row.innerHTML =
        `<span class="mp-swatch" style="background:${swatchColor}"></span>` +
        `<span class="mp-type">${a.type}</span>` +
        `<span class="mp-val" title="${(a.comment || a.text || '').replace(/"/g, '')}">${(a.comment || a.text || '').slice(0, 24) || '—'}</span>` +
        `<span class="mp-pg">p${a.page}</span>` +
        `<button class="mp-del" title="Delete">✕</button>`;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('mp-del')) { K.remove(a.id); return; }
        K.select(a.id);
        const pe = App.state.pageEls[a.page - 1];
        if (pe && pe.pageDiv) pe.pageDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      list.appendChild(row);
    });
  };

  K.exportCsv = async function () {
    const anns = App.state.annotations;
    if (!anns.length) { App.toast('No markups to export.', 'error'); return; }
    const rows = [['#', 'Type', 'Page', 'Author', 'Color', 'Comment', 'Status']];
    anns.forEach((a, i) => {
      rows.push([i + 1, a.type, a.page, a.author || '', a.style.stroke, a.comment || a.text || '', a.status || '']);
    });
    const csv = rows.map((r) => r.map((c) => {
      const s = String(c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    const res = await window.api.saveTextDialog(`${base}-markups.csv`, csv);
    if (res && res.ok) App.toast(`Saved: ${res.path}`, 'success', 5000);
    else if (res && res.error) App.toast('Could not save CSV: ' + res.error, 'error');
  };

  K.clearAll = function () {
    if (!App.state.annotations.length) return;
    pushUndo();
    App.state.annotations = [];
    App.state.annotSelectedId = null;
    K.repositionAll();
    K.renderPanel();
  };

  /* ---------------- init ---------------- */
  K.init = function () {
    const bind = (id, ev, fn) => { const el = App.$(id); if (el) el.addEventListener(ev, fn); };
    bind('#mk-stroke', 'input', (e) => applyStyleChange({ stroke: e.target.value }));
    bind('#mk-fill', 'input', (e) => applyStyleChange({ fill: e.target.value }));
    bind('#mk-width', 'input', (e) => applyStyleChange({ width: parseFloat(e.target.value) || 1 }));
    bind('#mk-opacity', 'input', (e) => applyStyleChange({ opacity: (parseFloat(e.target.value) || 100) / 100 }));
    bind('#mk-arrow', 'change', (e) => applyStyleChange({ arrow: e.target.value }));
    bind('#mk-font', 'change', (e) => applyStyleChange({ font: e.target.value }));
    bind('#mk-fontsize', 'input', (e) => applyStyleChange({ fontSize: parseFloat(e.target.value) || 14 }));
    bind('#mk-undo', 'click', K.undo);
    bind('#mk-redo', 'click', K.redo);
    bind('#mk-props-close', 'click', () => showPropsBar(false));
    bind('#kp-close', 'click', K.togglePanel);
    bind('#kp-export', 'click', K.exportCsv);
    bind('#kp-clear', 'click', K.clearAll);
    updateUndoButtons();
    syncPropsBar();
  };

  App.Markup = K;
})();
