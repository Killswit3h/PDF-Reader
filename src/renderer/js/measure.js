'use strict';

/*
 * Measure-by-scale.
 *
 * Geometry is stored in scale-1 viewport points (top-left origin), the same
 * space as placements — so it renders at `pt * zoom` and exports via
 * viewport.convertToPdfPoint, reusing this app's existing coordinate model.
 *
 * A per-page (or per-viewport) "scale factor" = real-world units per point.
 *   length_real = pdfLength * factor
 *   area_real   = pdfArea   * factor^2   (unit^2)
 *   angle       = geometric, scale-independent
 */
(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const COLORS = {
    length: '#2f6fed', perimeter: '#7b61ff', area: '#21a366',
    angle: '#d1348c', count: '#e5a300'
  };
  const NEEDS_SCALE = { length: true, perimeter: true, area: true };
  const SNAP_PX = 10;

  const M = {
    _tool: null, // 'calibrate'|'length'|'perimeter'|'area'|'angle'|'count'|'viewport'
    _active: null, // { tool, page, pts:[{vx,vy}], hover:{vx,vy,snap} }
    _calib: null, // { page, pdfLen }  pending calibration line
    _scaleTarget: null, // { kind:'page', page } | { kind:'viewport', page, rect }
    _color: null, // custom color for NEW measurements; null = per-type default (COLORS)
    _fiOn: false, // display imperial lengths as feet-inches (24'-6") vs decimal
    _fiDenom: 16  // inch-fraction denominator for feet-inches display
  };

  // Effective draw color for a measurement: its own stored color, else the
  // per-type default. Older measurements (or loaded state) have no color field.
  function colorOf(m) { return m.color || COLORS[m.type] || '#2f6fed'; }

  // Active display options for value formatting (feet-inches vs decimal feet).
  function fmtOpts() { return { feetInches: M._fiOn, denom: M._fiDenom }; }
  // Format a computed value+unit with the active options, or the "set scale" cue.
  function fmtVal(type, value, unit) {
    return value == null ? '(set scale)' : App.fmtMeasure(type, value, unit, fmtOpts());
  }

  /* ---------------- geometry (shared, unit-tested: src/shared/geometry.js) --- */
  const { dist, angleAt, centroid } = App.Geom;

  /* ---------------- scale lookup ---------------- */
  // Effective scale for a point set on a page (viewport region wins over page).
  function scaleFor(page, pts) {
    const c = centroid(pts);
    const vps = App.state.viewports[page] || [];
    for (const v of vps) {
      if (c.vx >= v.vx && c.vx <= v.vx + v.vw && c.vy >= v.vy && c.vy <= v.vy + v.vh) return v;
    }
    return App.state.scales[page] || null;
  }

  // Resolve the page/region scale here (state-coupled), then hand off to the
  // pure App.computeValue (src/shared/measure-math.js) for the arithmetic.
  function computeValue(type, page, pts) {
    return App.computeValue(type, pts, scaleFor(page, pts));
  }

  // Recompute every measurement's cached value/label (after a scale change).
  M.recomputeAll = function () {
    App.state.measurements.forEach((m) => {
      const { value, unit } = computeValue(m.type, m.page, m.pts);
      m.value = value; m.unit = unit;
      m.label = fmtVal(m.type, value, unit);
    });
    M.repositionAll();
    M.renderPanel();
  };

  /* ---------------- display format ---------------- */
  // Toggle architectural feet-inches display (persisted). Recomputes every
  // measurement's cached label and refreshes the overlay + panel.
  M.setFeetInches = function (on) {
    M._fiOn = !!on;
    if (App.Prefs) { try { App.Prefs.set('measureFeetInches', M._fiOn); } catch (_) { /* quota */ } }
    const cb = App.$('#measure-ftin');
    if (cb) cb.checked = M._fiOn;
    M.recomputeAll();
  };

  /* ---------------- color ---------------- */
  // Set the color used for measurements drawn from now on. Pass null to go back
  // to the per-type defaults. Existing measurements keep their frozen color.
  M.setColor = function (hex) {
    M._color = hex || null;
    const sw = App.$('#measure-color-active');
    if (sw) sw.style.background = M._color || 'linear-gradient(135deg,#2f6fed,#21a366)';
    const reset = App.$('#measure-color-reset');
    if (reset) reset.classList.toggle('hidden', !M._color);
    // Recolor the in-progress preview immediately if one is being drawn.
    if (M._active) M.repositionAll(M._active.page);
  };

  /* ---------------- tool lifecycle ---------------- */
  M.startTool = function (tool) {
    M._commitActive();
    if (tool === 'calibrate') { M.openScaleModal({ kind: 'page', page: App.state.currentPage }); return; }
    M._tool = tool;
    M._active = null;
    App.setMode('measure');
    // Warm the content-snap index for the current page so the first click can
    // already snap to the drawing's geometry (harvest is async + cached).
    if (App.Snap) App.Snap.ensure(App.state.currentPage);
    App.$$('.page-holder').forEach((h) => h.classList.add('measuring'));
    const label = tool === 'viewport' ? 'a scale region (drag a box)' : tool;
    App.toast(`Measure: click to draw ${label}. Enter to finish, Esc to cancel.`, 'info', 4000);
  };

  M.stop = function () {
    M._commitActive();
    M._tool = null;
    M._active = null;
    App.$$('.page-holder').forEach((h) => h.classList.remove('measuring'));
    M.repositionAll();
  };

  M.cancelActive = function () {
    M._active = null;
    M.repositionAll();
  };

  // Commit whatever is being drawn if it has enough points; else discard.
  M._commitActive = function () {
    const a = M._active;
    M._active = null;
    if (!a || M._tool === 'calibrate' || M._tool === 'viewport') return;
    const need = a.tool === 'area' ? 3 : a.tool === 'angle' ? 3 : a.tool === 'count' ? 1 : 2;
    if (a.pts.length < need) return;
    finalize(a);
  };

  function finalize(a) {
    App.History.snapshot();
    const pts = a.pts.slice(0, a.tool === 'angle' ? 3 : undefined);
    const { value, unit } = computeValue(a.tool, a.page, pts);
    const m = {
      id: ++App.state.measureSeq,
      page: a.page,
      type: a.tool,
      pts,
      value, unit,
      color: M._color || COLORS[a.tool], // freeze the color at creation time
      label: fmtVal(a.tool, value, unit)
    };
    App.state.measurements.push(m);
    App.$('#btn-save').disabled = false;
    if (value == null && NEEDS_SCALE[a.tool]) {
      App.toast('Set a scale for this page to see the measurement value.', 'info', 4000);
    }
    M.renderPanel();
  }

  /* ---------------- interaction (from app.js delegation) ---------------- */
  M.handleClick = function (page, overlay, e) {
    const tool = M._tool;
    if (!tool) return;
    const p = pointFromEvent(page, overlay, e);

    if (tool === 'calibrate' || tool === 'viewport') {
      if (!M._active || M._active.page !== page) M._active = { tool, page, pts: [] };
      M._active.pts.push({ vx: p.vx, vy: p.vy });
      if (M._active.pts.length === 2) {
        const a = M._active; M._active = null;
        if (tool === 'calibrate') {
          M._calib = { page, pdfLen: dist(a.pts[0], a.pts[1]) };
          M.openScaleModal({ kind: 'page', page }, true);
        } else {
          const r = rectFrom(a.pts[0], a.pts[1]);
          M.openScaleModal({ kind: 'viewport', page, rect: r });
        }
        App.$$('.page-holder').forEach((h) => h.classList.remove('measuring'));
        M._tool = null;
      }
      M.repositionAll();
      return;
    }

    if (!M._active) M._active = { tool, page, pts: [] };
    if (M._active.page !== page) return; // lock to first page
    const last = M._active.pts[M._active.pts.length - 1];
    if (tool !== 'count' && last && dist(last, p) < 1.5) { M.repositionAll(); return; } // dedupe dbl-click
    M._active.pts.push({ vx: p.vx, vy: p.vy });

    if (tool === 'length' && M._active.pts.length === 2) { const a = M._active; M._active = null; finalize(a); }
    else if (tool === 'angle' && M._active.pts.length === 3) { const a = M._active; M._active = null; finalize(a); }
    M.repositionAll();
  };

  M.handleMove = function (page, overlay, e) {
    if (App.Snap) App.Snap.ensure(page); // harvest this page's geometry once, lazily
    if (!M._active || M._active.page !== page || !M._active.pts.length) return;
    const p = pointFromEvent(page, overlay, e);
    M._active.hover = p;
    M.scheduleReposition(page);
  };

  M.finishDrawing = function () { // Enter / double-click
    if (!M._active) return;
    M._commitActive();
    M.repositionAll();
  };

  /* ---------------- snapping ---------------- */
  function pointFromEvent(page, overlay, e) {
    const rect = overlay.getBoundingClientRect();
    const z = App.state.zoom;
    const raw = { vx: (e.clientX - rect.left) / z, vy: (e.clientY - rect.top) / z };
    const thr = SNAP_PX / z;

    // 1) snap to the nearest of: an existing measurement vertex, or the drawing's
    //    OWN geometry (line endpoints / corners, harvested by App.Snap). Whichever
    //    is closer wins, so a take-off traces the real linework, not an eyeballed
    //    point. `snapKind` lets the preview show a distinct cue per source.
    let best = null, kind = null, bd = thr;
    const v = snapVertex(page, raw, thr);
    if (v) { best = v; bd = App.Geom.dist(v, raw); kind = 'vertex'; }
    if (App.Snap && App.Snap.enabled) {
      const c = App.Snap.query(page, raw, thr);
      if (c) { const d = App.Geom.dist(c, raw); if (d < bd) { best = c; bd = d; kind = 'content'; } }
    }
    if (best) return { vx: best.vx, vy: best.vy, snap: true, snapKind: kind };

    // 2) ortho constraint on Shift, relative to last active point
    if (M._active && M._active.pts.length && e.shiftKey) {
      return App.Geom.ortho(M._active.pts[M._active.pts.length - 1], raw);
    }
    return raw;
  }
  function snapVertex(page, raw, thr) {
    const candidates = [];
    App.state.measurements.forEach((m) => { if (m.page === page) candidates.push(...m.pts); });
    if (M._active && M._active.page === page) candidates.push(...M._active.pts);
    return App.Geom.nearestVertex(candidates, raw, thr);
  }

  /* ---------------- rendering (SVG per page) ---------------- */
  function ns(tag) { return document.createElementNS(SVGNS, tag); }

  // Coalesce the high-frequency draw/drag rebuilds to one per animation frame,
  // and let a single-page gesture rebuild only its own page (see markup.js for
  // the rationale). `repositionAll()` with no arg still rebuilds every page.
  let _repoRAF = 0, _repoPage;
  M.scheduleReposition = function (onlyPage) {
    if (_repoRAF) return;
    _repoPage = onlyPage;
    _repoRAF = requestAnimationFrame(() => { const p = _repoPage; _repoRAF = 0; _repoPage = undefined; doReposition(p); });
  };
  M.repositionAll = function (onlyPage) {
    if (_repoRAF) { cancelAnimationFrame(_repoRAF); _repoRAF = 0; _repoPage = undefined; }
    doReposition(onlyPage);
  };
  function doReposition(onlyPage) {
    const z = App.state.zoom;
    App.state.pageEls.forEach((pe, i) => {
      if (!pe) return;
      const page = i + 1;
      if (onlyPage != null && page !== onlyPage) return;
      let layer = pe.holder.querySelector('.measure-layer');
      if (layer) layer.remove();
      layer = ns('svg');
      layer.setAttribute('class', 'measure-layer');
      layer.setAttribute('width', pe.holder.style.width);
      layer.setAttribute('height', pe.holder.style.height);
      pe.holder.appendChild(layer);

      // viewports
      (App.state.viewports[page] || []).forEach((v) => drawViewport(layer, v, z));
      // committed measurements
      App.state.measurements.forEach((m) => { if (m.page === page) drawMeasurement(layer, m, z, m.id === App.state.measureSelectedId); });
      // in-progress preview
      if (M._active && M._active.page === page) drawPreview(layer, M._active, z);
    });
  };

  function P(pt, z) { return `${pt.vx * z},${pt.vy * z}`; }

  function label(layer, x, y, text, color) {
    const t = ns('text');
    t.setAttribute('class', 'm-label');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('fill', color);
    t.textContent = text;
    layer.appendChild(t);
  }
  function vdot(layer, pt, z, color) {
    const c = ns('circle');
    c.setAttribute('class', 'm-vertex');
    c.setAttribute('cx', pt.vx * z); c.setAttribute('cy', pt.vy * z);
    c.setAttribute('r', 3); c.setAttribute('fill', color);
    layer.appendChild(c);
  }

  function drawMeasurement(layer, m, z, selected) {
    const color = colorOf(m);
    if (m.type === 'count') {
      m.pts.forEach((pt, idx) => {
        const c = ns('circle');
        c.setAttribute('cx', pt.vx * z); c.setAttribute('cy', pt.vy * z);
        c.setAttribute('r', 7); c.setAttribute('fill', color); c.setAttribute('fill-opacity', '0.85');
        c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1.5');
        layer.appendChild(c);
        label(layer, pt.vx * z - 3, pt.vy * z + 4, String(idx + 1), '#3a2a00');
      });
      if (m.pts.length) label(layer, m.pts[0].vx * z + 10, m.pts[0].vy * z - 8, `Count: ${m.value}`, color);
      // Invisible bbox hit so the whole count group can be dragged.
      if (m.pts.length) {
        const xs = m.pts.map((p) => p.vx * z), ys = m.pts.map((p) => p.vy * z);
        const minx = Math.min.apply(null, xs) - 10, miny = Math.min.apply(null, ys) - 10;
        const rect = ns('rect');
        rect.setAttribute('class', 'm-hit');
        rect.setAttribute('x', minx); rect.setAttribute('y', miny);
        rect.setAttribute('width', Math.max.apply(null, xs) - minx + 10);
        rect.setAttribute('height', Math.max.apply(null, ys) - miny + 10);
        rect.addEventListener('pointerdown', (e) => startMeasureDrag(m, e));
        layer.appendChild(rect);
      }
      return;
    }

    const closed = m.type === 'area';
    if (closed) {
      const poly = ns('polygon');
      poly.setAttribute('class', 'm-shape m-fill' + (selected ? ' selected' : ''));
      poly.setAttribute('points', m.pts.map((p) => P(p, z)).join(' '));
      poly.setAttribute('fill', color); poly.setAttribute('stroke', color);
      layer.appendChild(poly);
    }
    const line = ns('polyline');
    line.setAttribute('class', 'm-shape' + (selected ? ' selected' : ''));
    const pts = closed ? m.pts.concat([m.pts[0]]) : m.pts;
    line.setAttribute('points', pts.map((p) => P(p, z)).join(' '));
    line.setAttribute('stroke', color);
    layer.appendChild(line);
    m.pts.forEach((pt) => vdot(layer, pt, z, color));

    // Invisible wide hit line over the shape so it can be grabbed + dragged.
    const hit = ns('polyline');
    hit.setAttribute('class', 'm-hit');
    hit.setAttribute('points', pts.map((p) => P(p, z)).join(' '));
    hit.addEventListener('pointerdown', (e) => startMeasureDrag(m, e));
    layer.appendChild(hit);

    // Per-segment leg lengths for the selected shape (pipe/conduit/wall runs).
    if (selected && (m.type === 'length' || m.type === 'perimeter' || m.type === 'area')) {
      drawSegmentLabels(layer, m, z);
    }

    const anchor = m.type === 'area' ? centroid(m.pts)
      : m.type === 'angle' ? m.pts[1]
        : { vx: (m.pts[0].vx + m.pts[m.pts.length - 1].vx) / 2, vy: (m.pts[0].vy + m.pts[m.pts.length - 1].vy) / 2 };
    label(layer, anchor.vx * z + 6, anchor.vy * z - 6, m.label, color);
  }

  // Draw a small length label at the midpoint of every segment of a selected
  // length/perimeter/area measurement. Only shown when there are ≥2 segments —
  // a single-segment length already reads its total. Respects the feet-inches
  // display toggle. For an area the closing leg (last→first) is included.
  function drawSegmentLabels(layer, m, z) {
    const sc = scaleFor(m.page, m.pts);
    const segs = App.segmentLengths(m.type, m.pts, sc);
    if (!segs || segs.length < 2) return;
    const n = m.pts.length;
    for (let i = 0; i < segs.length; i++) {
      const a = m.pts[i], b = m.pts[(i + 1) % n];
      const t = ns('text');
      t.setAttribute('class', 'm-seglabel');
      t.setAttribute('x', (a.vx + b.vx) / 2 * z);
      t.setAttribute('y', (a.vy + b.vy) / 2 * z - 3);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = App.fmtMeasure('length', segs[i], sc.unit, fmtOpts());
      layer.appendChild(t);
    }
  }

  function drawPreview(layer, a, z) {
    const color = M._color || COLORS[a.tool] || '#2f6fed';
    const pts = a.pts.slice();
    const live = pts.concat(a.hover ? [a.hover] : []);
    if (live.length >= 2) {
      const line = ns('polyline');
      line.setAttribute('class', 'm-shape m-preview');
      line.setAttribute('points', live.map((p) => P(p, z)).join(' '));
      line.setAttribute('stroke', color);
      layer.appendChild(line);
    }
    live.forEach((pt) => vdot(layer, pt, z, color));
    if (a.hover && a.hover.snap) {
      if (a.hover.snapKind === 'content') {
        // Snapped to the drawing's own geometry — a CAD-style square endpoint cue.
        const s = 9, r = ns('rect'); r.setAttribute('class', 'm-snap-sq');
        r.setAttribute('x', a.hover.vx * z - s / 2); r.setAttribute('y', a.hover.vy * z - s / 2);
        r.setAttribute('width', s); r.setAttribute('height', s);
        layer.appendChild(r);
      } else {
        const c = ns('circle'); c.setAttribute('class', 'm-snap-dot');
        c.setAttribute('cx', a.hover.vx * z); c.setAttribute('cy', a.hover.vy * z); c.setAttribute('r', 5);
        layer.appendChild(c);
      }
    }
    // live readout
    if (live.length >= 2) {
      const prev = livePreviewValue(a, live);
      const at = live[live.length - 1];
      if (prev) label(layer, at.vx * z + 10, at.vy * z + 4, prev, color);
    }
  }
  function livePreviewValue(a, live) {
    if (a.tool === 'count') return `Count: ${a.pts.length}`;
    if (a.tool === 'angle') return live.length >= 3 ? `${angleAt(live[0], live[1], live[2]).toFixed(1)}°` : null;
    const type = a.tool === 'area' ? 'area' : a.tool === 'perimeter' ? 'perimeter' : 'length';
    const pts = a.tool === 'area' ? live : live;
    const { value, unit } = computeValue(type, a.page, pts);
    return fmtVal(type, value, unit);
  }

  function drawViewport(layer, v, z) {
    const r = ns('rect');
    r.setAttribute('class', 'viewport-rect');
    r.setAttribute('x', v.vx * z); r.setAttribute('y', v.vy * z);
    r.setAttribute('width', v.vw * z); r.setAttribute('height', v.vh * z);
    layer.appendChild(r);
    const t = ns('text');
    t.setAttribute('class', 'viewport-label');
    t.setAttribute('x', v.vx * z + 4); t.setAttribute('y', v.vy * z + 14);
    t.textContent = `⤢ ${v.label || v.ratioLabel}`;
    layer.appendChild(t);
  }

  const rectFrom = App.Geom.rectFrom;

  /* ---------------- scale modal ---------------- */
  M.openScaleModal = function (target, fromCalibrate) {
    M._scaleTarget = target;
    const modal = App.$('#scale-modal');
    App.$('#scale-modal-title').textContent = target.kind === 'viewport' ? 'Set Region Scale' : 'Set Scale';
    App.$('#scale-apply').textContent = target.kind === 'viewport' ? 'Apply region scale' : 'Apply scale';
    // apply-to only relevant for page scale
    App.$('.scale-apply').style.display = target.kind === 'viewport' ? 'none' : '';

    if (fromCalibrate && M._calib) {
      switchScaleTab('calibrate');
      const inches = M._calib.pdfLen / 72;
      App.$('#calib-drawn').textContent = `${inches.toFixed(3)} in on drawing`;
      App.$('#calib-result').classList.remove('hidden');
    } else {
      switchScaleTab('enter');
      App.$('#calib-result').classList.add('hidden');
    }
    modal.classList.remove('hidden');
  };
  function closeScaleModal() { App.$('#scale-modal').classList.add('hidden'); }

  function switchScaleTab(tab) {
    App.$$('.scale-tab').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
    App.$$('.scale-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.spanel !== tab));
  }

  function applyScale() {
    const activeTab = App.$('.scale-tab.active').dataset.stab;
    let factor, unit, ratioLabel;

    if (activeTab === 'calibrate') {
      if (!M._calib) { App.toast('Draw a calibration line first.', 'error'); return; }
      const realVal = parseFloat(App.$('#calib-real-val').value);
      unit = App.$('#calib-real-unit').value;
      if (!(realVal > 0)) { App.toast('Enter the real length.', 'error'); return; }
      factor = realVal / M._calib.pdfLen;
      ratioLabel = `${(M._calib.pdfLen / 72).toFixed(2)}in = ${realVal}${unit}`;
    } else {
      const dv = parseFloat(App.$('#enter-draw-val').value);
      const du = App.$('#enter-draw-unit').value;
      const rv = parseFloat(App.$('#enter-real-val').value);
      unit = App.$('#enter-real-unit').value;
      if (!(dv > 0) || !(rv > 0)) { App.toast('Enter both lengths.', 'error'); return; }
      const drawPts = dv * App.UNITS[du].perPoint;
      factor = rv / drawPts;
      ratioLabel = `${dv}${du} = ${rv}${unit}`;
    }

    App.History.snapshot();
    const target = M._scaleTarget;
    if (target.kind === 'viewport') {
      const list = App.state.viewports[target.page] || (App.state.viewports[target.page] = []);
      list.push({ id: ++App.state.viewportSeq, ...target.rect, factor, unit, ratioLabel, label: ratioLabel });
    } else {
      const applyTo = App.$('#scale-apply-to').value;
      const scale = { factor, unit, ratioLabel };
      if (applyTo === 'all') {
        for (let p = 1; p <= App.state.numPages; p++) App.state.scales[p] = { ...scale };
      } else {
        App.state.scales[target.page] = scale;
      }
    }
    M._calib = null;
    closeScaleModal();
    M.recomputeAll();
    App.toast(`Scale set: ${ratioLabel}`, 'success');
  };

  /* ---------------- measurements panel ---------------- */
  M.togglePanel = function () {
    const panel = App.$('#measure-panel');
    const open = panel.classList.toggle('hidden');
    document.body.classList.toggle('has-mpanel', !open);
    if (!panel.classList.contains('hidden')) M.renderPanel();
  };

  M.renderPanel = function () {
    const list = App.$('#mp-list');
    const all = App.state.measurements;
    const q = ((App.$('#mp-filter') && App.$('#mp-filter').value) || '').trim().toLowerCase();
    const ms = q
      ? all.filter((m) => m.type.includes(q) || (m.label || '').toLowerCase().includes(q) || ('p' + m.page).includes(q))
      : all;
    list.innerHTML = '';
    if (!all.length) {
      list.innerHTML = '<div class="mp-empty"><div class="mp-empty-ico">📐</div>No measurements yet.<br>Use the Measure menu to add some.</div>';
    } else if (!ms.length) {
      list.innerHTML = '<div class="mp-empty">No measurements match this filter.</div>';
    } else {
      ms.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'mp-row' + (m.id === App.state.measureSelectedId ? ' selected' : '');
        row.innerHTML =
          `<span class="mp-swatch" style="background:${colorOf(m)}"></span>` +
          `<span class="mp-type">${m.type}</span>` +
          `<span class="mp-val">${m.label}</span>` +
          `<span class="mp-pg">p${m.page}</span>` +
          `<button class="mp-del" title="Delete">✕</button>`;
        row.addEventListener('click', (e) => {
          if (e.target.classList.contains('mp-del')) { M.remove(m.id); return; }
          M.select(m.id);
        });
        list.appendChild(row);
        // Selected length/perimeter/area: list each leg's length underneath.
        if (m.id === App.state.measureSelectedId &&
            (m.type === 'length' || m.type === 'perimeter' || m.type === 'area')) {
          const sc = scaleFor(m.page, m.pts);
          const segs = App.segmentLengths(m.type, m.pts, sc);
          if (segs && segs.length >= 2) {
            const box = document.createElement('div');
            box.className = 'mp-segs';
            box.innerHTML = segs.map((s, i) =>
              `<span class="mp-seg"><b>${i + 1}</b>&nbsp;${App.fmtMeasure('length', s, sc.unit, fmtOpts())}</span>`).join('');
            list.appendChild(box);
          }
        }
      });
    }
    // totals per unit for length + area (over all measurements, not the filter)
    const tot = {};
    all.forEach((m) => {
      if (m.value == null) return;
      const key = m.type === 'area' ? `area ${m.unit}²` : m.type === 'count' ? 'count' :
        (m.type === 'length' || m.type === 'perimeter') ? `length ${m.unit}` : null;
      if (!key) return;
      tot[key] = (tot[key] || 0) + m.value;
    });
    const totEl = App.$('#mp-totals');
    const parts = Object.keys(tot).map((k) => {
      if (k === 'count') return `count: <b>${tot[k]}</b>`;
      if (k.startsWith('length ')) {
        // Respect the feet-inches toggle for the aggregate length too.
        return `length: <b>${App.fmtMeasure('length', tot[k], k.slice(7), fmtOpts())}</b>`;
      }
      return `${k}: <b>${tot[k].toFixed(2)}</b>`; // area <unit>²
    });
    totEl.innerHTML = parts.length ? parts.join('<br>') : '';
  };

  M.select = function (id) {
    App.state.measureSelectedId = id;
    M.repositionAll();
    M.renderPanel();
    const m = App.state.measurements.find((x) => x.id === id);
    if (m) {
      const pe = App.state.pageEls[m.page - 1];
      if (pe) pe.holder.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // Keyboard nudge (arrow keys) for the selected measurement.
  M.nudge = function (dx, dy) {
    const m = App.state.measurements.find((x) => x.id === App.state.measureSelectedId);
    if (!m) return;
    App.History.snapshot();
    m.pts = m.pts.map((pt) => ({ vx: pt.vx + dx, vy: pt.vy + dy }));
    M.repositionAll();
  };

  // Drag a whole measurement to reposition it (mouse/touch). Wired to the
  // invisible wide "m-hit" element over each shape; only active when no measure
  // tool is armed (so drawing a new measurement still works).
  function startMeasureDrag(m, e) {
    e.preventDefault(); e.stopPropagation();
    M.select(m.id);
    const z = App.state.zoom, sx = e.clientX, sy = e.clientY;
    const orig = m.pts.map((p) => ({ vx: p.vx, vy: p.vy }));
    App.History.snapshot();
    function move(ev) {
      let dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } // lock to an axis
      m.pts = orig.map((p) => ({ vx: p.vx + dx, vy: p.vy + dy }));
      M.scheduleReposition(m.page);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      M.repositionAll();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  M._startDrag = startMeasureDrag;

  // ---------- Copy / duplicate ----------
  M.getSelected = function () {
    return App.state.measurements.find((x) => x.id === App.state.measureSelectedId) || null;
  };
  // Create a new measurement from a (cloned) data object, offset by (dx,dy)
  // viewport points. The value/label are recomputed at the new location (the
  // scale can differ per region). Returns the new id.
  M.paste = function (data, dx, dy) {
    if (!data) return null;
    App.History.snapshot();
    const m = JSON.parse(JSON.stringify(data));
    m.id = ++App.state.measureSeq;
    m.pts = m.pts.map((p) => ({ vx: p.vx + (dx || 0), vy: p.vy + (dy || 0) }));
    const { value, unit } = computeValue(m.type, m.page, m.pts);
    m.value = value; m.unit = unit;
    m.label = fmtVal(m.type, value, unit);
    App.state.measurements.push(m);
    App.$('#btn-save').disabled = false;
    M.select(m.id);
    M.renderPanel();
    return m.id;
  };

  M.remove = function (id) {
    App.History.snapshot();
    App.state.measurements = App.state.measurements.filter((m) => m.id !== id);
    if (App.state.measureSelectedId === id) App.state.measureSelectedId = null;
    M.repositionAll();
    M.renderPanel();
  };

  M.clearAll = async function () {
    if (!App.state.measurements.length && !Object.keys(App.state.viewports).length) return;
    const ok = await App.confirm(
      'Delete all measurements and scale regions? You can undo this with Ctrl+Z.',
      { title: 'Clear measurements', okLabel: 'Clear all', danger: true });
    if (!ok) return;
    App.History.snapshot();
    App.state.measurements = [];
    App.state.viewports = {};
    App.state.measureSelectedId = null;
    M.repositionAll();
    M.renderPanel();
  };

  M.exportCsv = async function () {
    const ms = App.state.measurements;
    if (!ms.length) { App.toast('No measurements to export.', 'error'); return; }
    const rows = [['#', 'Type', 'Page', 'Value', 'Unit', 'Display', 'Points']];
    ms.forEach((m, i) => {
      const unit = m.type === 'area' ? (m.unit ? m.unit + '²' : '') : (m.unit || '');
      rows.push([i + 1, m.type, m.page, m.value == null ? '' : m.value.toFixed(3), unit, m.label || '', m.pts.length]);
    });
    const csv = rows.map((r) => r.map((c) => {
      const s = String(c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    const res = await window.api.saveTextDialog(`${base}-measurements.csv`, csv);
    if (res && res.ok) App.toast(`Saved: ${res.path}`, 'success', 5000);
    else if (res && res.error) App.toast('Could not save CSV: ' + res.error, 'error');
  };

  /* ---------------- init ---------------- */
  M.init = function () {
    // populate unit selects
    const units = Object.keys(App.UNITS);
    ['#enter-draw-unit', '#enter-real-unit', '#calib-real-unit'].forEach((sel) => {
      const el = App.$(sel);
      units.forEach((u) => { const o = document.createElement('option'); o.value = u; o.textContent = u; el.appendChild(o); });
    });
    App.$('#enter-draw-unit').value = 'in';
    App.$('#enter-real-unit').value = 'ft';
    App.$('#calib-real-unit').value = 'ft';

    // presets
    const presets = [
      ['1/8" = 1\'-0"', 0.125, 'in', 1, 'ft'],
      ['1/4" = 1\'-0"', 0.25, 'in', 1, 'ft'],
      ['1/2" = 1\'-0"', 0.5, 'in', 1, 'ft'],
      ['1" = 1\'-0"', 1, 'in', 1, 'ft'],
      ['1" = 10\'', 1, 'in', 10, 'ft'],
      ['1" = 20\'', 1, 'in', 20, 'ft'],
      ['1" = 30\'', 1, 'in', 30, 'ft'],
      ['1" = 50\'', 1, 'in', 50, 'ft'],
      ['1" = 100\'', 1, 'in', 100, 'ft'],
      ['1:20 (metric)', 1, 'mm', 0.02, 'm'],
      ['1:50 (metric)', 1, 'mm', 0.05, 'm'],
      ['1:100 (metric)', 1, 'mm', 0.1, 'm'],
      ['1:200 (metric)', 1, 'mm', 0.2, 'm'],
      ['1:500 (metric)', 1, 'mm', 0.5, 'm'],
      ['1:1000 (metric)', 1, 'mm', 1, 'm']
    ];
    const psel = App.$('#scale-preset');
    presets.forEach((p, i) => { const o = document.createElement('option'); o.value = i; o.textContent = p[0]; psel.appendChild(o); });
    psel.addEventListener('change', () => {
      const p = presets[psel.value]; if (!p) return;
      App.$('#enter-draw-val').value = p[1]; App.$('#enter-draw-unit').value = p[2];
      App.$('#enter-real-val').value = p[3]; App.$('#enter-real-unit').value = p[4];
    });

    App.$$('.scale-tab').forEach((b) => b.addEventListener('click', () => switchScaleTab(b.dataset.stab)));
    App.$('#scale-close').addEventListener('click', closeScaleModal);
    App.$('#scale-cancel').addEventListener('click', closeScaleModal);
    App.$('#scale-apply').addEventListener('click', applyScale);
    App.$('#calib-draw').addEventListener('click', () => {
      closeScaleModal();
      M._tool = 'calibrate'; M._active = null;
      App.setMode('measure');
      App.$$('.page-holder').forEach((h) => h.classList.add('measuring'));
      App.toast('Click two points on a known dimension.', 'info', 4000);
    });

    // measurement color picker (applies to new measurements only)
    const colorInput = App.$('#measure-color');
    if (colorInput) colorInput.addEventListener('input', () => M.setColor(colorInput.value));
    const colorReset = App.$('#measure-color-reset');
    if (colorReset) colorReset.addEventListener('click', (e) => { e.stopPropagation(); M.setColor(null); });

    // Snap-to-drawing toggle — snap the cursor to the PDF's own geometry.
    if (App.Snap) App.Snap.init();
    const snapCb = App.$('#measure-snap');
    if (snapCb) {
      if (App.Snap) snapCb.checked = App.Snap.enabled;
      snapCb.addEventListener('change', () => { if (App.Snap) App.Snap.setEnabled(snapCb.checked); });
    }
    // Feet-inches display toggle (persisted) — recompute every label on change.
    M._fiOn = App.Prefs ? App.Prefs.get('measureFeetInches', false) === true : false;
    const fiCb = App.$('#measure-ftin');
    if (fiCb) {
      fiCb.checked = M._fiOn;
      fiCb.addEventListener('change', () => M.setFeetInches(fiCb.checked));
    }

    // panel
    App.$('#mp-close').addEventListener('click', M.togglePanel);
    App.$('#mp-export').addEventListener('click', M.exportCsv);
    App.$('#mp-clear').addEventListener('click', M.clearAll);
    const filt = App.$('#mp-filter');
    if (filt) filt.addEventListener('input', M.renderPanel);
  };

  App.Measure = M;
})();
