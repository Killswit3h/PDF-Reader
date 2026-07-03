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

  // Human-readable value for a measurement of the given type.
  function fmtMeasure(type, value, unit) {
    if (type === 'count') return `${value}`;
    if (type === 'angle') return `${value.toFixed(1)}°`;
    const v = value.toFixed(2);
    if (type === 'area') return `${v} ${unit}²`;
    return `${v} ${unit}`; // length / perimeter
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

  return { UNITS, fmtMeasure, computeValue, ratioToFactor };
});
