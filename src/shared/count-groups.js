'use strict';

/*
 * Count tallies — the model behind the Count tool.
 *
 * A take-off counts the same item over a whole plan set: 38 pull boxes spread
 * across six sheets, not 6 unrelated piles. Two things follow from that, and
 * both are why this module exists:
 *
 *   1. A tally spans pages. The running total belongs to the tally, not to the
 *      sheet the dot happens to sit on.
 *   2. Every dot is its own object. Miscount one and you want to move, delete
 *      or duplicate THAT dot — not redraw the pile. (Copy/paste of a single
 *      mark is how you add "one more of these" without hunting for the item.)
 *
 * So a count mark is one measurement carrying one point, tagged with the group
 * it belongs to:
 *
 *   { id, page, type: 'count', pts: [{vx, vy}], group: 'c12', groupName: 'Count 1' }
 *
 * The group is what makes a pile of marks a tally; the per-mark object is what
 * makes each one editable on its own. Everything that needs to know "which
 * number is this dot" or "what does this tally total" derives it from the mark
 * list here rather than storing it, so an undo, a delete or a paste can never
 * leave a stale count behind.
 *
 * Legacy shape: before this, one measurement held EVERY dot of a tally in its
 * pts array, locked to a single page. Those still load and still render — an
 * ungrouped count is treated as a tally of its own, its pts numbered 1..n —
 * and splitCountMarks() upgrades them to individual marks on open.
 *
 * Pure and dual-exported so the tally arithmetic is unit-tested in Node:
 *   Node    → require() returns the named functions
 *   browser → the same names land on App
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  const COUNT_NAME_MAX = 40;

  function isCountMark(m) { return !!m && m.type === 'count'; }
  function dots(m) { return (m && Array.isArray(m.pts) ? m.pts.length : 0); }

  // The key a mark tallies under. A grouped mark counts with its group; an
  // ungrouped (legacy) one is a tally of its own, so old files keep reading the
  // way they were drawn instead of collapsing into one giant pile.
  function countGroupKey(m) {
    if (!isCountMark(m)) return null;
    return m.group ? 'g:' + m.group : 'm:' + m.id;
  }

  function cleanCountName(name, fallback) {
    const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, COUNT_NAME_MAX);
    return s || String(fallback || 'Count');
  }

  // Group id for a tally that has no marks yet. Derived from the measurement
  // sequence, which only ever climbs (rehydrate takes the max, undo does not
  // roll it back), so a re-used id cannot merge two tallies.
  function countGroupId(measureSeq) { return 'c' + (Number(measureSeq) || 0); }

  // Every tally in the document, in the order its first mark was made.
  //   { key, group, name, color, total, pages: [1, 4], perPage: { 1: 3, 4: 2 }, marks: [...] }
  // `total` counts DOTS, not measurement objects, so a legacy multi-point count
  // reports the number the user drew.
  function countGroups(measurements) {
    const byKey = Object.create(null);
    const order = [];
    (Array.isArray(measurements) ? measurements : []).forEach((m) => {
      if (!isCountMark(m)) return;
      const key = countGroupKey(m);
      let g = byKey[key];
      if (!g) {
        g = byKey[key] = {
          key,
          group: m.group || null,
          name: cleanCountName(m.groupName, 'Count'),
          color: m.color || null,
          total: 0,
          pages: [],
          perPage: Object.create(null),
          marks: []
        };
        order.push(g);
      }
      const n = dots(m);
      g.total += n;
      g.perPage[m.page] = (g.perPage[m.page] || 0) + n;
      if (g.pages.indexOf(m.page) < 0) g.pages.push(m.page);
      g.marks.push(m);
    });
    order.forEach((g) => g.pages.sort((a, b) => a - b));
    return order;
  }

  // Map of measurement id → the number the mark's FIRST dot carries within its
  // tally. A single-point mark is that number outright; a legacy multi-point one
  // numbers its dots from there. Built in one pass so a render can label a
  // hundred marks without re-walking the list for each.
  function countOrdinals(measurements) {
    const out = Object.create(null);
    const seen = Object.create(null);
    (Array.isArray(measurements) ? measurements : []).forEach((m) => {
      if (!isCountMark(m)) return;
      const key = countGroupKey(m);
      const at = (seen[key] || 0) + 1;
      out[m.id] = at;
      seen[key] = at + dots(m) - 1;
    });
    return out;
  }

  // The first mark of each tally ON each page — the one that carries the tally's
  // label, so a sheet with 20 dots shows one running total rather than 20.
  // Keyed `${groupKey}|${page}` → measurement id.
  function countLabelAnchors(measurements) {
    const out = Object.create(null);
    (Array.isArray(measurements) ? measurements : []).forEach((m) => {
      if (!isCountMark(m)) return;
      const k = countGroupKey(m) + '|' + m.page;
      if (!(k in out)) out[k] = m.id;
    });
    return out;
  }

  // What a tally writes on the sheet. A tally confined to one page reports its
  // total; one spread over several says how much of the total this page holds,
  // because "12" on a sheet carrying 5 of them is a lie a take-off cannot afford.
  function countGroupLabel(group, page) {
    if (!group) return '';
    const here = group.perPage[page] || 0;
    return group.pages.length > 1
      ? `${group.name}: ${here} of ${group.total}`
      : `${group.name}: ${group.total}`;
  }

  // First unused "Count N" — the default name a new tally opens with. Named at
  // all (rather than "count #3") because a take-off has several running at once
  // and they are told apart by what they count.
  function nextCountGroupName(measurements) {
    const used = Object.create(null);
    countGroups(measurements).forEach((g) => { used[g.name.toLowerCase()] = true; });
    for (let i = 1; ; i++) {
      const name = 'Count ' + i;
      if (!used[name.toLowerCase()]) return name;
    }
  }

  function renameCountGroup(measurements, key, name) {
    const clean = cleanCountName(name, 'Count');
    (Array.isArray(measurements) ? measurements : []).forEach((m) => {
      if (isCountMark(m) && countGroupKey(m) === key) m.groupName = clean;
    });
    return clean;
  }

  // Upgrade legacy multi-point counts into one mark per dot, all sharing a new
  // group so the tally they were drawn as survives the split. Mutates nothing:
  // returns the new list plus the sequence counter it consumed.
  function splitCountMarks(measurements, measureSeq) {
    const list = Array.isArray(measurements) ? measurements : [];
    let seq = Number(measureSeq) || 0;
    let changed = false;
    const out = [];
    list.forEach((m) => {
      if (!isCountMark(m) || dots(m) <= 1) { out.push(m); return; }
      changed = true;
      const group = m.group || countGroupId(m.id);
      const name = cleanCountName(m.groupName, 'Count');
      m.pts.forEach((pt, i) => {
        out.push(Object.assign({}, m, {
          // The first dot keeps the original id so a saved selection, or an
          // annotation already written against it, still points at something.
          id: i === 0 ? m.id : ++seq,
          pts: [{ vx: pt.vx, vy: pt.vy }],
          value: 1,
          label: '1',
          group,
          groupName: name
        }));
      });
    });
    return { measurements: changed ? out : list, measureSeq: seq, changed };
  }

  // Collapse a tally's marks back into one shape per page for export. The PDF
  // gets what it got before this feature existed — a single count annotation per
  // tally per page, dots and running total — while the app keeps its individual,
  // editable marks. Non-count measurements pass through untouched, in order.
  function mergeCountsForExport(measurements) {
    const list = Array.isArray(measurements) ? measurements : [];
    const groups = countGroups(list);
    const byKey = Object.create(null);
    groups.forEach((g) => { byKey[g.key] = g; });
    const emitted = Object.create(null);
    const out = [];
    list.forEach((m) => {
      if (!isCountMark(m)) { out.push(m); return; }
      const key = countGroupKey(m);
      const seat = key + '|' + m.page;
      if (emitted[seat]) return;          // already folded into the page's shape
      emitted[seat] = true;
      const g = byKey[key];
      const pts = [];
      g.marks.forEach((mm) => { if (mm.page === m.page) pts.push.apply(pts, mm.pts); });
      out.push(Object.assign({}, m, {
        pts,
        value: pts.length,
        // An ungrouped legacy count keeps the bare number it always exported;
        // only a real tally carries its name onto the sheet.
        label: m.group ? countGroupLabel(g, m.page) : m.label
      }));
    });
    return out;
  }

  return {
    COUNT_NAME_MAX,
    isCountMark,
    countGroupKey,
    cleanCountName,
    countGroupId,
    countGroups,
    countOrdinals,
    countLabelAnchors,
    countGroupLabel,
    nextCountGroupName,
    renameCountGroup,
    splitCountMarks,
    mergeCountsForExport
  };
});
