import { describe, it, expect } from 'vitest';
import {
  countGroupKey,
  countGroupId,
  countGroups,
  countOrdinals,
  countLabelAnchors,
  countGroupLabel,
  nextCountGroupName,
  renameCountGroup,
  splitCountMarks,
  mergeCountsForExport
} from '../../src/shared/count-groups.js';

// A tally as the app now stores it: one measurement per dot, tagged with the
// group it counts under.
function mark(id, page, group, name, vx = 10, vy = 10) {
  return { id, page, type: 'count', pts: [{ vx, vy }], value: 1, group, groupName: name };
}
// The pre-feature shape: every dot of a tally inside one measurement.
function legacy(id, page, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ vx: 10 * i, vy: 20 });
  return { id, page, type: 'count', pts, value: n, label: String(n) };
}
const line = (id, page) => ({ id, page, type: 'length', pts: [{ vx: 0, vy: 0 }, { vx: 10, vy: 0 }], value: 10, unit: 'ft', label: '10.00 ft' });

describe('countGroups', () => {
  it('totals a tally across every page it reaches', () => {
    const ms = [
      mark(1, 1, 'c1', 'Pull boxes'),
      mark(2, 1, 'c1', 'Pull boxes'),
      mark(3, 4, 'c1', 'Pull boxes'),
      line(4, 2)
    ];
    const [g] = countGroups(ms);
    expect(countGroups(ms)).toHaveLength(1);
    expect(g.name).toBe('Pull boxes');
    expect(g.total).toBe(3);
    expect(g.pages).toEqual([1, 4]);
    expect(g.perPage[1]).toBe(2);
    expect(g.perPage[4]).toBe(1);
  });

  it('keeps two tallies apart even when they share a page', () => {
    const ms = [mark(1, 1, 'c1', 'Signs'), mark(2, 1, 'c2', 'Poles'), mark(3, 1, 'c1', 'Signs')];
    const gs = countGroups(ms);
    expect(gs.map((g) => [g.name, g.total])).toEqual([['Signs', 2], ['Poles', 1]]);
  });

  it('treats a legacy lump count as a tally of its own, counting its dots', () => {
    const ms = [legacy(7, 2, 4)];
    const [g] = countGroups(ms);
    expect(g.key).toBe('m:7');
    expect(g.total).toBe(4);
    expect(g.pages).toEqual([2]);
  });
});

describe('countGroupKey', () => {
  it('keys grouped marks by their group and ungrouped ones by themselves', () => {
    expect(countGroupKey(mark(1, 1, 'c9', 'x'))).toBe('g:c9');
    expect(countGroupKey(legacy(5, 1, 2))).toBe('m:5');
    expect(countGroupKey(line(2, 1))).toBe(null);
  });
});

describe('countOrdinals', () => {
  it('numbers the marks of a tally in the order they were made, across pages', () => {
    const ms = [mark(1, 1, 'c1', 'A'), mark(2, 3, 'c1', 'A'), mark(3, 1, 'c1', 'A')];
    expect(countOrdinals(ms)).toEqual({ 1: 1, 2: 2, 3: 3 });
  });

  it('restarts numbering per tally', () => {
    const ms = [mark(1, 1, 'c1', 'A'), mark(2, 1, 'c2', 'B'), mark(3, 1, 'c2', 'B')];
    expect(countOrdinals(ms)).toEqual({ 1: 1, 2: 1, 3: 2 });
  });

  it('a legacy lump consumes a number for every dot it carries', () => {
    // Its own dots read 1..3, so a mark added to that tally afterwards is #4.
    const lump = legacy(1, 1, 3);
    lump.group = 'c1';
    const ms = [lump, mark(2, 2, 'c1', 'A')];
    expect(countOrdinals(ms)).toEqual({ 1: 1, 2: 4 });
  });
});

describe('countLabelAnchors', () => {
  it('picks the first mark of a tally on each page — one running total per sheet', () => {
    const ms = [mark(1, 1, 'c1', 'A'), mark(2, 1, 'c1', 'A'), mark(3, 5, 'c1', 'A')];
    expect(countLabelAnchors(ms)).toEqual({ 'g:c1|1': 1, 'g:c1|5': 3 });
  });
});

describe('countGroupLabel', () => {
  it('reports the plain total when the tally lives on one page', () => {
    const [g] = countGroups([mark(1, 2, 'c1', 'Signs'), mark(2, 2, 'c1', 'Signs')]);
    expect(countGroupLabel(g, 2)).toBe('Signs: 2');
  });

  it('says how much of the total THIS page holds once it spans pages', () => {
    const [g] = countGroups([mark(1, 1, 'c1', 'Signs'), mark(2, 3, 'c1', 'Signs'), mark(3, 3, 'c1', 'Signs')]);
    expect(countGroupLabel(g, 1)).toBe('Signs: 1 of 3');
    expect(countGroupLabel(g, 3)).toBe('Signs: 2 of 3');
  });
});

