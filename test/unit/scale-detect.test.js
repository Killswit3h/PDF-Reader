import { describe, it, expect } from 'vitest';
import { ScaleDetect } from '../../src/shared/scale-detect.js';
import { UNITS } from '../../src/shared/measure-math.js';

const {
  normalizeUnit, plausibleFactor, factorFromRatio, measureToScale,
  parseScaleNotes, classify, halfSizePages, safeLabel, lenToNumber
} = ScaleDetect;

// Measuring a line `pts` points long under `scale` gives this many real units.
// The whole feature exists to make this number right, so most assertions below
// are phrased as "a 72-point line reads N units" rather than as raw factors.
const reads = (pts, scale) => pts * scale.factor;

// The single candidate a page's text yields, or null.
const only = (text) => parseScaleNotes(text).candidates[0] || null;

/* -------------------------------------------------------------------- units */

describe('normalizeUnit — FR-10, FR-11', () => {
  it('maps the spellings a PDF actually uses', () => {
    expect(normalizeUnit('ft')).toBe('ft');
    expect(normalizeUnit('FT')).toBe('ft');
    expect(normalizeUnit('Feet')).toBe('ft');
    expect(normalizeUnit("'")).toBe('ft');
    expect(normalizeUnit('FT.')).toBe('ft');
    expect(normalizeUnit('in')).toBe('in');
    expect(normalizeUnit('"')).toBe('in');
    expect(normalizeUnit('metres')).toBe('m');
    expect(normalizeUnit('MM')).toBe('mm');
  });

  it('rejects an unknown unit instead of guessing — FR-11', () => {
    expect(normalizeUnit('furlongs')).toBeNull();
    expect(normalizeUnit('')).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(42)).toBeNull();
  });

  it('cannot be walked onto Object.prototype — NFR-9', () => {
    expect(normalizeUnit('__proto__')).toBeNull();
    expect(normalizeUnit('constructor')).toBeNull();
    expect(normalizeUnit('hasOwnProperty')).toBeNull();
    expect(normalizeUnit('toString')).toBeNull();
  });

  it('only ever returns a real key of UNITS', () => {
    for (const alias of Object.keys(ScaleDetect.UNIT_ALIASES)) {
      const u = normalizeUnit(alias);
      expect(Object.prototype.hasOwnProperty.call(UNITS, u)).toBe(true);
    }
  });
});

/* --------------------------------------------------------------- arithmetic */

describe('plausibleFactor — spec §5 bounds', () => {
  it('accepts real drawing scales', () => {
    expect(plausibleFactor(1 / 18)).toBe(true);   // 1/4" = 1'-0"
    expect(plausibleFactor(0.2777)).toBe(true);   // 1" = 20'
  });

  it('rejects everything that is not a usable positive number', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, 1e-9, 1e9, '0.5', null, undefined]) {
      expect(plausibleFactor(bad)).toBe(false);
    }
  });
});

describe('factorFromRatio — FR-19', () => {
  it('reproduces measure.js applyScale exactly', () => {
    // measure.js: factor = realVal / (drawnVal * UNITS[drawnUnit].perPoint)
    const f = factorFromRatio(0.25, 'in', 1, 'ft');
    expect(f).toBeCloseTo(1 / (0.25 * UNITS.in.perPoint), 12);
  });

  it('refuses zero, negative and non-finite input', () => {
    expect(factorFromRatio(0, 'in', 1, 'ft')).toBeNull();
    expect(factorFromRatio(1, 'in', 0, 'ft')).toBeNull();
    expect(factorFromRatio(-1, 'in', 1, 'ft')).toBeNull();
    expect(factorFromRatio(NaN, 'in', 1, 'ft')).toBeNull();
    expect(factorFromRatio(1, 'furlong', 1, 'ft')).toBeNull();
  });
});

/* ---------------------------------------------------- tier A: /Measure dicts */

