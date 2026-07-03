'use strict';

/*
 * Markup / annotation engine (Bluebeam-style tools).
 *
 * Model (App.state.annotations) — geometry in scale-1 viewport points, so it
 * renders at `pt * zoom` and exports via viewport.convertToPdfPoint, exactly
 * like placements/measurements:
 *   { id, page, type, pts:[{vx,vy}], style:{stroke,fill,width,opacity,arrow,fontSize}, text }
 * types: line arrow rect ellipse polyline polygon cloud ink text callout highlight
 *
 * Interaction:
 *   - A drawing tool active (App.state.mode==='markup')  -> clicks/drag create.
 *   - No tool active (mode null)                         -> click a shape to
 *     select; drag to move; corner handle to resize; Delete to remove.
 * Undo/redo via whole-array snapshots (annotations are small JSON).
 */
(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const TWO_POINT = { line: 1, arrow: 1, rect: 1, ellipse: 1, highlight: 1 };
  const N_POINT = { polyline: 1, polygon: 1, cloud: 1 };
  const DEF_TEXT_W = 150, DEF_TEXT_H = 44;

  const K = {
    tool: null,          // current drawing tool or null
    active: null,        // { type, page, pts:[], hover }
    inkDrawing: false
  };

  function ns(t) { return document.createElementNS(SVGNS, t); }
  // Geometry is shared + unit-tested (src/shared/geometry.js).
  const { dist, bbox } = App.Geom;

  /* ---------------- model + undo/redo ---------------- */
  function defaults() {
    if (App.state.annoStyle) return App.state.annoStyle;
    const saved = App.Prefs ? App.Prefs.get('annoStyle', null) : null;
    return (App.state.annoStyle = saved ||
      { stroke: '#e5484d', fill: 'none', width: 2, opacity: 1, fontSize: 14 });
  }
  // Undo/redo is now unified across all layers (see js/history.js). markup
  // keeps calling snapshot() before each mutation; the stack is shared.
  function snapshot() { App.History.snapshot(); }
  K.undo = function () { App.History.undo(); };
  K.redo = function () { App.History.redo(); };

  /* ---------------- tool lifecycle ---------------- */
  K.startTool = function (type) {
    K.commitActive();
    K.tool = type;
    K.active = null;
    App.setMode('markup');
    App.toast(`Markup: ${type}. ` + (N_POINT[type] ? 'Click points, Enter/double-click to finish.' :
      type === 'ink' ? 'Press and drag to draw.' : 'Click start then end.'), 'info', 3500);
  };
  K.stop = function () {
    K.commitActive();
    K.tool = null; K.active = null;
    K.repositionAll();
  };
  K.cancelActive = function () { K.active = null; K.repositionAll(); };

  K.commitActive = function () {
    const a = K.active; K.active = null;
    if (!a) return;
    const need = a.type === 'polygon' || a.type === 'cloud' ? 3 : a.type === 'polyline' ? 2 : 2;
    if (a.pts.length < need) return;
    finalize(a);
  };

  function finalize(a) {
    snapshot();
    App.state.annoSeq = (App.state.annoSeq || 0) + 1;
    const an = {
      id: App.state.annoSeq,
      page: a.page,
      type: a.type,
      pts: a.pts.map((p) => ({ vx: p.vx, vy: p.vy })),
      style: Object.assign({}, defaults()),
      text: a.type === 'text' || a.type === 'callout' ? (a.text || 'Text') : undefined
    };
    App.state.annotations.push(an);
    App.state.annoSelectedId = an.id;
    App.$('#btn-save').disabled = false;
    K.repositionAll();
    if (an.type === 'text' || an.type === 'callout') startTextEdit(an);
  }

  /* ---------------- interaction (from app.js delegation) ---------------- */
  function ptFromEvent(layer, e) {
    const rect = layer.getBoundingClientRect();
    const z = App.state.zoom;
    let p = { vx: (e.clientX - rect.left) / z, vy: (e.clientY - rect.top) / z };
    // ortho on Shift, relative to the last placed point
    if (K.active && K.active.pts.length && e.shiftKey) {
      p = App.Geom.ortho(K.active.pts[K.active.pts.length - 1], p);
    }
    return p;
  }

  K.handleClick = function (page, layer, e) {
    if (!K.tool || K.tool === 'ink') return;
    const p = ptFromEvent(layer, e);

    // Text: one click drops a default-size editable box.
    if (K.tool === 'text') {
      finalize({ type: 'text', page, text: 'Text',
        pts: [{ vx: p.vx, vy: p.vy }, { vx: p.vx + DEF_TEXT_W, vy: p.vy + DEF_TEXT_H }] });
      return;
    }
    // Callout: click 1 = arrow tip, click 2 = text-box location.
    if (K.tool === 'callout') {
      if (!K.active) K.active = { type: 'callout', page, pts: [] };
      if (K.active.page !== page) return;
      K.active.pts.push(p);
      if (K.active.pts.length === 2) {
        const tip = K.active.pts[0], box = K.active.pts[1];
        K.active = null;
        finalize({ type: 'callout', page, text: 'Text',
          pts: [{ vx: box.vx, vy: box.vy }, { vx: box.vx + DEF_TEXT_W, vy: box.vy + DEF_TEXT_H }, { vx: tip.vx, vy: tip.vy }] });
      } else { K.repositionAll(); }
      return;
    }

    if (!K.active) K.active = { type: K.tool, page, pts: [] };
    if (K.active.page !== page) return;

    if (TWO_POINT[K.tool]) {
      K.active.pts.push(p);
      if (K.active.pts.length === 2) { const a = K.active; K.active = null; finalize(a); }
    } else { // N-point
      const last = K.active.pts[K.active.pts.length - 1];
      if (last && dist(last, p) < 1.5) { K.repositionAll(); return; } // dedupe dblclick
      K.active.pts.push(p);
    }
    K.repositionAll();
  };

  K.handleMove = function (page, layer, e) {
    if (K.inkDrawing) { inkMove(page, layer, e); return; }
    if (!K.active || K.active.page !== page || !K.active.pts.length) return;
    K.active.hover = ptFromEvent(layer, e);
    K.repositionAll();
  };

  K.finishDrawing = function () { K.commitActive(); K.repositionAll(); };

  // Ink uses press-drag-release.
  K.inkStart = function (page, layer, e) {
    if (K.tool !== 'ink') return;
    K.inkDrawing = true;
    K.active = { type: 'ink', page, pts: [ptFromEvent(layer, e)] };
  };
  function inkMove(page, layer, e) {
    if (!K.active || K.active.page !== page) return;
    const p = ptFromEvent(layer, e);
    const last = K.active.pts[K.active.pts.length - 1];
    if (!last || Math.hypot(p.vx - last.vx, p.vy - last.vy) > 1.2) K.active.pts.push(p);
    K.repositionAll();
  }
  K.inkEnd = function () {
    if (!K.inkDrawing) return;
    K.inkDrawing = false;
    const a = K.active; K.active = null;
    if (a && a.pts.length >= 2) finalize(a);
    else K.repositionAll();
  };

  /* ---------------- selection / move / resize ---------------- */
  function annoById(id) { return App.state.annotations.find((a) => a.id === id); }
  K.select = function (id) { App.state.annoSelectedId = id; K.repositionAll(); if (App.MarkupPanel) App.MarkupPanel.render(); syncPropBar(); App.refreshChrome && App.refreshChrome(); };
  K.deselect = function () { if (App.state.annoSelectedId != null) { App.state.annoSelectedId = null; K.repositionAll(); App.refreshChrome && App.refreshChrome(); } };
  // Keyboard nudge (arrow keys) for the selected annotation.
  K.nudge = function (dx, dy) {
    const an = annoById(App.state.annoSelectedId);
    if (!an) return;
    snapshot();
    an.pts = an.pts.map((pt) => ({ vx: pt.vx + dx, vy: pt.vy + dy }));
    K.repositionAll();
  };

  K.remove = function (id) {
    snapshot();
    App.state.annotations = App.state.annotations.filter((a) => a.id !== id);
    if (App.state.annoSelectedId === id) App.state.annoSelectedId = null;
    K.repositionAll();
  };

  function startDrag(an, e) {
    e.preventDefault(); e.stopPropagation();
    K.select(an.id);
    const z = App.state.zoom, sx = e.clientX, sy = e.clientY;
    const orig = an.pts.map((p) => ({ vx: p.vx, vy: p.vy }));
    snapshot();
    function move(ev) {
      let dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      // Shift → orthogonal (lock to the dominant axis).
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      // Snap the anchor point onto a nearby vertex of another shape.
      if (snapEnabled()) {
        const cand = [];
        App.state.annotations.forEach((o) => { if (o.id !== an.id && o.page === an.page) cand.push(...o.pts); });
        const moved0 = { vx: orig[0].vx + dx, vy: orig[0].vy + dy };
        const s = App.Geom.nearestVertex(cand, moved0, 8 / z);
        if (s) { dx += s.vx - moved0.vx; dy += s.vy - moved0.vy; }
      }
      an.pts = orig.map((p) => ({ vx: p.vx + dx, vy: p.vy + dy }));
      K.repositionAll();
    }
    function up() { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  function snapEnabled() { return App.Prefs ? App.Prefs.get('snap', true) : true; }

  function startResize(an, e) {
    e.preventDefault(); e.stopPropagation();
    K.select(an.id);
    const z = App.state.zoom, sx = e.clientX, sy = e.clientY;
    const b = bbox(an.pts);
    const orig = an.pts.map((p) => ({ vx: p.vx, vy: p.vy }));
    snapshot();
    function move(ev) {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      const sw = b.w ? (b.w + dx) / b.w : 1;
      const sh = b.h ? (b.h + dy) / b.h : 1;
      an.pts = orig.map((p) => ({ vx: b.x + (p.vx - b.x) * sw, vy: b.y + (p.vy - b.y) * sh }));
      K.repositionAll();
    }
    function up() { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  /* ---------------- rendering ---------------- */
  K.repositionAll = function () {
    const z = App.state.zoom;
    (App.state.pageEls || []).forEach((pe, i) => {
      if (!pe) return;
      const page = i + 1;
      let svg = pe.holder.querySelector('.markup-svg');
      if (svg) svg.remove();
      svg = ns('svg');
      svg.setAttribute('class', 'markup-svg');
      svg.setAttribute('width', pe.holder.style.width);
      svg.setAttribute('height', pe.holder.style.height);
      pe.holder.appendChild(svg);
      App.state.annotations.forEach((an) => { if (an.page === page) drawAnno(svg, an, z, an.id === App.state.annoSelectedId); });
      if (K.active && K.active.page === page) drawPreview(svg, K.active, z);
    });
  };

  function pts2str(pts, z) { return pts.map((p) => `${p.vx * z},${p.vy * z}`).join(' '); }

  function arrowHead(svg, from, to, z, color, width) {
    const [w1, w2] = App.Geom.arrowHeadPoints(from, to, width);
    const p = ns('polygon');
    p.setAttribute('points',
      `${to.vx * z},${to.vy * z} ${w1.vx * z},${w1.vy * z} ${w2.vx * z},${w2.vy * z}`);
    p.setAttribute('fill', color);
    svg.appendChild(p);
  }

  function cloudPath(pts, z, closed) {
    // scalloped path around the polygon perimeter
    const r = 8; // scallop radius (points)
    let d = '';
    const loop = closed ? pts.concat([pts[0]]) : pts;
    for (let i = 0; i < loop.length - 1; i++) {
      const a = loop[i], b = loop[i + 1];
      const segLen = Math.hypot(b.vx - a.vx, b.vy - a.vy);
      const n = Math.max(1, Math.round(segLen / (r * 2)));
      for (let j = 0; j < n; j++) {
        const t0 = j / n, t1 = (j + 1) / n;
        const x0 = a.vx + (b.vx - a.vx) * t0, y0 = a.vy + (b.vy - a.vy) * t0;
        const x1 = a.vx + (b.vx - a.vx) * t1, y1 = a.vy + (b.vy - a.vy) * t1;
        if (i === 0 && j === 0) d += `M ${x0 * z} ${y0 * z} `;
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        // bulge outward (perpendicular)
        const nx = -(y1 - y0), nyv = (x1 - x0);
        const nl = Math.hypot(nx, nyv) || 1;
        const bx = mx + (nx / nl) * r, by = my + (nyv / nl) * r;
        d += `Q ${bx * z} ${by * z} ${x1 * z} ${y1 * z} `;
      }
    }
    return d;
  }

  function drawAnno(svg, an, z, selected) {
    const s = an.style;
    const stroke = s.stroke, fill = s.fill && s.fill !== 'none' ? s.fill : 'none';
    const common = (el, hit) => {
      el.setAttribute('stroke', stroke);
      el.setAttribute('stroke-width', s.width);
      el.setAttribute('fill', fill);
      el.setAttribute('opacity', s.opacity);
      if (hit) { el.setAttribute('class', 'hit'); el.addEventListener('mousedown', (e) => startDrag(an, e)); }
      svg.appendChild(el);
    };

    if (an.type === 'line' || an.type === 'arrow') {
      const l = ns('line');
      l.setAttribute('x1', an.pts[0].vx * z); l.setAttribute('y1', an.pts[0].vy * z);
      l.setAttribute('x2', an.pts[1].vx * z); l.setAttribute('y2', an.pts[1].vy * z);
      l.setAttribute('fill', 'none'); common(l, true);
      if (an.type === 'arrow') arrowHead(svg, an.pts[0], an.pts[1], z, stroke, s.width);
    } else if (an.type === 'rect' || an.type === 'highlight') {
      const b = bbox(an.pts);
      const r = ns('rect');
      r.setAttribute('x', b.x * z); r.setAttribute('y', b.y * z);
      r.setAttribute('width', b.w * z); r.setAttribute('height', b.h * z);
      if (an.type === 'highlight') { r.setAttribute('fill', stroke); r.setAttribute('opacity', 0.35); r.setAttribute('stroke', 'none'); r.setAttribute('class', 'hit'); r.addEventListener('mousedown', (e) => startDrag(an, e)); svg.appendChild(r); }
      else common(r, true);
    } else if (an.type === 'ellipse') {
      const b = bbox(an.pts);
      const el = ns('ellipse');
      el.setAttribute('cx', (b.x + b.w / 2) * z); el.setAttribute('cy', (b.y + b.h / 2) * z);
      el.setAttribute('rx', (b.w / 2) * z); el.setAttribute('ry', (b.h / 2) * z);
      common(el, true);
    } else if (an.type === 'polyline' || an.type === 'ink') {
      const pl = ns('polyline');
      pl.setAttribute('points', pts2str(an.pts, z));
      pl.setAttribute('fill', 'none'); common(pl, true);
      if (an.type === 'ink') pl.setAttribute('stroke-linejoin', 'round'), pl.setAttribute('stroke-linecap', 'round');
    } else if (an.type === 'polygon') {
      const pg = ns('polygon');
      pg.setAttribute('points', pts2str(an.pts, z)); common(pg, true);
    } else if (an.type === 'cloud') {
      const path = ns('path');
      path.setAttribute('d', cloudPath(an.pts, z, true));
      path.setAttribute('fill', fill); common(path, true);
    } else if (an.type === 'text' || an.type === 'callout') {
      drawText(svg, an, z);
    }

    if (selected) drawSelection(svg, an, z);
  }

  function drawText(svg, an, z) {
    const s = an.style;
    const b = bbox(an.type === 'callout' ? an.pts.slice(0, 2) : an.pts);
    if (an.type === 'callout' && an.pts[2]) {
      // leader line from box edge to tip
      const tip = an.pts[2];
      const l = ns('line');
      l.setAttribute('x1', (b.x) * z); l.setAttribute('y1', (b.y + b.h) * z);
      l.setAttribute('x2', tip.vx * z); l.setAttribute('y2', tip.vy * z);
      l.setAttribute('stroke', s.stroke); l.setAttribute('stroke-width', s.width);
      svg.appendChild(l);
      arrowHead(svg, { vx: b.x, vy: b.y + b.h }, tip, z, s.stroke, s.width);
    }
    const fo = ns('foreignObject');
    fo.setAttribute('x', b.x * z); fo.setAttribute('y', b.y * z);
    fo.setAttribute('width', Math.max(40, b.w * z)); fo.setAttribute('height', Math.max(20, b.h * z));
    fo.setAttribute('class', 'hit');
    const div = document.createElement('div');
    div.className = 'anno-text';
    div.style.color = s.stroke;
    div.style.fontSize = (s.fontSize * z) + 'px';
    div.style.border = `1px solid ${s.stroke}`;
    div.textContent = an.text || '';
    fo.appendChild(div);
    fo.addEventListener('mousedown', (e) => startDrag(an, e));
    fo.addEventListener('dblclick', (e) => { e.stopPropagation(); startTextEdit(an); });
    svg.appendChild(fo);
  }

  function startTextEdit(an) {
    K.repositionAll();
    const svg = findSvgForPage(an.page); if (!svg) return;
    const div = svg.querySelector('foreignObject .anno-text');
    if (!div) return;
    div.setAttribute('contenteditable', 'true');
    div.focus();
    const range = document.createRange(); range.selectNodeContents(div);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    function commit() {
      snapshot();
      an.text = div.textContent.trim() || 'Text';
      div.removeAttribute('contenteditable');
      div.removeEventListener('blur', commit); div.removeEventListener('keydown', key);
      K.repositionAll();
    }
    function key(ev) { if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey)) { ev.preventDefault(); div.blur(); } }
    div.addEventListener('blur', commit); div.addEventListener('keydown', key);
  }
  function findSvgForPage(page) {
    const pe = App.state.pageEls[page - 1];
    return pe ? pe.holder.querySelector('.markup-svg') : null;
  }

  function drawSelection(svg, an, z) {
    const b = bbox(an.type === 'callout' ? an.pts.slice(0, 2) : an.pts);
    const box = ns('rect');
    box.setAttribute('x', b.x * z - 3); box.setAttribute('y', b.y * z - 3);
    box.setAttribute('width', b.w * z + 6); box.setAttribute('height', b.h * z + 6);
    box.setAttribute('class', 'sel-box'); box.setAttribute('fill', 'none');
    svg.appendChild(box);
    const h = ns('rect');
    h.setAttribute('x', (b.x + b.w) * z - 4); h.setAttribute('y', (b.y + b.h) * z - 4);
    h.setAttribute('width', 8); h.setAttribute('height', 8);
    h.setAttribute('class', 'handle');
    h.addEventListener('mousedown', (e) => startResize(an, e));
    svg.appendChild(h);
  }

  function drawPreview(svg, a, z) {
    const s = defaults();
    const live = a.pts.concat(a.hover && TWO_POINT[a.type] && a.pts.length < 2 ? [a.hover] :
      a.hover && N_POINT[a.type] ? [a.hover] : []);
    const tmp = { type: a.type, pts: live.length >= 2 ? live : a.pts, style: Object.assign({}, s), text: 'Text' };
    if (tmp.pts.length >= (TWO_POINT[a.type] ? 2 : 2)) {
      const g = ns('g'); g.setAttribute('opacity', '0.7'); svg.appendChild(g);
      // reuse drawAnno by temporarily rendering into a sub-group
      const prevSel = App.state.annoSelectedId; App.state.annoSelectedId = null;
      drawAnnoInto(g, tmp, z);
      App.state.annoSelectedId = prevSel;
    }
    a.pts.forEach((p) => {
      const c = ns('circle'); c.setAttribute('cx', p.vx * z); c.setAttribute('cy', p.vy * z);
      c.setAttribute('r', 3); c.setAttribute('fill', s.stroke); svg.appendChild(c);
    });
  }
  // draw an annotation into an arbitrary parent (for preview) without hit handlers
  function drawAnnoInto(parent, an, z) {
    const fake = { appendChild: (el) => parent.appendChild(el), querySelector: () => null };
    drawAnno(fake, an, z, false);
  }

  /* ---------------- properties bar ---------------- */
  function syncPropBar() {
    const an = annoById(App.state.annoSelectedId);
    const s = an ? an.style : defaults();
    const set = (id, v) => { const el = App.$(id); if (el) el.value = v; };
    set('#mk-stroke', s.stroke);
    set('#mk-fill', s.fill && s.fill !== 'none' ? s.fill : '#ffffff');
    App.$('#mk-fill-on') && (App.$('#mk-fill-on').checked = !!(s.fill && s.fill !== 'none'));
    set('#mk-width', s.width);
    set('#mk-opacity', Math.round(s.opacity * 100));
  }
  function applyStyle(patch) {
    const an = annoById(App.state.annoSelectedId);
    if (an) { snapshot(); Object.assign(an.style, patch); K.repositionAll(); }
    Object.assign(defaults(), patch); // also update defaults for new items
    if (App.Prefs) App.Prefs.set('annoStyle', App.state.annoStyle); // persist across restarts
  }

  K.init = function () {
    App.state.annotations = App.state.annotations || [];
    defaults();
    const wire = (id, ev, fn) => { const el = App.$(id); if (el) el.addEventListener(ev, fn); };
    wire('#mk-stroke', 'input', (e) => applyStyle({ stroke: e.target.value }));
    wire('#mk-fill', 'input', (e) => { if (App.$('#mk-fill-on').checked) applyStyle({ fill: e.target.value }); });
    wire('#mk-fill-on', 'change', (e) => applyStyle({ fill: e.target.checked ? App.$('#mk-fill').value : 'none' }));
    wire('#mk-width', 'input', (e) => applyStyle({ width: parseFloat(e.target.value) }));
    wire('#mk-opacity', 'input', (e) => applyStyle({ opacity: App.clamp(parseInt(e.target.value, 10) / 100, 0.1, 1) }));
    // Snap toggle — persisted; drives snapEnabled().
    const snap = App.$('#mk-snap');
    if (snap) {
      snap.checked = App.Prefs ? App.Prefs.get('snap', true) : true;
      snap.addEventListener('change', (e) => { if (App.Prefs) App.Prefs.set('snap', e.target.checked); });
    }
    syncPropBar();
  };

  /* ---------------- Markups List panel ---------------- */
  const Panel = {};
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  Panel.toggle = function () {
    const p = App.$('#markup-panel');
    const open = p.classList.toggle('hidden');
    document.body.classList.toggle('has-mkpanel', !open);
    if (!p.classList.contains('hidden')) Panel.render();
  };
  Panel.render = function () {
    const list = App.$('#mkp-list'); if (!list) return;
    const all = App.state.annotations;
    const q = ((App.$('#mkp-filter') && App.$('#mkp-filter').value) || '').trim().toLowerCase();
    const arr = q
      ? all.filter((an) => an.type.includes(q) || (an.text || '').toLowerCase().includes(q) || ('p' + an.page).includes(q))
      : all;
    list.innerHTML = '';
    if (!all.length) { list.innerHTML = '<div class="mp-empty"><div class="mp-empty-ico">✏️</div>No markups yet.<br>Use the Markup menu to add some.</div>'; return; }
    if (!arr.length) { list.innerHTML = '<div class="mp-empty">No markups match “' + esc(q) + '”.</div>'; return; }
    arr.forEach((an) => {
      const row = document.createElement('div');
      row.className = 'mp-row' + (an.id === App.state.annoSelectedId ? ' selected' : '');
      row.innerHTML =
        `<span class="mp-swatch" style="background:${an.style.stroke}"></span>` +
        `<span class="mp-type">${an.type}</span>` +
        `<span class="mp-val">${an.text ? esc(an.text) : ''}</span>` +
        `<span class="mp-pg">p${an.page}</span>` +
        `<button class="mp-del" title="Delete">✕</button>`;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('mp-del')) { K.remove(an.id); Panel.render(); return; }
        K.select(an.id);
        const pe = App.state.pageEls[an.page - 1];
        if (pe && pe.pageDiv) pe.pageDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      list.appendChild(row);
    });
  };
  Panel.clearAll = async function () {
    if (!App.state.annotations.length) return;
    const ok = await App.confirm(
      'Delete all markups? You can undo this with Ctrl+Z.',
      { title: 'Clear markups', okLabel: 'Clear all', danger: true });
    if (!ok) return;
    snapshot();
    App.state.annotations = []; App.state.annoSelectedId = null;
    K.repositionAll(); Panel.render();
  };
  Panel.exportCsv = async function () {
    const arr = App.state.annotations;
    if (!arr.length) { App.toast('No markups to export.', 'error'); return; }
    const rows = [['#', 'Type', 'Page', 'Color', 'Text']];
    arr.forEach((an, i) => rows.push([i + 1, an.type, an.page, an.style.stroke, an.text || '']));
    const csv = rows.map((r) => r.map((c) => { const s = String(c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    const res = await window.api.saveTextDialog(`${base}-markups.csv`, csv);
    if (res && res.ok) App.toast(`Saved: ${res.path}`, 'success', 5000);
    else if (res && res.error) App.toast('Could not save CSV: ' + res.error, 'error');
  };
  App.MarkupPanel = Panel;

  // wire panel buttons after DOM is ready (init is called at boot)
  const prevInit = K.init;
  K.init = function () {
    prevInit();
    const b = (id, fn) => { const el = App.$(id); if (el) el.addEventListener('click', fn); };
    b('#mkp-close', Panel.toggle);
    b('#mkp-export', Panel.exportCsv);
    b('#mkp-clear', Panel.clearAll);
    const filt = App.$('#mkp-filter');
    if (filt) filt.addEventListener('input', Panel.render);
    const chk = App.$('#mkp-annots');
    if (chk) {
      // Restore the persisted editable-vs-flatten choice.
      const saved = App.Prefs ? App.Prefs.get('saveAnnots', false) : false;
      App.state.saveAnnots = saved;
      chk.checked = saved;
      chk.addEventListener('change', (e) => {
        App.state.saveAnnots = e.target.checked;
        if (App.Prefs) App.Prefs.set('saveAnnots', e.target.checked);
      });
    }
  };

  App.Markup = K;
})();
