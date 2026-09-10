'use strict';

/*
 * The in-page performance probe. Runs INSIDE the FieldMark renderer — the
 * Electron window, headless Chromium driving www/, or a real tablet's WebView
 * via bench/serve.js — and measures the same things the same way everywhere:
 *
 *   open    time from App.Viewer.load() to the first page painted, cold and warm
 *   pinch   time from pinch end (commitZoomPreview) to a sharp re-render at a
 *           target zoom, for the current page and for every visible page
 *   pan     longest task / longest animation frame / worst frame gap during a
 *           synthetic pan of N seconds
 *   canvas  RGBA bytes over every <canvas> in the DOM, and the largest one
 *   heap    JS heap where the engine exposes it (Chromium; Safari does not)
 *   markup  on heavy-markup.pdf: repositionAll, select, a 60-move drag through
 *           the real pointer path, undo
 *
 * It is injected, never bundled: the runners concatenate src/shared/perf-stats.js
 * (the arithmetic) with this file and evaluate the pair in the page, so nothing
 * ships in the product. Contract: window.__FMPerf.runAll(loadFixture, log) →
 * result object; App.PerfStats.reportRows(result) turns it into the table in
 * docs/perf/00-baseline.md.
 *
 * Every wait is state-driven (PDF.js renderingState, eventBus events), never a
 * fixed sleep, so a fast machine is not padded and a slow tablet is not cut off.
 */
