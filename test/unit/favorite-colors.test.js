import { describe, it, expect } from 'vitest';
import {
  FAV_LIMIT,
  normalizeHex,
  sanitizeFavorites,
  indexOfHex,
  isFavorite,
  addFavorite,
  removeFavorite,
  renameFavorite,
  moveFavorite,
  parseFavoriteList,
  mergeFavorites
} from '../../src/shared/favorite-colors.js';

describe('normalizeHex', () => {
  it('accepts the shapes a legend gets copied in as', () => {
    expect(normalizeHex('#3B7D23')).toBe('#3b7d23');
    expect(normalizeHex('3B7D23')).toBe('#3b7d23');
    expect(normalizeHex('  #ffc000  ')).toBe('#ffc000');
    expect(normalizeHex('#abc')).toBe('#aabbcc');
  });
  it('keeps the RGB half of an 8-digit code — opacity is its own control', () => {
    expect(normalizeHex('#3B7D2380')).toBe('#3b7d23');
  });
  it('returns null rather than guessing at a non-colour', () => {
    ['', null, undefined, 'green', '#12345', '#1234567', 'ZZZZZZ', 42].forEach((v) => {
      expect(normalizeHex(v)).toBeNull();
    });
  });
});

describe('sanitizeFavorites', () => {
  it('drops junk, dedupes by colour and tolerates bare strings', () => {
    const out = sanitizeFavorites([
      { hex: '#3B7D23', name: 'Guardrail' },
      '#FFC000',
      { hex: 'nope', name: 'Bad' },
      { hex: '#3b7d23', name: 'Duplicate green' },
      null
    ]);
    expect(out).toEqual([
      { hex: '#3b7d23', name: 'Guardrail' },
      { hex: '#ffc000', name: '#FFC000' }
    ]);
  });
  it('falls back to the code as the label and trims long names', () => {
    expect(sanitizeFavorites([{ hex: '#ffff00', name: '   ' }])[0].name).toBe('#FFFF00');
    expect(sanitizeFavorites([{ hex: '#ffff00', name: 'x'.repeat(80) }])[0].name).toHaveLength(40);
  });
  it('survives a non-array (nothing saved yet, or a corrupt pref)', () => {
    expect(sanitizeFavorites(undefined)).toEqual([]);
    expect(sanitizeFavorites('#fff')).toEqual([]);
  });
  it('caps the list', () => {
    const many = Array.from({ length: FAV_LIMIT + 10 }, (_, i) => ({ hex: '#' + String(i).padStart(6, '0') }));
    expect(sanitizeFavorites(many)).toHaveLength(FAV_LIMIT);
  });
});

describe('addFavorite', () => {
  it('adds a named colour', () => {
    const r = addFavorite([], '#3B7D23', 'Guardrail (Green)');
    expect(r.added).toBe(true);
    expect(r.list).toEqual([{ hex: '#3b7d23', name: 'Guardrail (Green)' }]);
  });
  it('renames in place instead of making a second chip of the same colour', () => {
    const first = addFavorite([], '#3B7D23', 'Green').list;
    const r = addFavorite(first, '#3b7d23', 'Guardrail');
    expect(r.added).toBe(false);
    expect(r.reason).toBe('duplicate');
    expect(r.list).toEqual([{ hex: '#3b7d23', name: 'Guardrail' }]);
  });
  it('keeps the existing name when the re-add carries none', () => {
    const first = addFavorite([], '#3B7D23', 'Guardrail').list;
    expect(addFavorite(first, '#3B7D23', '').list[0].name).toBe('Guardrail');
  });
  it('refuses a non-colour and refuses to grow past the cap', () => {
    expect(addFavorite([], 'chartreuse').reason).toBe('invalid');
    const full = Array.from({ length: FAV_LIMIT }, (_, i) => ({ hex: '#' + String(i).padStart(6, '0') }));
    const r = addFavorite(full, '#3b7d23');
    expect(r.reason).toBe('full');
    expect(r.list).toHaveLength(FAV_LIMIT);
  });
});

describe('lookup, remove and rename', () => {
  const list = [{ hex: '#3b7d23', name: 'Guardrail' }, { hex: '#ffc000', name: 'Fence' }];
  it('finds a colour however it is written', () => {
    expect(indexOfHex(list, '#FFC000')).toBe(1);
    expect(indexOfHex(list, 'ffc000')).toBe(1);
    expect(indexOfHex(list, '#000000')).toBe(-1);
    expect(isFavorite(list, '#3B7D23')).toBe(true);
    expect(isFavorite(list, 'not a colour')).toBe(false);
  });
  it('removes and renames by colour', () => {
    expect(removeFavorite(list, '#3B7D23')).toEqual([{ hex: '#ffc000', name: 'Fence' }]);
    expect(renameFavorite(list, '#ffc000', 'Fence (Orange)')[1].name).toBe('Fence (Orange)');
  });
  it('leaves the list alone when the colour is not on it', () => {
    expect(removeFavorite(list, '#123456')).toEqual(list);
    expect(renameFavorite(list, '#123456', 'Nope')).toEqual(list);
  });
});

