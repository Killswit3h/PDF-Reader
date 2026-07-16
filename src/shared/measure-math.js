'use strict';

/*
 * Scale + measurement math, shared by measure.js and unit-tested in Node.
 *
 *   pointsPerUnit = PDF points (1/72 in) spanning one real-world unit at 1:1.
 *   factor        = real-world units per scale-1 viewport point.
 *   length_real   = pdfLength * factor
 *   area_real     = pdfArea   * factor^2
 *   angle/count   = geometry only, scale-independent.
 *
 * `computeValue` is pure: it takes an explicit `scale` ({factor, unit} | null)
 * rather than reading App.state, so measure.js resolves the scale (page vs.
 * region) and this file does the arithmetic. Dual export → { UNITS, fmtMeasure,
 * computeValue } in Node, or App.UNITS / App.fmtMeasure / App.computeValue in
 * the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./geometry').Geom);
  } else {
    root.App = root.App || {};
    Object.assign(root.App, factory(root.App.Geom));
  }
})(typeof self !== 'undefined' ? self : this, function (Geom) {
  const UNITS = {
    in: { perPoint: 72, label: 'in' },
    ft: { perPoint: 864, label: 'ft' },
    yd: { perPoint: 2592, label: 'yd' },
    mm: { perPoint: 72 / 25.4, label: 'mm' },
    cm: { perPoint: 72 / 2.54, label: 'cm' },
    m: { perPoint: 7200 / 2.54, label: 'm' }
  };

  // Format a real length given in FEET as architectural feet-inches, e.g.
  // 24.5 → `24'-6"`, 24.53 → `24'-6 3/8"`. `denom` is the inch-fraction
  // denominator (1/2/4/8/16/32); inches round to the nearest 1/denom and carry
  // into feet, so 11.99" never prints as 11 63/64" — it rolls to the next foot.
  // The fraction is reduced (8/16 → 1/2) and dropped when zero. Negative-safe.
  function formatFeetInches(feet, denom) {
    denom = denom || 16;
    const sign = feet < 0 ? '-' : '';
    // Work in whole "ticks" of 1/denom inch to keep the carry exact.
    let ticks = Math.round(Math.abs(feet) * 12 * denom);
    const ft = Math.floor(ticks / (12 * denom));
    ticks -= ft * 12 * denom;
    const whole = Math.floor(ticks / denom);
    let num = ticks - whole * denom;
    let den = denom;
    while (num > 0 && num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
    const inchStr = num > 0 ? `${whole} ${num}/${den}` : `${whole}`;
    return `${sign}${ft}'-${inchStr}"`;
  }

  // Human-readable value for a measurement of the given type. `opts` (optional):
  //   { feetInches: bool, denom: number } — when set and the unit is feet, render
  //   length/perimeter as architectural feet-inches instead of decimal feet.
  // Area stays decimal unit² (feet-inches is a linear notation only).
  function fmtMeasure(type, value, unit, opts) {
    if (type === 'count') return `${value}`;
    if (type === 'angle') return `${value.toFixed(1)}°`;
    if (type === 'area') return `${value.toFixed(2)} ${unit}²`;
    // length / perimeter
    if (opts && opts.feetInches && unit === 'ft') return formatFeetInches(value, opts.denom);
    return `${value.toFixed(2)} ${unit}`;
  }

  // Per-segment real lengths for a polyline/polygon, in the scale's units. For
  // an 'area' the closing segment (last→first) is included so the parts sum to
  // the perimeter. Returns numbers, or null when there's no scale to measure by.
  // Pure — the renderer resolves the governing scale and calls this.
  function segmentLengths(type, pts, scale) {
    if (!scale || !pts || pts.length < 2) return null;
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) segs.push(Geom.dist(pts[i], pts[i + 1]) * scale.factor);
    if (type === 'area' && pts.length >= 3) segs.push(Geom.dist(pts[pts.length - 1], pts[0]) * scale.factor);
    return segs;
  }

  // Real-world value + unit for a point set. `scale` = { factor, unit } | null.
  function computeValue(type, pts, scale) {
    if (type === 'count') return { value: pts.length, unit: 'ct' };
    if (type === 'angle') {
      return { value: pts.length >= 3 ? Geom.angleAt(pts[0], pts[1], pts[2]) : 0, unit: '°' };
    }
    if (!scale) return { value: null, unit: null };
    if (type === 'area') return { value: Geom.shoelace(pts) * scale.factor * scale.factor, unit: scale.unit };
    // length / perimeter
    return { value: Geom.polyLen(pts) * scale.factor, unit: scale.unit };
  }

  // Convert an "enter scale" ratio (draw length/unit = real length/unit) into a
  // factor (real units per scale-1 point). Pure — handy for tests + presets.
  function ratioToFactor(drawVal, drawUnit, realVal) {
    const drawPts = drawVal * UNITS[drawUnit].perPoint;
    return realVal / drawPts;
  }

  return { UNITS, fmtMeasure, formatFeetInches, computeValue, ratioToFactor, segmentLengths };
});