describe('nextCountGroupName', () => {
  it('starts at Count 1 and skips the names already in use', () => {
    expect(nextCountGroupName([])).toBe('Count 1');
    expect(nextCountGroupName([mark(1, 1, 'c1', 'Count 1')])).toBe('Count 2');
    expect(nextCountGroupName([mark(1, 1, 'c1', 'Count 1'), mark(2, 1, 'c2', 'Count 2')])).toBe('Count 3');
  });
  it('leaves a gap alone if the user renamed one', () => {
    expect(nextCountGroupName([mark(1, 1, 'c1', 'Pull boxes'), mark(2, 1, 'c2', 'Count 2')])).toBe('Count 1');
  });
});

describe('renameCountGroup', () => {
  it('renames every mark of the tally at once', () => {
    const ms = [mark(1, 1, 'c1', 'Count 1'), mark(2, 4, 'c1', 'Count 1'), mark(3, 1, 'c2', 'Count 2')];
    expect(renameCountGroup(ms, 'g:c1', '  Pull   boxes ')).toBe('Pull boxes');
    expect(ms.map((m) => m.groupName)).toEqual(['Pull boxes', 'Pull boxes', 'Count 2']);
  });
  it('falls back to a usable name rather than an empty one', () => {
    const ms = [mark(1, 1, 'c1', 'Count 1')];
    expect(renameCountGroup(ms, 'g:c1', '   ')).toBe('Count');
  });
});

describe('splitCountMarks', () => {
  it('turns a legacy lump into one mark per dot, all in one tally', () => {
    const ms = [legacy(3, 2, 3), line(9, 1)];
    const r = splitCountMarks(ms, 9);
    expect(r.changed).toBe(true);
    const counts = r.measurements.filter((m) => m.type === 'count');
    expect(counts).toHaveLength(3);
    expect(counts.every((m) => m.pts.length === 1)).toBe(true);
    expect(new Set(counts.map((m) => m.group)).size).toBe(1);
    // The first dot keeps the original id; the rest come off the sequence.
    expect(counts.map((m) => m.id)).toEqual([3, 10, 11]);
    expect(r.measureSeq).toBe(11);
    // Non-count measurements pass through untouched, in place.
    expect(r.measurements[3]).toBe(ms[1]);
  });

  it('leaves an already-split tally exactly as it was', () => {
    const ms = [mark(1, 1, 'c1', 'A'), mark(2, 2, 'c1', 'A')];
    const r = splitCountMarks(ms, 2);
    expect(r.changed).toBe(false);
    expect(r.measurements).toBe(ms);
    expect(r.measureSeq).toBe(2);
  });

  it('keeps the dots where they were drawn', () => {
    const r = splitCountMarks([legacy(1, 1, 2)], 1);
    expect(r.measurements.map((m) => m.pts[0])).toEqual([{ vx: 0, vy: 20 }, { vx: 10, vy: 20 }]);
  });
});

describe('mergeCountsForExport', () => {
  it('folds a tally back to one shape per page, carrying its running total', () => {
    const ms = [
      mark(1, 1, 'c1', 'Signs', 10, 10),
      line(2, 1),
      mark(3, 1, 'c1', 'Signs', 30, 10),
      mark(4, 3, 'c1', 'Signs', 50, 10)
    ];
    const out = mergeCountsForExport(ms);
    expect(out).toHaveLength(3);
    const [p1, ln, p3] = out;
    expect(p1.page).toBe(1);
    expect(p1.pts).toEqual([{ vx: 10, vy: 10 }, { vx: 30, vy: 10 }]);
    expect(p1.value).toBe(2);
    expect(p1.label).toBe('Signs: 2 of 3');
    expect(ln).toBe(ms[1]);           // untouched, in order
    expect(p3.pts).toHaveLength(1);
    expect(p3.label).toBe('Signs: 1 of 3');
  });

  it('does not mutate the marks it merges', () => {
    const ms = [mark(1, 1, 'c1', 'Signs'), mark(2, 1, 'c1', 'Signs')];
    mergeCountsForExport(ms);
    expect(ms[0].pts).toHaveLength(1);
    expect(ms[0].label).toBeUndefined();
  });

  it('leaves a legacy lump count exporting exactly as it always did', () => {
    const ms = [legacy(1, 1, 3)];
    const out = mergeCountsForExport(ms);
    expect(out).toHaveLength(1);
    expect(out[0].pts).toHaveLength(3);
    expect(out[0].label).toBe('3');
  });
});

describe('countGroupId', () => {
  it('derives a collision-free id from the measurement sequence', () => {
    expect(countGroupId(12)).toBe('c12');
    expect(countGroupId(0)).toBe('c0');
  });
});
