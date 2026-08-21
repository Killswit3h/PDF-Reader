'use strict';

/*
 * The editable round-trip model: the serialized form of every mark in a
 * document, embedded as a PDF attachment by save.js and read back by tabs.js
 * on open. Lives here rather than in the renderer so it can be unit-tested in
 * Node — this shape IS the round-trip contract, and a silent change to it
 * means saved files stop reopening as editable.
 *
 * Pure: takes a state object, returns a fresh deep-cloned model. Dual export →
 * { serializeMarkupModel, MARKUP_MODEL_VERSION } in Node, or the same names on
 * App in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  // Bumped only when the shape changes in a way older readers cannot handle.
  const MARKUP_MODEL_VERSION = 1;

  // Deep clone via JSON: the model is plain geometry and style data by
  // construction, and cloning stops a later edit to App.state from mutating a
  // model that has already been handed to the encoder.
  function cloneArray(x) {
    return Array.isArray(x) ? JSON.parse(JSON.stringify(x)) : [];
  }
  function cloneObject(x) {
    return x && typeof x === 'object' && !Array.isArray(x) ? JSON.parse(JSON.stringify(x)) : {};
  }

  // Serialize the in-app marks (geometry in scale-1 viewport points) so a saved
  // PDF can be reopened with everything still editable.
  //
  // __count is the gate save.js uses to decide whether to attach a sidecar at
  // all: a document with no marks should not carry one. It is deleted from the
  // model before encoding, so it never reaches the file.
  function serializeMarkupModel(state) {
    const st = state || {};
    const m = {
      v: MARKUP_MODEL_VERSION,
      seqs: {
        placementSeq: st.placementSeq || 0,
        measureSeq: st.measureSeq || 0,
        viewportSeq: st.viewportSeq || 0,
        annoSeq: st.annoSeq || 0
      },
      saveAnnots: !!st.saveAnnots,
      scales: cloneObject(st.scales),
      viewports: cloneObject(st.viewports),
      placements: cloneArray(st.placements),
      measurements: cloneArray(st.measurements),
      annotations: cloneArray(st.annotations)
    };
    m.__count = m.placements.length + m.measurements.length + m.annotations.length;
    return m;
  }

  return { serializeMarkupModel, MARKUP_MODEL_VERSION };
});
