'use strict';

/*
 * Unified undo/redo for every editable layer.
 *
 * Previously only markup had undo/redo (over App.state.annotations). This
 * generalizes the whole-snapshot pattern to cover placements, measurements
 * (incl. scales + viewport regions) and annotations at once, so Ctrl+Z behaves
 * consistently no matter what the user last touched.
 *
 * Contract: call App.History.snapshot() *before* a mutation. undo() restores
 * the pre-mutation state; redo() re-applies. State is small JSON, so full
 * snapshots (capped at 60) are cheap and dead simple to reason about.
 */
(function () {
  const KEYS = [
    'placements', 'measurements', 'viewports', 'scales', 'annotations',
    'selectedId', 'measureSelectedId', 'annoSelectedId'
  ];
  const CAP = 60;
  let undo = [];
  let redo = [];

  function capture() {
    const o = {};
    KEYS.forEach((k) => { o[k] = App.state[k]; });
    return JSON.stringify(o);
  }

  function apply(json) {
    const o = JSON.parse(json);
    KEYS.forEach((k) => { if (k in o) App.state[k] = o[k]; });
    rerenderAll();
  }

  // Rebuild every layer + panel from the restored state.
  function rerenderAll() {
    if (App.Placement) App.Placement.repositionAll();
    if (App.Measure) { App.Measure.repositionAll(); App.Measure.renderPanel(); }
    if (App.Markup) App.Markup.repositionAll();
    if (App.MarkupPanel) App.MarkupPanel.render();
    if (App.refreshChrome) App.refreshChrome();
    // Saving is meaningful whenever anything exists.
    const save = App.$('#btn-save');
    if (save) save.disabled = !(App.state.pdfDoc);
  }

  App.History = {
    // Push the current state; call before mutating.
    snapshot() {
      undo.push(capture());
      if (undo.length > CAP) undo.shift();
      redo = [];
      App.state.dirty = true; // unsaved edits exist (drives save-on-close prompt)
    },
    undo() {
      if (!undo.length) return;
      redo.push(capture());
      apply(undo.pop());
      App.state.dirty = true;
    },
    redo() {
      if (!redo.length) return;
      undo.push(capture());
      apply(redo.pop());
      App.state.dirty = true;
    },
    // Drop all history (e.g. when a new document loads).
    reset() { undo = []; redo = []; App.state.dirty = false; },
    canUndo() { return undo.length > 0; },
    canRedo() { return redo.length > 0; },
    // Save/restore the stacks so each open tab keeps its own undo history.
    _export() { return { undo: undo.slice(), redo: redo.slice() }; },
    _import(s) { undo = (s && s.undo) ? s.undo.slice() : []; redo = (s && s.redo) ? s.redo.slice() : []; }
  };
})();