(function () {
  const P = {};
  const now = () => performance.now();
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(now())));
  const FINISHED = 3; // pdf_viewer RenderingStates.FINISHED
  const TIMEOUT = 120000;

  const viewer = () => App.Viewer._pdfViewer;
  const bus = () => App.Viewer._eventBus;
  const stats = () => App.PerfStats;

  // Resolve with the elapsed ms once page `n` (1-based) has a FINISHED render
  // at the viewer's current scale. Polls once per frame.
  function waitPageFinished(n, label) {
    const t0 = now();
    return new Promise((resolve, reject) => {
      (function tick() {
        const V = viewer();
        const pv = V && V.getPageView(n - 1);
        if (pv && pv.renderingState === FINISHED) return resolve(now() - t0);
        if (now() - t0 > TIMEOUT) return reject(new Error((label || 'page ' + n) + ' never finished rendering'));
        requestAnimationFrame(tick);
      })();
    });
  }
  // Same, for every page PDF.js currently considers visible.
  function waitVisibleFinished(label) {
    const t0 = now();
    return new Promise((resolve, reject) => {
      (function tick() {
        const V = viewer();
        let views = [];
        try { views = V._getVisiblePages().views; } catch (_) { views = []; }
        if (!views.length) { const pv = V && V.getPageView(App.state.currentPage - 1); views = pv ? [{ view: pv }] : []; }
        if (views.length && views.every((v) => v.view.renderingState === FINISHED)) return resolve(now() - t0);
        if (now() - t0 > TIMEOUT) return reject(new Error((label || 'visible pages') + ' never finished rendering'));
        requestAnimationFrame(tick);
      })();
    });
  }

  P.heap = function () {
    const m = performance.memory;
    if (!m || !m.usedJSHeapSize) return null;
    return {
      usedMB: Math.round(m.usedJSHeapSize / 1048576 * 10) / 10,
      totalMB: Math.round(m.totalJSHeapSize / 1048576 * 10) / 10
    };
  };

  P.canvas = function () {
    const sizes = Array.from(document.querySelectorAll('canvas')).map((c) => ({ width: c.width, height: c.height }));
    return Object.assign(stats().canvasBudget(sizes), { currentPagePainted: P.pagePainted(App.state.currentPage) });
  };

  // Did the current page's canvas actually get pixels? A canvas past the
  // engine's size limit reports a FINISHED render and stays blank (the tablet
  // failure the brief describes), so a timing alone can look excellent while
  // the sheet is empty. Samples a grid of pixels; "painted" means at least one
  // sample is opaque and not white. Null when the canvas cannot be read.
  P.pagePainted = function (pageNum) {
    const V = viewer();
    const pv = V && V.getPageView((pageNum || 1) - 1);
    const c = pv && pv.canvas;
    if (!c || !c.width || !c.height) return null;
    try {
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      const n = 12;
      for (let i = 1; i < n; i++) {
        for (let j = 1; j < n; j++) {
          const px = ctx.getImageData(Math.floor(c.width * i / n), Math.floor(c.height * j / n), 1, 1).data;
          if (px[3] > 0 && (px[0] < 250 || px[1] < 250 || px[2] < 250)) return true;
        }
      }
      return false;
    } catch (_) { return null; }
  };

  // Open `buffer` as a new document and time it to the first painted page.
  // Viewer.init() runs synchronously inside App.Viewer.load(), so the event bus
  // exists as soon as load() has been called, even on a cold first open.
  P.open = async function (buffer, name) {
    const t0 = now();
    const loading = App.Viewer.load(buffer, name, null);
    const eb = bus();
    let pagesInitMs = null, firstRenderMs = null, firstPage = null;
    const onInit = () => { if (pagesInitMs == null) pagesInitMs = now() - t0; };
    const onRendered = (e) => { if (firstRenderMs == null) { firstRenderMs = now() - t0; firstPage = e.pageNumber; } };
    eb.on('pagesinit', onInit);
    eb.on('pagerendered', onRendered);
    try {
      await loading;
      while (firstRenderMs == null) {
        if (now() - t0 > TIMEOUT) throw new Error('no page rendered after open');
        await frame();
      }
      // "Painted": the render is on screen once the compositor has had a frame.
      await frame(); await frame();
      const firstPaintMs = now() - t0;
      return { name, numPages: App.state.numPages, pagesInitMs, firstRenderMs, firstPaintMs, firstPage };
    } finally {
      eb.off('pagesinit', onInit);
      eb.off('pagerendered', onRendered);
    }
  };

  // Close every open tab so the next open is a fresh document, not a second
  // tab on top of the last one.
  P.closeAll = function () {
    if (!App.Tabs) return;
    App.Tabs.list().map((t) => t.id).forEach((id) => App.Tabs.close(id));
  };

  P.fitWidth = async function () {
    App.Viewer.fitWidth();
    await frame();
    await waitVisibleFinished('fit-width');
  };

  // A pinch to `targetScale` (PDF.js scale; 2 = 200%) as the app sees one: a
  // burst of zoomPreviewBy ticks riding the CSS transform, then the commit.
  // The app would commit on its own 140 ms after the last tick; the probe
  // commits explicitly and times from THAT moment to the crisp re-render,
  // which is what the user feels as "the page catches up".
  P.pinch = async function (targetScale) {
    await waitVisibleFinished('pre-pinch');
    const V = viewer();
    const container = document.querySelector('#viewerContainer');
    const rect = container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const base = V.currentScale;
    const steps = 12;
    const per = Math.pow(targetScale / base, 1 / steps);
    const tGesture = now();
    for (let i = 0; i < steps; i++) { App.Viewer.zoomPreviewBy(per, cx, cy); await frame(); }
    const gestureMs = now() - tGesture;
    const current = App.state.currentPage;
    const t0 = now();
    App.Viewer.commitZoomPreview();
    const commitSyncMs = now() - t0; // the synchronous part: scale set + overlay refresh
    const currentPageSharpMs = await waitPageFinished(current, 'pinch page ' + current);
    const visibleSharpMs = (now() - t0) + await waitVisibleFinished('pinch visible');
    await frame();
    return {
      targetPct: Math.round(targetScale * 100),
      achievedPct: Math.round(V.currentScale * 100),
      gestureMs: Math.round(gestureMs),
      commitSyncMs: Math.round(commitSyncMs * 10) / 10,
      currentPageSharpMs: Math.round(currentPageSharpMs * 10) / 10,
      visibleSharpMs: Math.round(visibleSharpMs * 10) / 10,
      settleTimerMs: 140,
      canvas: P.canvas()
    };
  };

  function observe(type) {
    const entries = [];
    let obs = null;
    try {
      const supported = PerformanceObserver.supportedEntryTypes || [];
      if (!supported.includes(type)) return { entries, supported: false, stop() {} };
      obs = new PerformanceObserver((list) => entries.push(...list.getEntries()));
      obs.observe({ type, buffered: false });
      return {
        entries, supported: true,
        stop() { try { entries.push(...obs.takeRecords()); obs.disconnect(); } catch (_) { /* done */ } }
      };
    } catch (_) {
      return { entries, supported: false, stop() {} };
    }
  }

  // Scroll the container at `pxPerSec` for `ms`, one step per animation frame,
  // and record what blocked the main thread meanwhile.
  P.pan = async function (ms, pxPerSec) {
    await waitVisibleFinished('pre-pan');
    const container = document.querySelector('#viewerContainer');
    const longTasks = observe('longtask');
    const loaf = observe('long-animation-frame');
    const gaps = [];
    const startTop = container.scrollTop;
    let last = await frame();
    const t0 = last;
    while (now() - t0 < ms) {
      const t = await frame();
      const dt = t - last;
      gaps.push(dt);
      container.scrollTop += pxPerSec * (dt / 1000);
      last = t;
    }
    // Let the observers deliver their last batch before reading them.
    await frame(); await frame();
    longTasks.stop(); loaf.stop();
    const S = stats();
    return {
      durationMs: ms,
      pxPerSec,
      zoomPct: Math.round(viewer().currentScale * 100),
      scrolledPx: Math.round(container.scrollTop - startTop),
      longTasks: Object.assign({ supported: longTasks.supported }, S.summarizeTasks(longTasks.entries)),
      longAnimationFrames: Object.assign({ supported: loaf.supported }, S.summarizeTasks(loaf.entries)),
      frames: S.frameStats(gaps)
    };
  };

  // The heavy-markup.pdf interactions, through the same code paths a user hits.
  P.markup = async function () {
    await waitVisibleFinished('pre-markup');
    const S = stats();
    const time = (fn) => { const a = now(); fn(); return Math.round((now() - a) * 100) / 100; };
    const repositionMs = time(() => App.Markup.repositionAll());
    const measureRepositionMs = time(() => App.Measure.repositionAll());
    const pe = App.state.pageEls[0];
    const svg = pe && pe.holder.querySelector('.markup-svg');
    const svgNodes = svg ? svg.querySelectorAll('*').length : 0;

    const target = App.state.annotations.slice().reverse().find((a) => a.type === 'rect');
    if (!target) throw new Error('heavy-markup.pdf has no rect annotation to drag');
    // startDrag replaces an.pts with a fresh array on every move, so keep the
    // starting coordinate rather than a reference to the array.
    const startVx = target.pts[0].vx;
    const selectMs = time(() => App.Markup.select(target.id));
    await frame();

    // Find the rect's own SVG element (its hit target) by its drawn position.
    const z = App.state.zoom;
    const b = App.Geom.bbox(target.pts);
    const el = Array.from(svg.querySelectorAll('rect.hit')).find((r) =>
      Math.abs(parseFloat(r.getAttribute('x')) - b.x * z) < 0.01 &&
      Math.abs(parseFloat(r.getAttribute('y')) - b.y * z) < 0.01);
    if (!el) throw new Error('could not locate the selected rect in the markup SVG');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

    // Main-thread work of a move = the synchronous handler + whatever it
    // scheduled into the next animation frame (the rAF-coalesced redraw).
    let rafWork = 0;
    const origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
      return origRAF.call(window, (ts) => { const a = now(); cb(ts); rafWork += now() - a; });
    };
    const ev = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1
    });
    const steps = [];
    let downMs = 0, upMs = 0;
    try {
      downMs = time(() => el.dispatchEvent(ev('pointerdown', cx, cy)));
      const moves = 60;
      for (let i = 1; i <= moves; i++) {
        const w0 = rafWork;
        const a = now();
        window.dispatchEvent(ev('pointermove', cx + i, cy + i * 0.5));
        const sync = now() - a;
        await frame();
        steps.push(sync + (rafWork - w0));
      }
      upMs = time(() => window.dispatchEvent(ev('pointerup', cx + moves, cy + moves * 0.5)));
    } finally {
      window.requestAnimationFrame = origRAF;
    }
    const moved = App.state.annotations.find((a) => a.id === target.id);
    const movedBy = moved ? Math.round((moved.pts[0].vx - startVx) * 100) / 100 : null;
    await frame();
    const undoMs = time(() => App.History.undo());
    await frame();
    return {
      annotations: App.state.annotations.length,
      measurements: App.state.measurements.length,
      svgNodes,
      repositionMs, measureRepositionMs, selectMs,
      drag: Object.assign({ downMs, upMs, movedBy }, S.stepStats(steps)),
      undoMs,
      heap: P.heap()
    };
  };

  function env() {
    const isDesktop = !!(window.api && window.api.isDesktop);
    return {
      ua: navigator.userAgent,
      platform: isDesktop ? 'electron' : (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? 'capacitor' : 'web'),
      dpr: window.devicePixelRatio || 1,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      coarse: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches),
      cores: navigator.hardwareConcurrency || null,
      deviceMemoryGB: navigator.deviceMemory || null,
      maxCanvasPixels: (() => { try { return viewer().maxCanvasPixels; } catch (_) { return null; } })(),
      version: App.VERSION || null
    };
  }

  // The whole sequence. `load(name)` returns an ArrayBuffer for a fixture file;
  // `log(msg)` is optional progress reporting.
  P.runAll = async function (load, log, opts) {
    opts = opts || {};
    const say = (m) => { if (log) log(m); };
    const panMs = opts.panMs || 3000;
    const panSpeed = opts.panPxPerSec || 900;
    const result = { startedAt: new Date().toISOString(), env: null, open: {}, pinch: {}, pan: null, canvas: null, heap: null, markup: null };

    say('loading dense-plans.pdf');
    const dense = await load('dense-plans.pdf');
    P.closeAll();
    say('cold open');
    result.open.cold = await P.open(dense.slice(0), 'dense-plans.pdf');
    result.env = env();
    P.closeAll();
    await frame();
    say('warm open');
    result.open.warm = await P.open(dense.slice(0), 'dense-plans.pdf');
    await P.fitWidth();

    say('pinch to 200%');
    result.pinch[200] = await P.pinch(2);
    say('pan ' + panMs + ' ms at 200%');
    result.pan = await P.pan(panMs, panSpeed);
    await P.fitWidth();
    say('pinch to 400%');
    result.pinch[400] = await P.pinch(4);
    result.canvas = P.canvas();
    result.heap = P.heap();

    say('loading heavy-markup.pdf');
    const heavy = await load('heavy-markup.pdf');
    P.closeAll();
    await frame();
    const hv = await P.open(heavy, 'heavy-markup.pdf');
    await P.fitWidth();
    say('markup interactions');
    result.markup = Object.assign({ openMs: Math.round(hv.firstPaintMs * 10) / 10 }, await P.markup());
    result.finishedAt = new Date().toISOString();
    say('done');
    return result;
  };

  window.__FMPerf = P;
})();
