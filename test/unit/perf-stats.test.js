import { describe, it, expect } from 'vitest';
import {
  percentile, summarizeTasks, canvasBudget, frameStats, stepStats, reportRows, markdownTable
} from '../../src/shared/perf-stats.js';

describe('percentile', () => {
  it('is null on empty input and nearest-rank otherwise', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([10, 1, 3], 0)).toBe(1); // rank floors at 1
  });
  it('ignores non-numeric entries', () => {
    expect(percentile([3, null, 'x', 1, NaN], 100)).toBe(3);
  });
});

describe('summarizeTasks', () => {
  it('counts, sums, and flags the brief\'s 100 ms threshold', () => {
    const s = summarizeTasks([{ duration: 60 }, { duration: 120.44 }, { duration: 101 }, {}]);
    expect(s.count).toBe(4);
    expect(s.longestMs).toBe(120.4);
    expect(s.totalMs).toBe(281.4);
    expect(s.over100).toBe(2);
    expect(s.p95Ms).toBe(120.4);
  });
  it('handles an empty observer', () => {
    expect(summarizeTasks([])).toEqual({ count: 0, longestMs: 0, totalMs: 0, p95Ms: null, over100: 0 });
    expect(summarizeTasks(null).count).toBe(0);
  });
});

describe('canvasBudget', () => {
  it('sums RGBA bytes and finds the largest canvas', () => {
    const b = canvasBudget([{ width: 1000, height: 1000 }, { width: 4096, height: 4096 }, { width: 0, height: 50 }]);
    expect(b.count).toBe(2);
    expect(b.bytes).toBe(1000 * 1000 * 4 + 4096 * 4096 * 4);
    expect(b.maxPixels).toBe(4096 * 4096);
    expect(b.maxBytes).toBe(4096 * 4096 * 4);
    expect(b.megabytes).toBe(Math.round((b.bytes / 1048576) * 10) / 10);
    expect(b.maxMegapixels).toBe(16.78);
    // 4096² = 16,777,216 is exactly 2^24 — at the cap, not over it.
    expect(b.overWebViewCap).toBe(false);
  });
  it('flags a canvas past the 2^24 WebView cap', () => {
    expect(canvasBudget([{ width: 4097, height: 4096 }]).overWebViewCap).toBe(true);
    expect(canvasBudget([]).overWebViewCap).toBe(false);
    expect(canvasBudget([]).bytes).toBe(0);
  });
});

describe('frameStats', () => {
  it('reports mean, worst, p95 and the over-budget counts', () => {
    const f = frameStats([16, 16.7, 17, 33, 120, -1, NaN]);
    expect(f.frames).toBe(5);
    expect(f.meanMs).toBe(40.5);
    expect(f.maxMs).toBe(120);
    expect(f.over16).toBe(3);
    expect(f.over100).toBe(1);
    expect(f.p95Ms).toBe(120);
  });
  it('is all-null on no frames', () => {
    expect(frameStats([])).toEqual({ frames: 0, meanMs: null, maxMs: null, p95Ms: null, over16: 0, over100: 0 });
  });
});

describe('stepStats', () => {
  it('measures a drag as per-step work', () => {
    const s = stepStats([2, 4, 30, 16]);
    expect(s.steps).toBe(4);
    expect(s.totalMs).toBe(52);
    expect(s.meanMs).toBe(13);
    expect(s.maxMs).toBe(30);
    expect(s.over16).toBe(1); // 16 exactly is within budget
  });
  it('is empty-safe', () => {
    expect(stepStats(undefined).steps).toBe(0);
    expect(stepStats([]).totalMs).toBeNull();
  });
});

describe('reportRows + markdownTable', () => {
  const sample = {
    open: { cold: { firstPaintMs: 1234.56 }, warm: { firstPaintMs: 456.78 } },
    pinch: { 200: { currentPageSharpMs: 250.2, visibleSharpMs: 300.9 }, 400: { currentPageSharpMs: 700, visibleSharpMs: 800 } },
    pan: { durationMs: 3000, zoomPct: 200, longTasks: { longestMs: 140, over100: 2 }, frames: { maxMs: 150, over16: 12, frames: 180 } },
    canvas: { megabytes: 210.4, maxMegapixels: 33.55, count: 4, currentPagePainted: false },
    heap: { usedMB: 88.2 },
    markup: {
      openMs: 900, repositionMs: 80, measureRepositionMs: 20, selectMs: 95,
      drag: { meanMs: 22.33, maxMs: 41, over16: 55 }, undoMs: 130, heap: { usedMB: 120 }
    }
  };
  it('lists every metric in a fixed order with units', () => {
    const rows = reportRows(sample);
    expect(rows.length).toBe(24);
    expect(rows[0]).toEqual(['First page painted, cold open (dense-plans.pdf)', 1234.6, 'ms']);
    expect(rows[1][1]).toBe(456.8);
    expect(rows.find((r) => /Longest task during 3000 ms pan at 200%/.test(r[0]))[1]).toBe(140);
    expect(rows.find((r) => /Frames over 16.7/.test(r[0]))[1]).toBe('12 of 180');
    expect(rows.find((r) => /Drag.*mean/.test(r[0]))[1]).toBe(22.33);
    expect(rows.find((r) => /actually painted/.test(r[0]))[1]).toBe('NO (blank)');
    expect(rows[rows.length - 1]).toEqual(['JS heap used after heavy-markup.pdf', 120, 'MB']);
  });
  it('fills missing sections with n/a instead of dropping rows (Safari has no heap)', () => {
    const rows = reportRows({ open: { cold: { firstPaintMs: 10 } } });
    expect(rows.length).toBe(24);
    expect(rows[1][1]).toBe('n/a');
    expect(rows.find((r) => /JS heap used after the dense set/.test(r[0]))[1]).toBe('n/a');
    expect(rows.find((r) => /actually painted/.test(r[0]))[1]).toBe('n/a');
    expect(reportRows(null).length).toBe(24);
  });
  it('renders a GitHub markdown table and escapes pipes', () => {
    const md = markdownTable([['a|b', 1, 'ms']]);
    expect(md.split('\n')).toEqual(['| Metric | Value | Unit |', '|---|---|---|', '| a\\|b | 1 | ms |']);
  });
});
