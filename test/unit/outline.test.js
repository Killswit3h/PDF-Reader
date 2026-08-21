import { describe, it, expect } from 'vitest';
import {
  flattenOutline, countOutline, hasOurBookmark, toggleBookmark, ourPages, defaultTitle
} from '../../src/shared/outline.js';

// A nested outline of the kind a drawing set received from someone else carries:
// real titles, real structure, none of it ours.
const foreign = () => [
  {
    title: 'General',
    page: 1,
    mine: false,
    items: [
      { title: 'Cover Sheet', page: 1, mine: false, items: [] },
      { title: 'Index', page: 2, mine: false, items: [] }
    ]
  },
  { title: 'Roadway Plans', page: 5, mine: false, items: [] },
  { title: 'Broken link', page: null, mine: false, items: [] }
];

describe('flattenOutline', () => {
  it('walks the whole tree depth-first, recording nesting', () => {
    const rows = flattenOutline(foreign());
    expect(rows.map((r) => r.title)).toEqual(['General', 'Cover Sheet', 'Index', 'Roadway Plans']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it('skips entries whose destination could not be resolved', () => {
    expect(flattenOutline(foreign()).some((r) => r.title === 'Broken link')).toBe(false);
  });

  it('reports which rows are ours', () => {
    const tree = toggleBookmark(foreign(), 3);
    const rows = flattenOutline(tree);
    expect(rows.filter((r) => r.mine).map((r) => r.page)).toEqual([3]);
  });

  it('is empty, not broken, for a document with no outline', () => {
    expect(flattenOutline([])).toEqual([]);
    expect(flattenOutline(null)).toEqual([]);
    expect(flattenOutline(undefined)).toEqual([]);
  });
});

describe('countOutline', () => {
  it('counts nested entries too', () => {
    expect(countOutline(foreign())).toBe(5);
  });
  it('counts an unresolvable entry, which is still written out', () => {
    expect(countOutline([{ title: 'x', page: null, mine: false, items: [] }])).toBe(1);
  });
});

describe('hasOurBookmark', () => {
  it('is true only for entries this app made', () => {
    const tree = toggleBookmark(foreign(), 3);
    expect(hasOurBookmark(tree, 3)).toBe(true);
    // Page 5 carries a FOREIGN bookmark. It is not ours to toggle, so the
    // button must not claim it.
    expect(hasOurBookmark(tree, 5)).toBe(false);
  });
});

// FR-11 lives here. Saving from this app must not rename, reorder, reparent or
// drop anything that arrived with the file.
describe('toggleBookmark — foreign entries are untouchable', () => {
  it('adds ours without altering the original tree', () => {
    const before = foreign();
    const tree = toggleBookmark(before, 3);
    // Original array not mutated.
    expect(before).toHaveLength(3);
    expect(tree).toHaveLength(4);
    // Every foreign node is carried through by reference, so it cannot differ.
    for (const node of before) expect(tree).toContain(node);
  });

  it('keeps foreign titles, nesting and destinations exactly', () => {
    const tree = toggleBookmark(foreign(), 3);
    const general = tree.find((n) => n.title === 'General');
    expect(general.items.map((i) => i.title)).toEqual(['Cover Sheet', 'Index']);
    expect(general.items.map((i) => i.page)).toEqual([1, 2]);
    expect(tree.find((n) => n.title === 'Roadway Plans').page).toBe(5);
  });

  it('keeps an unresolvable foreign entry rather than dropping it on save', () => {
    const tree = toggleBookmark(foreign(), 3);
    expect(tree.some((n) => n.title === 'Broken link')).toBe(true);
  });

  it('removes only our own entry, leaving a foreign one on the same page', () => {
    let tree = toggleBookmark(foreign(), 5); // page 5 also has a foreign entry
    expect(ourPages(tree)).toEqual([5]);
    tree = toggleBookmark(tree, 5);
    expect(ourPages(tree)).toEqual([]);
    expect(tree.find((n) => n.title === 'Roadway Plans')).toBeTruthy();
  });

  // Saving repeatedly is the normal case, and duplicates would accumulate
  // invisibly until a client opened the file and saw the same page ten times.
  it('does not duplicate across repeated toggles', () => {
    let tree = foreign();
    for (let i = 0; i < 5; i++) {
      tree = toggleBookmark(tree, 3);
      tree = toggleBookmark(tree, 3);
    }
    tree = toggleBookmark(tree, 3);
    expect(ourPages(tree)).toEqual([3]);
    expect(tree.filter((n) => n.mine)).toHaveLength(1);
  });
});

describe('toggleBookmark — ordering and titles', () => {
  it('keeps our entries in page order as they are added out of order', () => {
    let tree = toggleBookmark([], 7);
    tree = toggleBookmark(tree, 2);
    tree = toggleBookmark(tree, 5);
    expect(ourPages(tree)).toEqual([2, 5, 7]);
    expect(tree.map((n) => n.page)).toEqual([2, 5, 7]);
  });

  it('titles an entry by its page number', () => {
    const tree = toggleBookmark([], 12);
    expect(tree[0].title).toBe('Page 12');
    expect(defaultTitle(12)).toBe('Page 12');
  });

  it('accepts an explicit title', () => {
    expect(toggleBookmark([], 4, 'Sheet C-3')[0].title).toBe('Sheet C-3');
  });

  it('ignores a nonsense page rather than storing it', () => {
    expect(toggleBookmark([], 0)).toEqual([]);
    expect(toggleBookmark([], -1)).toEqual([]);
    expect(toggleBookmark([], null)).toEqual([]);
  });

  it('starts a tree from nothing when the document had no outline', () => {
    const tree = toggleBookmark(null, 1);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ page: 1, mine: true, title: 'Page 1' });
  });
});