describe('measureToScale — FR-8, FR-11 (AC-3, AC-5)', () => {
  it('AC-3: /C 0.0833333 /U (ft) makes a 120-point line read 10 ft', () => {
    const r = measureToScale({ subtype: 'RL', X: [{ U: 'ft', C: 0.0833333 }] });
    expect(r.ok).toBe(true);
    expect(r.unit).toBe('ft');
    expect(reads(120, r)).toBeCloseTo(10, 4);
  });

  it('AC-5: an unreadable unit is rejected and says why', () => {
    const r = measureToScale({ subtype: 'RL', X: [{ U: 'furlongs', C: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreadable unit: furlongs');
  });

  it('prefers the exporter /R label when there is one', () => {
    const r = measureToScale({ subtype: 'RL', R: '1 in = 20 ft', X: [{ U: 'ft', C: 20 / 72 }] });
    expect(r.ratioLabel).toBe('1 in = 20 ft');
  });

  it('synthesises a label when /R is absent', () => {
    const r = measureToScale({ subtype: 'RL', X: [{ U: 'ft', C: 20 / 72 }] });
    expect(r.ratioLabel).toBe('1in = 20ft');
  });

  it('rejects a non-rectilinear or malformed dictionary', () => {
    expect(measureToScale({ subtype: 'GEO', X: [{ U: 'ft', C: 1 }] }).ok).toBe(false);
    expect(measureToScale({ subtype: 'RL' }).ok).toBe(false);
    expect(measureToScale({ subtype: 'RL', X: [] }).ok).toBe(false);
    expect(measureToScale({ subtype: 'RL', X: [{ U: 'ft', C: 0 }] }).ok).toBe(false);
    expect(measureToScale({ subtype: 'RL', X: [{ U: 'ft', C: -3 }] }).ok).toBe(false);
    expect(measureToScale({ subtype: 'RL', X: [{ U: 'ft', C: NaN }] }).ok).toBe(false);
    expect(measureToScale(null).ok).toBe(false);
  });
});

/* --------------------------------------------------------- tier B: parsing */

describe('lenToNumber', () => {
  it('reads fractions, mixed numbers and decimals', () => {
    expect(lenToNumber('3/16')).toBeCloseTo(0.1875, 12);
    expect(lenToNumber('1 1/2')).toBeCloseTo(1.5, 12);
    expect(lenToNumber('0.25')).toBeCloseTo(0.25, 12);
  });

  it('accepts zero, because 1\'-0" is how notes are written', () => {
    expect(lenToNumber('0')).toBe(0);
  });

  it('rejects a zero denominator and non-numbers', () => {
    expect(lenToNumber('1/0')).toBeNull();
    expect(lenToNumber('abc')).toBeNull();
    expect(lenToNumber(null)).toBeNull();
  });
});

describe('parseScaleNotes — architectural, FR-16 (AC-6)', () => {
  it('AC-6: SCALE: 1/4" = 1\'-0" makes a 72-point line read 4 ft', () => {
    const c = only('SCALE: 1/4" = 1\'-0"');
    expect(c.unit).toBe('ft');
    expect(c.keyworded).toBe(true);
    expect(reads(72, c)).toBeCloseTo(4, 9);
  });

  it('handles the common architectural family', () => {
    // 1 inch of drawing equals this many feet at each scale.
    const perInch = {
      'SCALE: 1/8" = 1\'-0"': 8,
      'SCALE: 1/4" = 1\'-0"': 4,
      'SCALE: 3/16" = 1\'-0"': 64 / 12,
      'SCALE: 1/2" = 1\'-0"': 2,
      'SCALE: 1 1/2" = 1\'-0"': 8 / 12,
      'SCALE: 3" = 1\'-0"': 4 / 12
    };
    for (const [text, feet] of Object.entries(perInch)) {
      expect(reads(72, only(text)), text).toBeCloseTo(feet, 9);
    }
  });

  it('tolerates spacing, missing hyphen and word units', () => {
    for (const text of ['SCALE:1/4"=1\'-0"', 'SCALE: 1/4" = 1\'0"', 'SCALE: 1/4 IN = 1 FT']) {
      expect(reads(72, only(text)), text).toBeCloseTo(4, 9);
    }
  });

  it('carries the inches remainder into the real length', () => {
    // 1" = 1'-6"  ->  1 inch of drawing is 1.5 ft
    expect(reads(72, only('SCALE: 1" = 1\'-6"'))).toBeCloseTo(1.5, 9);
  });
});

describe('parseScaleNotes — engineering, FR-17', () => {
  it('reads 1" = 20\' and 1" = 100\'', () => {
    expect(reads(72, only('SCALE: 1" = 20\''))).toBeCloseTo(20, 9);
    expect(reads(72, only('SCALE: 1" = 100\''))).toBeCloseTo(100, 9);
  });
});

describe('parseScaleNotes — pure ratios, FR-18, FR-20 (AC-7, AC-8)', () => {
  it('AC-7: 1:100 makes a 72-point line read 2.54 m', () => {
    const c = only('SCALE 1:100');
    expect(c.unit).toBe('m');
    expect(reads(72, c)).toBeCloseTo(2.54, 9);
  });

  it('AC-8: a 1:5 detail scale is expressed in mm', () => {
    expect(only('SCALE 1:5').unit).toBe('mm');
    expect(only('SCALE 1:10').unit).toBe('mm');
    expect(only('SCALE 1:20').unit).toBe('m');
  });

  it('1:5 and 1:100 describe the same physical ratio despite different units', () => {
    // 72 points of drawing is 1 inch; at 1:5 that is 5 inches = 127 mm.
    expect(reads(72, only('SCALE 1:5'))).toBeCloseTo(127, 6);
  });
});

describe('parseScaleNotes — no-scale markers, FR-21 (AC-10)', () => {
  it('AC-10: SCALE: AS NOTED is a declaration, not a scale', () => {
    const r = parseScaleNotes('SCALE: AS NOTED');
    expect(r.noScaleMarker).toBe('AS NOTED');
  });

  it('recognises the self-evident markers anywhere', () => {
    expect(parseScaleNotes('N.T.S.').noScaleMarker).toBe('N.T.S.');
    expect(parseScaleNotes('NTS').noScaleMarker).toBe('NTS');
    expect(parseScaleNotes('DETAIL - NOT TO SCALE').noScaleMarker).toBe('NOT TO SCALE');
  });

  it('ignores a soft marker that SCALE does not introduce', () => {
    // "as noted" in a general note is ordinary English, not a scale statement.
    expect(parseScaleNotes('Provide backing as noted on the plans.').noScaleMarker).toBeNull();
  });

  it('does not fire on an ordinary word containing the letters', () => {
    expect(parseScaleNotes('SETTING POINTS AND ELEVATIONS').noScaleMarker).toBeNull();
  });
});

describe('parseScaleNotes — false-positive guards', () => {
  it('ignores numbers that are not scales', () => {
    expect(parseScaleNotes('SHEET 3 OF 12   REV 2   2024').candidates).toHaveLength(0);
  });

  it('does not read an inch fraction as a ratio', () => {
    // The 1/4 must not also surface as a bogus 1:4 candidate.
    const r = parseScaleNotes('SCALE: 1/4" = 1\'-0"');
    expect(r.candidates).toHaveLength(1);
  });

  it('discards a ratio too extreme to be a drawing scale', () => {
    // A part number or reference code wearing the shape of a ratio.
    expect(parseScaleNotes('SCALE 1:999999').candidates).toHaveLength(0);
    expect(parseScaleNotes('ITEM 500:1').candidates).toHaveLength(0);
  });

  it('still accepts the coarse and enlarged ratios that are real', () => {
    expect(only('SCALE 1:1250').unit).toBe('m');   // site plan
    expect(only('SCALE 1:25000').unit).toBe('m');  // location plan
    expect(only('SCALE 2:1').unit).toBe('mm');     // detail enlargement
  });

  it('caps how much text it will look at — NFR-3', () => {
    const huge = 'x'.repeat(ScaleDetect.MAX_TEXT + 5000) + ' SCALE: 1/4" = 1\'-0"';
    // The note past the cap is simply not seen; the call still returns.
    expect(parseScaleNotes(huge).candidates).toHaveLength(0);
  });

  it('returns promptly on adversarial input — NFR-9 / T3.1', () => {
    const started = Date.now();
    parseScaleNotes('1'.repeat(20000) + '"'.repeat(5000) + '='.repeat(5000));
    parseScaleNotes(('1/4" = ' + '9'.repeat(400)).repeat(200));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('never throws, whatever it is handed', () => {
    for (const bad of [null, undefined, 42, {}, [], '']) {
      expect(() => parseScaleNotes(bad)).not.toThrow();
    }
  });
});

/* --------------------------------------------------------------- confidence */

describe('classify — FR-23, FR-24, FR-25 (AC-9, AC-11)', () => {
  const cand = (factor, keyworded, unit = 'ft') => ({ factor, unit, ratioLabel: 'x', keyworded });

  it('FR-23: one keyworded scale is high confidence and auto-applies', () => {
    const r = classify([cand(1 / 18, true)]);
    expect(r.confidence).toBe('high');
    expect(r.apply).toBe(true);
    expect(r.chosen.factor).toBeCloseTo(1 / 18, 12);
  });

  it('FR-24 / AC-11: one bare scale is low confidence and waits for review', () => {
    const r = classify([cand(1 / 18, false)]);
    expect(r.confidence).toBe('low');
    expect(r.apply).toBe(false);
    expect(r.chosen.factor).toBeCloseTo(1 / 18, 12);
  });

  it('FR-25 / AC-9: a detail sheet claiming several scales applies nothing', () => {
    const r = classify([cand(1 / 18, true), cand(1 / 9, true), cand(1 / 108, true)]);
    expect(r.confidence).toBe('low');
    expect(r.apply).toBe(false);
    expect(r.chosen).toBeNull();
    expect(r.distinct).toHaveLength(3);
  });

  it('AC-9 end to end from the page text', () => {
    const text = 'DETAILS  SCALE: 1/4" = 1\'-0"  SCALE: 1/2" = 1\'-0"  SCALE: 3" = 1\'-0"';
    const r = classify(parseScaleNotes(text).candidates);
    expect(r.apply).toBe(false);
    expect(r.distinct).toHaveLength(3);
  });

  it('a scale repeated on the sheet is still one scale', () => {
    const r = classify([cand(1 / 18, false), cand(1 / 18, true), cand(1 / 18, false)]);
    expect(r.distinct).toHaveLength(1);
    expect(r.apply).toBe(true); // one occurrence was keyworded
  });

  it('the same number in different units is not the same scale', () => {
    const r = classify([cand(1, true, 'ft'), cand(1, true, 'm')]);
    expect(r.distinct).toHaveLength(2);
    expect(r.apply).toBe(false);
  });

  it('no candidates means nothing to apply', () => {
    const r = classify([]);
    expect(r.apply).toBe(false);
    expect(r.chosen).toBeNull();
    expect(classify(null).apply).toBe(false);
  });
});

/* ---------------------------------------------------------- half-size plots */

describe('halfSizePages — FR-28, FR-29 (AC-12, AC-13)', () => {
  const D = { w: 22, h: 34 };
  const B = { w: 11, h: 17 };
  const ARCH_D = { w: 24, h: 36 };
  const ARCH_B = { w: 12, h: 18 };

  it('AC-12: an all-11x17 set is a half-size plot of ANSI D', () => {
    const r = halfSizePages([B, B, B]);
    expect(r.every((p) => p.half)).toBe(true);
    expect(r[0].of).toBe('ANSI D');
  });

  it('AC-13: a mixed set containing the full size is not a reduction', () => {
    const r = halfSizePages([D, B, D]);
    expect(r.map((p) => p.half)).toEqual([false, false, false]);
  });

  it('works for the ARCH family too', () => {
    expect(halfSizePages([ARCH_B, ARCH_B])[0].of).toBe('ARCH D');
    expect(halfSizePages([ARCH_D, ARCH_B])[1].half).toBe(false);
  });

  it('ignores orientation', () => {
    expect(halfSizePages([{ w: 17, h: 11 }])[0].half).toBe(true);
    expect(halfSizePages([{ w: 34, h: 22 }, { w: 17, h: 11 }])[1].half).toBe(false);
  });

  it('tolerates the small size drift a plotter introduces', () => {
    expect(halfSizePages([{ w: 11.1, h: 17.15 }])[0].half).toBe(true);
  });

  it('leaves a full-size set alone', () => {
    expect(halfSizePages([D, D]).every((p) => !p.half)).toBe(true);
    expect(halfSizePages([ARCH_D]).every((p) => !p.half)).toBe(true);
  });

  it('says nothing about a non-standard page size', () => {
    expect(halfSizePages([{ w: 13.7, h: 29.1 }])[0].half).toBe(false);
  });

  it('survives junk input', () => {
    expect(halfSizePages(null)).toEqual([]);
    expect(halfSizePages([null, { w: 0, h: 0 }, { w: NaN, h: 3 }])
      .every((p) => p.half === false)).toBe(true);
  });
});

/* -------------------------------------------------------------- safeLabel */

describe('safeLabel — NFR-9', () => {
  it('folds control characters and collapses runs', () => {
    expect(safeLabel('1 in =	20 ft')).toBe('1 in = 20 ft');
  });

  it('caps length', () => {
    expect(safeLabel('x'.repeat(200)).length).toBe(40);
    expect(safeLabel('x'.repeat(200), 60).length).toBe(60);
  });

  it('has a stand-in for empty and non-string input', () => {
    expect(safeLabel('')).toBe('(none)');
    expect(safeLabel('   ')).toBe('(none)');
    expect(safeLabel(null)).toBe('(none)');
    expect(safeLabel(undefined)).toBe('(none)');
  });
});
