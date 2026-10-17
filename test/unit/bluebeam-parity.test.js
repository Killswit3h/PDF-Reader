import { describe, it, expect } from 'vitest';
import {
  MARKUP_STATUSES, markupStatusOf, markupStatusFromPdf, markupSubjectOf,
  markupCommentOf, filterMarkups, sortMarkups, markupRows, markupRowsToCsv,
  markupStatusTotals, markupTypeLabel
} from '../../src/shared/markup-meta.js';
import {
  STAMPS, stampById, stampLines, stampSize, safeLinkUrl, parseLinkTarget,
  hitTestMarkup, topMarkupAt, snapToGrid, dashArray
} from '../../src/shared/markup-tools.js';
import { depthResult, fmtDepthResult } from '../../src/shared/measure-math.js';

const P = (vx, vy) => ({ vx, vy });
const mk = (id, type, page, extra) => Object.assign({ id, type, page, pts: [P(0, 0), P(10, 10)], style: { stroke: '#ff0000' } }, extra);

describe('markup status', () => {
  it('reads unknown or missing status as None', () => {
    expect(markupStatusOf({}).label).toBe('None');
    expect(markupStatusOf({ status: 'bogus' }).label).toBe('None');
    expect(markupStatusOf({ status: 'accepted' }).label).toBe('Accepted');
  });
  it('maps PDF review states back to ids', () => {
    expect(markupStatusFromPdf('Accepted')).toBe('accepted');
    expect(markupStatusFromPdf('completed')).toBe('completed');
    expect(markupStatusFromPdf('Marked')).toBe('');
  });
  it('every status except For Review has a PDF state name', () => {
    MARKUP_STATUSES.forEach((s) => {
      if (s.id === 'review') expect(s.pdf).toBeNull();
      else expect(typeof s.pdf).toBe('string');
    });
  });
});

describe('subject and comment', () => {
  it('defaults the subject to the type name', () => {
    expect(markupSubjectOf({ type: 'cloud' })).toBe('Cloud');
    expect(markupSubjectOf({ type: 'cloud', subject: '  Missing post  ' })).toBe('Missing post');
  });
  it('comment prefers the typed comment, then the sheet text, then the link target', () => {
    expect(markupCommentOf({ type: 'text', text: 'hello' })).toBe('hello');
    expect(markupCommentOf({ type: 'text', text: 'hello', comment: 'c' })).toBe('c');
    expect(markupCommentOf({ type: 'link', link: { page: 4 } })).toBe('Page 4');
    expect(markupCommentOf({ type: 'link', link: { url: 'https://a.b/' } })).toBe('https://a.b/');
  });
  it('labels every new tool type', () => {
    ['squiggly', 'note', 'stamp', 'link', 'redact'].forEach((t) => expect(markupTypeLabel(t)).not.toBe(t));
  });
});

describe('filter and sort', () => {
  const list = [
    mk(1, 'cloud', 2, { status: 'rejected', comment: 'gate swing' }),
    mk(2, 'arrow', 1, { status: 'accepted' }),
    mk(3, 'text', 3, { text: 'Post spacing 10 ft' }),
    mk(4, 'cloud', 1, { subject: 'Fence line' })
  ];
  it('filters by status, including "no status"', () => {
    expect(filterMarkups(list, { status: 'accepted' }).map((a) => a.id)).toEqual([2]);
    expect(filterMarkups(list, { status: '' }).map((a) => a.id)).toEqual([3, 4]);
    expect(filterMarkups(list, { status: '*' }).length).toBe(4);
  });
  it('filters by text across type, subject, comment and page', () => {
    expect(filterMarkups(list, { q: 'gate' }).map((a) => a.id)).toEqual([1]);
    expect(filterMarkups(list, { q: 'fence' }).map((a) => a.id)).toEqual([4]);
    expect(filterMarkups(list, { q: 'p3' }).map((a) => a.id)).toEqual([3]);
    expect(filterMarkups(list, { q: 'cloud' }).map((a) => a.id)).toEqual([1, 4]);
  });
  it('sorts by a column with stable document-order ties', () => {
    expect(sortMarkups(list, 'page').map((a) => a.id)).toEqual([2, 4, 1, 3]);
    expect(sortMarkups(list, 'page', 'desc').map((a) => a.id)).toEqual([3, 1, 2, 4]);
    expect(sortMarkups(list, 'type').map((a) => a.id)).toEqual([2, 4, 1, 3]);
    expect(sortMarkups(list, 'status').map((a) => a.id)[0]).toBe(4);
  });
  it('does not mutate the input', () => {
    const before = list.map((a) => a.id);
    sortMarkups(list, 'type', 'desc');
    expect(list.map((a) => a.id)).toEqual(before);
  });
});