describe('moveFavorite', () => {
  const list = [{ hex: '#111111', name: 'a' }, { hex: '#222222', name: 'b' }, { hex: '#333333', name: 'c' }];
  it('reorders so the strip can match the legend', () => {
    expect(moveFavorite(list, 2, 0).map((f) => f.name)).toEqual(['c', 'a', 'b']);
    expect(moveFavorite(list, 0, 2).map((f) => f.name)).toEqual(['b', 'c', 'a']);
  });
  it('clamps out-of-range indexes and no-ops on nonsense', () => {
    expect(moveFavorite(list, 0, 99).map((f) => f.name)).toEqual(['b', 'c', 'a']);
    expect(moveFavorite(list, 1, 1)).toEqual(list);
    expect(moveFavorite(list, NaN, 0)).toEqual(list);
    expect(moveFavorite([], 0, 1)).toEqual([]);
  });
});

describe('parseFavoriteList', () => {
  it('reads a legend pasted straight out of the plans', () => {
    const text = [
      'Description\tReference Color',
      'Guardrail (Green) – Hex: #3B7D23',
      'Fence (Orange) - Hex: #FFC000',
      'Guardrail Removal (Purple) - Hex: #7030A0',
      'Temporary Fence (Yellow) - Hex: #FFFF00',
      'Attenuator (Red) - Hex: #EE0000',
      'Handrail (Blue) - Hex: #215F9A',
      'Utilities- Hex: #19CC97'
    ].join('\n');
    expect(parseFavoriteList(text)).toEqual([
      { hex: '#3b7d23', name: 'Guardrail (Green)' },
      { hex: '#ffc000', name: 'Fence (Orange)' },
      { hex: '#7030a0', name: 'Guardrail Removal (Purple)' },
      { hex: '#ffff00', name: 'Temporary Fence (Yellow)' },
      { hex: '#ee0000', name: 'Attenuator (Red)' },
      { hex: '#215f9a', name: 'Handrail (Blue)' },
      { hex: '#19cc97', name: 'Utilities' }
    ]);
  });
  it('takes the code first or last, with whatever punctuation came along', () => {
    expect(parseFavoriteList('#7030A0  Guardrail Removal')).toEqual([{ hex: '#7030a0', name: 'Guardrail Removal' }]);
    expect(parseFavoriteList('FFFF00, Temporary Fence')).toEqual([{ hex: '#ffff00', name: 'Temporary Fence' }]);
    expect(parseFavoriteList('Handrail | #215F9A')).toEqual([{ hex: '#215f9a', name: 'Handrail' }]);
  });
  it('skips lines with no colour instead of failing the paste', () => {
    expect(parseFavoriteList('Plans (Legend)\n\nGuardrail #3B7D23\nnotes only')).toEqual([
      { hex: '#3b7d23', name: 'Guardrail' }
    ]);
    expect(parseFavoriteList('')).toEqual([]);
    expect(parseFavoriteList(null)).toEqual([]);
  });
  it('does not read a six-digit pay item number as a colour', () => {
    expect(parseFavoriteList('Pay item 536001 guardrail')).toEqual([]);
    // ...but a code alongside one is still found, and the item number stays in the name.
    expect(parseFavoriteList('536001 Guardrail #3B7D23')).toEqual([
      { hex: '#3b7d23', name: '536001 Guardrail' }
    ]);
  });
  it('names an unlabelled code after itself', () => {
    expect(parseFavoriteList('#3B7D23')).toEqual([{ hex: '#3b7d23', name: '#3B7D23' }]);
  });
});

describe('mergeFavorites', () => {
  it('reports what a paste actually did', () => {
    const start = [{ hex: '#3b7d23', name: 'Guardrail' }];
    const r = mergeFavorites(start, parseFavoriteList('Fence #FFC000\nGuardrail #3B7D23\nheader row'));
    expect(r.added).toBe(1);
    expect(r.duplicate).toBe(1);
    expect(r.list.map((f) => f.hex)).toEqual(['#3b7d23', '#ffc000']);
  });
  it('counts entries it could not take', () => {
    const full = Array.from({ length: FAV_LIMIT }, (_, i) => ({ hex: '#' + String(i).padStart(6, '0') }));
    const r = mergeFavorites(full, [{ hex: '#3b7d23' }, { hex: 'junk' }]);
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(2);
  });
  it('survives a non-array of entries', () => {
    expect(mergeFavorites([], null).list).toEqual([]);
  });
});
