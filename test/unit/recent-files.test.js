import { describe, it, expect } from 'vitest';
import { addRecent, removeRecent, pruneRecent, MAX_RECENT } from '../../src/shared/recent-files.js';

const e = (p, n) => ({ path: p, name: n || p.split(/[\\/]/).pop() });

describe('addRecent', () => {
  it('adds an entry to the front of an empty list', () => {
    expect(addRecent([], e('/a/x.pdf'))).toEqual([{ path: '/a/x.pdf', name: 'x.pdf' }]);
  });
  it('promotes an existing path to the front without duplicating it', () => {
    const list = [e('/a/x.pdf'), e('/a/y.pdf')];
    const out = addRecent(list, e('/a/y.pdf'));
    expect(out.map((r) => r.path)).toEqual(['/a/y.pdf', '/a/x.pdf']);
  });
  it('derives a name from the path when none is given', () => {
    expect(addRecent([], { path: 'C:\\docs\\plan.pdf' })[0].name).toBe('plan.pdf');
  });
  it('caps the list at MAX_RECENT', () => {
    let list = [];
    for (let i = 0; i < MAX_RECENT + 5; i++) list = addRecent(list, e(`/a/${i}.pdf`));
    expect(list.length).toBe(MAX_RECENT);
    expect(list[0].path).toBe(`/a/${MAX_RECENT + 4}.pdf`); // newest first
  });
  it('respects a custom cap', () => {
    let list = [];
    for (let i = 0; i < 6; i++) list = addRecent(list, e(`/a/${i}.pdf`), 3);
    expect(list.length).toBe(3);
  });
  it('ignores an entry with no path (web pick)', () => {
    const list = [e('/a/x.pdf')];
    expect(addRecent(list, { path: null, name: 'y.pdf' })).toEqual(list);
  });
});

describe('removeRecent', () => {
  it('drops the matching path', () => {
    const list = [e('/a/x.pdf'), e('/a/y.pdf')];
    expect(removeRecent(list, '/a/x.pdf')).toEqual([{ path: '/a/y.pdf', name: 'y.pdf' }]);
  });
  it('is a no-op when the path is absent', () => {
    const list = [e('/a/x.pdf')];
    expect(removeRecent(list, '/a/z.pdf')).toEqual(list);
  });
});

describe('pruneRecent', () => {
  it('keeps only entries whose path still exists', () => {
    const list = [e('/a/x.pdf'), e('/a/gone.pdf'), e('/a/y.pdf')];
    const exists = (p) => p !== '/a/gone.pdf';
    expect(pruneRecent(list, exists).map((r) => r.path)).toEqual(['/a/x.pdf', '/a/y.pdf']);
  });
  it('keeps everything when no existence check is given', () => {
    const list = [e('/a/x.pdf')];
    expect(pruneRecent(list)).toEqual(list);
  });
});