describe('exports', () => {
  it('writes a header and one row per markup', () => {
    const rows = markupRows([mk(1, 'cloud', 2, { status: 'completed', locked: true, comment: 'a, "b"' })]);
    expect(rows[0]).toEqual(['#', 'Type', 'Subject', 'Status', 'Page', 'Color', 'Comment', 'Locked', 'Created']);
    expect(rows[1].slice(0, 8)).toEqual([1, 'Cloud', 'Cloud', 'Completed', 2, '#ff0000', 'a, "b"', 'Yes']);
    expect(markupRowsToCsv(rows).split('\r\n')[1]).toContain('"a, ""b"""');
  });
  it('totals markups by status', () => {
    expect(markupStatusTotals([mk(1, 'a', 1, { status: 'accepted' }), mk(2, 'a', 1, { status: 'accepted' }), mk(3, 'a', 1)]))
      .toEqual({ Accepted: 2, None: 1 });
  });
});

describe('stamps', () => {
  it('has unique ids and a PDF name on every stamp', () => {
    const ids = new Set(STAMPS.map((s) => s.id));
    expect(ids.size).toBe(STAMPS.length);
    STAMPS.forEach((s) => expect(s.name).toMatch(/^[A-Za-z]+$/));
  });
  it('adds a date line only to dated stamps', () => {
    const d = new Date(2026, 9, 16);
    expect(stampLines(stampById('approved'), d)).toEqual(['APPROVED', '10/16/2026']);
    expect(stampLines(stampById('void'), d)).toEqual(['VOID']);
    expect(stampLines({ text: '  ', date: false })).toEqual(['STAMP']);
  });
  it('sizes the box to the text', () => {
    const short = stampSize(['VOID'], 18), long = stampSize(['NOT FOR CONSTRUCTION'], 18);
    expect(long.w).toBeGreaterThan(short.w);
    expect(stampSize(['A', 'date'], 18).h).toBeGreaterThan(stampSize(['A'], 18).h);
  });
});

