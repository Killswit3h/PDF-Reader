'use strict';

/*
 * Pure arithmetic behind the performance apparatus (bench/probe.js, the
 * bench/ runners and the SMOKE_PERF scenario). Kept here, dual-exported and
 * unit-tested, so the numbers every PR reports against docs/perf/00-baseline.md
 * are computed one way everywhere: the same summary of a long-task list, the
 * same canvas budget, the same frame statistics, the same report rows.
 *
 *   Node    → require() returns the named functions
 *   browser → the same names land on App.PerfStats
 *
 * Nothing here touches the DOM or PDF.js; the probe feeds it plain numbers.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; root.App.PerfStats = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  const round = (n, d) => {
    if (n == null || !isFinite(n)) return null;
    const f = Math.pow(10, d == null ? 1 : d);
    return Math.round(n * f) / f;
  };

  // Nearest-rank percentile of a numeric list (p in 0..100). Empty → null.
  function percentile(values, p) {
    const v = (values || []).filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const rank = Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length)));
    return v[rank - 1];
  }

  // Summarize PerformanceObserver entries ({ duration } each): how many, the
  // longest, the total blocked time, and p95. The brief's target is "no long
  // task over 100 ms during pan or pinch", so `over100` is counted directly.
  function summarizeTasks(entries) {
    const d = (entries || []).map((e) => (e && typeof e.duration === 'number' ? e.duration : 0));
    let longest = 0, total = 0, over100 = 0;
    for (const x of d) { if (x > longest) longest = x; total += x; if (x > 100) over100++; }
    return {
      count: d.length,
      longestMs: round(longest),
      totalMs: round(total),
      p95Ms: round(percentile(d, 95)),
      over100
    };
  }

  // Canvas memory for a list of { width, height } backing-store sizes: RGBA
  // bytes summed over every canvas, the largest single canvas in pixels, and
  // the two caps the brief sets (16.7 MP per canvas on a WebView; 200 MB total
  // desktop / 100 MB tablet are judged by the caller, which knows the device).
  function canvasBudget(sizes) {
    let bytes = 0, maxPixels = 0, maxBytes = 0, count = 0;
    for (const c of sizes || []) {
      const w = c && c.width > 0 ? c.width : 0, h = c && c.height > 0 ? c.height : 0;
      const px = w * h;
      if (!px) continue;
      count++;
      bytes += px * 4;
      if (px > maxPixels) { maxPixels = px; maxBytes = px * 4; }
    }
    return {
      count,
      bytes,
      megabytes: round(bytes / 1048576),
      maxPixels,
      maxMegapixels: round(maxPixels / 1e6, 2),
      maxBytes,
      overWebViewCap: maxPixels > 16777216
    };
  }

  // Frame-to-frame gaps (ms) sampled with requestAnimationFrame during a
  // gesture. Long gaps are the only long-task signal Safari exposes (it has no
  // `longtask` observer), so the device runs lean on these.
  function frameStats(gaps) {
    const g = (gaps || []).filter((x) => typeof x === 'number' && isFinite(x) && x >= 0);
    if (!g.length) return { frames: 0, meanMs: null, maxMs: null, p95Ms: null, over16: 0, over100: 0 };
    let sum = 0, max = 0, over16 = 0, over100 = 0;
    for (const x of g) { sum += x; if (x > max) max = x; if (x > 16.7) over16++; if (x > 100) over100++; }
    return {
      frames: g.length,
      meanMs: round(sum / g.length),
      maxMs: round(max),
      p95Ms: round(percentile(g, 95)),
      over16,
      over100
    };
  }

  // Wall-clock work of an interaction split into N steps (a drag of N
  // pointermoves): per-step mean and worst, plus how many steps exceeded a
  // frame budget of 16 ms — the brief's target for select/drag/undo.
  function stepStats(stepMs) {
    const s = (stepMs || []).filter((x) => typeof x === 'number' && isFinite(x) && x >= 0);
    if (!s.length) return { steps: 0, totalMs: null, meanMs: null, maxMs: null, over16: 0 };
    let sum = 0, max = 0, over16 = 0;
    for (const x of s) { sum += x; if (x > max) max = x; if (x > 16) over16++; }
    return { steps: s.length, totalMs: round(sum), meanMs: round(sum / s.length, 2), maxMs: round(max), over16 };
  }

  // Flatten a probe result into [label, value, unit] rows in the order the
  // baseline document lists them. Missing sections yield "n/a" rows rather
  // than being skipped, so a device that cannot measure something (no heap on
  // Safari) still produces a complete, comparable table.
  function reportRows(r) {
    r = r || {};
    const na = 'n/a';
    const v = (x, d) => (x == null ? na : (typeof x === 'number' ? round(x, d) : x));
    const rows = [];
    const open = r.open || {};
    rows.push(['First page painted, cold open (dense-plans.pdf)', v(open.cold && open.cold.firstPaintMs), 'ms']);
    rows.push(['First page painted, warm open (dense-plans.pdf)', v(open.warm && open.warm.firstPaintMs), 'ms']);
    const pinch = r.pinch || {};
    for (const pct of [200, 400]) {
      const p = pinch[pct] || {};
      rows.push([`Pinch end → current page sharp at ${pct}%`, v(p.currentPageSharpMs), 'ms']);
      rows.push([`Pinch end → all visible pages sharp at ${pct}%`, v(p.visibleSharpMs), 'ms']);
    }
    const pan = r.pan || {};
    const lt = pan.longTasks || {}, fr = pan.frames || {};
    rows.push([`Longest task during ${v(pan.durationMs, 0)} ms pan at ${v(pan.zoomPct, 0)}%`, v(lt.longestMs), 'ms']);
    rows.push(['Long tasks over 100 ms during pan', v(lt.over100, 0), 'count']);
    rows.push(['Longest frame gap during pan', v(fr.maxMs), 'ms']);
    rows.push(['Frames over 16.7 ms during pan', v(fr.over16, 0) + (fr.frames != null ? ` of ${fr.frames}` : ''), 'count']);
    const cv = r.canvas || {};
    rows.push(['Total canvas memory at 400%', v(cv.megabytes), 'MB']);
    rows.push(['Largest single canvas at 400%', v(cv.maxMegapixels, 2), 'MP']);
    rows.push(['Canvases in the DOM at 400%', v(cv.count, 0), 'count']);
    rows.push(['Current page canvas actually painted at 400%',
      cv.currentPagePainted == null ? na : (cv.currentPagePainted ? 'yes' : 'NO (blank)'), 'check']);
    const heap = r.heap || {};
    rows.push(['JS heap used after the dense set', heap.usedMB == null ? na : v(heap.usedMB), 'MB']);
    const mk = r.markup || {};
    rows.push(['Open heavy-markup.pdf (sidecar parse + first paint)', v(mk.openMs), 'ms']);
    rows.push(['App.Markup.repositionAll() with 2,000 markups', v(mk.repositionMs), 'ms']);
    rows.push(['App.Measure.repositionAll() with 300 measurements', v(mk.measureRepositionMs), 'ms']);
    rows.push(['Select one markup', v(mk.selectMs), 'ms']);
    const drag = mk.drag || {};
    rows.push(['Drag, 60 pointermoves: main-thread work per move (mean)', v(drag.meanMs, 2), 'ms']);
    rows.push(['Drag, 60 pointermoves: worst move', v(drag.maxMs), 'ms']);
    rows.push(['Drag, 60 pointermoves: moves over 16 ms', v(drag.over16, 0), 'count']);
    rows.push(['Undo', v(mk.undoMs), 'ms']);
    rows.push(['JS heap used after heavy-markup.pdf', mk.heap && mk.heap.usedMB != null ? v(mk.heap.usedMB) : na, 'MB']);
    return rows;
  }

  // Rows → GitHub-flavoured markdown, ready to paste into a PR description.
  function markdownTable(rows, header) {
    const h = header || ['Metric', 'Value', 'Unit'];
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    const lines = ['| ' + h.map(esc).join(' | ') + ' |', '|' + h.map(() => '---').join('|') + '|'];
    for (const r of rows || []) lines.push('| ' + r.map(esc).join(' | ') + ' |');
    return lines.join('\n');
  }

  return { round, percentile, summarizeTasks, canvasBudget, frameStats, stepStats, reportRows, markdownTable };
});
