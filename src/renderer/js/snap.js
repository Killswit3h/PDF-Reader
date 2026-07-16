'use strict';

/*
 * Content snapping — snap the cursor to the PDF's REAL vector geometry.
 *
 * The measure tool already snaps to previously-drawn measurement vertices
 * (measure.js `snapVertex`). This adds the big precision win: snapping to the
 * drawing itself — the endpoints and corners of the lines/polylines/rectangles
 * PDF.js drew — so a take-off traces the actual linework instead of eyeballing.
 *
 * How it works: PDF.js exposes each page's display list via `getOperatorList()`.
 * We walk it once per page, tracking the current transform (CTM) across
 * save/restore/transform and form-XObject nesting, pull the on-path anchor
 * vertices out of every `constructPath` op (pure logic in App.Geom), map them to
 * the app's scale-1 viewport space with `viewport.convertToViewportPoint`, and
 * index them in a coarse spatial hash so a hover can find the nearest anchor in
 * O(cells) instead of scanning tens of thousands of points.
 *
 * Everything is renderer-only (PDF.js + our geometry) so it ships to Windows,
 * macOS and Android identically — no `window.api` surface. Harvesting is lazy
 * and cached per page; a page that hasn't been harvested yet simply yields no
 * content snaps until it's ready (measure.js falls back to vertex snapping).
 */
(function () {
  const CELL = 16;          // spatial-hash cell size, in scale-1 viewport points
  const QUANT = 4;          // dedupe resolution: quantize anchors to 1/4 point
  const MAX_POINTS = 400000; // safety cap so a pathological sheet can't OOM

  const S = {
    enabled: true,          // toggled from the measure menu; persisted in Prefs
    _pages: {},             // pageNum -> { grid: Map<cellKey, [{vx,vy}]>, count, capped }
    _pending: {}            // pageNum -> Promise (harvest in flight)
  };

  function opsCodes() {
    const O = window.pdfjsLib && window.pdfjsLib.OPS;
    if (!O) return null;
    return {
      moveTo: O.moveTo, lineTo: O.lineTo, curveTo: O.curveTo,
      curveTo2: O.curveTo2, curveTo3: O.curveTo3,
      rectangle: O.rectangle, closePath: O.closePath,
      save: O.save, restore: O.restore, transform: O.transform,
      formBegin: O.paintFormXObjectBegin, formEnd: O.paintFormXObjectEnd,
      constructPath: O.constructPath
    };
  }

  const cellKey = (cx, cy) => cx + ',' + cy;

  // Add a scale-1 viewport point to the grid, deduped at 1/QUANT-point
  // resolution so coincident endpoints from stacked strokes collapse to one.
  function addPoint(store, seen, vx, vy) {
    if (store.count >= MAX_POINTS) { store.capped = true; return; }
    const qk = Math.round(vx * QUANT) + ':' + Math.round(vy * QUANT);
    if (seen.has(qk)) return;
    seen.add(qk);
    const k = cellKey(Math.floor(vx / CELL), Math.floor(vy / CELL));
    let bucket = store.grid.get(k);
    if (!bucket) { bucket = []; store.grid.set(k, bucket); }
    bucket.push({ vx, vy });
    store.count++;
  }

  // Parse a page's operator list into a spatial index of anchor vertices.
  async function harvest(pageNum) {
    const doc = App.state.pdfDoc;
    if (!doc) return null;
    const codes = opsCodes();
    if (!codes || codes.constructPath == null) return null;

    const page = await doc.getPage(pageNum);
    const vp = App.state.baseViewports[pageNum - 1] || page.getViewport({ scale: 1 });
    const opList = await page.getOperatorList();
    const fn = opList.fnArray, ar = opList.argsArray;

    const store = { grid: new Map(), count: 0, capped: false };
    const seen = new Set();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const { matMul, matApply, constructPathVertices } = App.Geom;

    for (let i = 0; i < fn.length; i++) {
      const op = fn[i];
      if (op === codes.save) {
        stack.push(ctm);
      } else if (op === codes.restore) {
        if (stack.length) ctm = stack.pop();
      } else if (op === codes.transform) {
        ctm = matMul(ctm, ar[i]);
      } else if (op === codes.formBegin) {
        // Form XObject: PDF.js does save() then transform(matrix). Mirror it.
        stack.push(ctm);
        const m = ar[i] && ar[i][0];
        if (Array.isArray(m) && m.length === 6) ctm = matMul(ctm, m);
      } else if (op === codes.formEnd) {
        if (stack.length) ctm = stack.pop();
      } else if (op === codes.constructPath) {
        const verts = constructPathVertices(ar[i][0], ar[i][1], codes);
        for (let v = 0; v < verts.length; v++) {
          const u = matApply(ctm, verts[v][0], verts[v][1]);   // → PDF user space
          const p = vp.convertToViewportPoint(u[0], u[1]);     // → scale-1 viewport
          addPoint(store, seen, p[0], p[1]);
          if (store.capped) break;
        }
        if (store.capped) break;
      }
    }
    return store;
  }

  // Kick off (and cache) harvesting for a page. Idempotent and cheap to re-call
  // — safe to invoke on every pointer move while a measure tool is armed.
  S.ensure = function (pageNum) {
    if (!S.enabled || !pageNum) return;
    if (S._pages[pageNum] || S._pending[pageNum]) return;
    const pr = harvest(pageNum)
      .then((store) => { if (store) S._pages[pageNum] = store; })
      .catch(() => { /* a page we can't parse simply yields no content snaps */ })
      .finally(() => { delete S._pending[pageNum]; });
    S._pending[pageNum] = pr;
  };

  // Nearest content anchor to `raw` ({vx,vy}) within `thr` scale-1 points, or
  // null. Synchronous: reads only the cached grid (returns null until ready, and
  // opportunistically triggers harvesting so the next hover can snap).
  S.query = function (pageNum, raw, thr) {
    if (!S.enabled) return null;
    const store = S._pages[pageNum];
    if (!store) { S.ensure(pageNum); return null; }
    const c0 = Math.floor((raw.vx - thr) / CELL), c1 = Math.floor((raw.vx + thr) / CELL);
    const r0 = Math.floor((raw.vy - thr) / CELL), r1 = Math.floor((raw.vy + thr) / CELL);
    let best = null, bd = thr;
    for (let cx = c0; cx <= c1; cx++) {
      for (let cy = r0; cy <= r1; cy++) {
        const bucket = store.grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const p = bucket[i];
          const d = Math.hypot(p.vx - raw.vx, p.vy - raw.vy);
          if (d < bd) { bd = d; best = p; }
        }
      }
    }
    return best ? { vx: best.vx, vy: best.vy } : null;
  };

  // Drop all cached geometry (on document/tab change). Page contents differ per
  // document, and stale points would snap onto the wrong drawing.
  S.clear = function () {
    S._pages = {};
    S._pending = {};
  };

  S.setEnabled = function (on) {
    S.enabled = !!on;
    if (App.Prefs) { try { App.Prefs.set('measureContentSnap', S.enabled); } catch (_) { /* quota */ } }
  };

  S.init = function () {
    if (App.Prefs) S.enabled = App.Prefs.get('measureContentSnap', true) !== false;
  };

  App.Snap = S;
})();