describe('hyperlinks', () => {
  it('allows only http, https and mailto', () => {
    expect(safeLinkUrl('https://guaranteedfence.net/x')).toBe('https://guaranteedfence.net/x');
    expect(safeLinkUrl('www.fdot.gov')).toBe('https://www.fdot.gov/');
    expect(safeLinkUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(safeLinkUrl('file:///etc/passwd')).toBeNull();
    expect(safeLinkUrl('smb://server/share')).toBeNull();
    expect(safeLinkUrl('')).toBeNull();
  });
  it('parses page numbers in range, else URLs', () => {
    expect(parseLinkTarget('12', 20)).toEqual({ page: 12 });
    expect(parseLinkTarget('p 3', 20)).toEqual({ page: 3 });
    expect(parseLinkTarget('Page 7', 20)).toEqual({ page: 7 });
    expect(parseLinkTarget('25', 20)).toBeNull();
    expect(parseLinkTarget('0', 20)).toBeNull();
    expect(parseLinkTarget('https://x.y', 20)).toEqual({ url: 'https://x.y/' });
    expect(parseLinkTarget('vbscript:x', 20)).toBeNull();
  });
});

describe('eraser hit test', () => {
  it('hits an open stroke only near the line', () => {
    const line = mk(1, 'line', 1, { pts: [P(0, 0), P(100, 0)] });
    expect(hitTestMarkup(line, P(50, 4), 6)).toBe(true);
    expect(hitTestMarkup(line, P(50, 20), 6)).toBe(false);
    expect(hitTestMarkup(line, P(120, 0), 6)).toBe(false);
  });
  it('hits an unfilled rectangle on its edge, a filled one anywhere', () => {
    const r = mk(1, 'rect', 1, { pts: [P(0, 0), P(100, 100)] });
    expect(hitTestMarkup(r, P(50, 50), 6)).toBe(false);
    expect(hitTestMarkup(r, P(98, 50), 6)).toBe(true);
    r.style.fill = '#ffff00';
    expect(hitTestMarkup(r, P(50, 50), 6)).toBe(true);
  });
  it('hits ellipses, polygons, notes, and quad markups', () => {
    const e = mk(1, 'ellipse', 1, { pts: [P(0, 0), P(100, 50)] });
    expect(hitTestMarkup(e, P(100, 25), 3)).toBe(true);
    expect(hitTestMarkup(e, P(50, 25), 3)).toBe(false);
    const pg = mk(2, 'polygon', 1, { pts: [P(0, 0), P(100, 0), P(50, 80)] });
    expect(hitTestMarkup(pg, P(50, 1), 3)).toBe(true);
    expect(hitTestMarkup(mk(3, 'note', 1, { pts: [P(10, 10)] }), P(20, 20), 0)).toBe(true);
    expect(hitTestMarkup({ type: 'underline', quads: [{ x: 0, y: 0, w: 50, h: 10 }] }, P(25, 5), 0)).toBe(true);
  });
  it('picks the topmost markup on the right page', () => {
    const a = mk(1, 'rect', 1, { pts: [P(0, 0), P(100, 100)], style: { fill: '#fff' } });
    const b = mk(2, 'rect', 1, { pts: [P(0, 0), P(100, 100)], style: { fill: '#fff' } });
    const c = mk(3, 'rect', 2, { pts: [P(0, 0), P(100, 100)], style: { fill: '#fff' } });
    expect(topMarkupAt([a, b, c], 1, P(50, 50), 2).id).toBe(2);
    expect(topMarkupAt([a, b, c], 3, P(50, 50), 2)).toBeNull();
  });
});

describe('grid and line styles', () => {
  it('snaps to the nearest grid intersection', () => {
    expect(snapToGrid(P(19, 26), 18)).toEqual(P(18, 18));
    expect(snapToGrid(P(28, 28), 18)).toEqual(P(36, 36));
    expect(snapToGrid(P(5, 5), 0)).toEqual(P(5, 5));
  });
  it('scales dash patterns with the line width', () => {
    expect(dashArray('solid', 2)).toBeNull();
    expect(dashArray('dashed', 2)).toEqual([8, 6]);
    expect(dashArray('dotted', 0)).toEqual([1, 2]);
    expect(dashArray('nope', 2)).toBeNull();
  });
});

describe('depth: volume and wall area', () => {
  it('turns an area in feet into cubic feet and cubic yards', () => {
    const r = depthResult('area', 54, 'ft', 0.5);
    expect(r.kind).toBe('volume');
    expect(r.value).toBeCloseTo(27);
    expect(r.cy).toBeCloseTo(1);
    expect(fmtDepthResult(r)).toBe('27.00 ft³ (1.00 yd³)');
  });
  it('turns a fence run into fabric square footage', () => {
    const r = depthResult('length', 250, 'ft', 6);
    expect(r).toEqual({ kind: 'surface', value: 1500, unit: 'ft' });
    expect(fmtDepthResult(r)).toBe('1500.00 ft²');
  });
  it('metric volume has no cubic-yard figure', () => {
    expect(fmtDepthResult(depthResult('area', 10, 'm', 2))).toBe('20.00 m³');
  });
  it('returns null without a depth, scale, or supported type', () => {
    expect(depthResult('area', 10, 'ft', 0)).toBeNull();
    expect(depthResult('area', null, null, 2)).toBeNull();
    expect(depthResult('angle', 10, '°', 2)).toBeNull();
    expect(depthResult('count', 3, 'ct', 2)).toBeNull();
  });
});
