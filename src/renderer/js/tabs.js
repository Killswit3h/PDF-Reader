'use strict';

/*
 * Multi-document tabs.
 *
 * The app was built around a single document held in App.state, and every
 * module reads App.state directly. Rather than rewrite all of them, the ACTIVE
 * document's fields always live in App.state (so nothing else changes), and this
 * module keeps a list of sessions — each a snapshot of the per-document fields
 * plus that tab's undo/redo stacks and view (zoom/page). Switching tabs snapshots
 * the live App.state back into the current session, then copies the target
 * session's fields into App.state and re-shows it in the viewer (reusing the
 * already-parsed PDF.js document, so switching is instant).
 *
 * Opening any PDF (dialog, drag-drop, or an "Open with"/Outlook attachment
 * delivered by the main process) adds a tab instead of replacing the current
 * document — so multiple PDFs stay open and nothing clobbers unsaved work.
 */
(function () {
  const T = {};

  // Per-document App.state fields captured on a tab switch. Shared, user-level
  // fields (lastSignature, lastInitials, annoStyle) are intentionally NOT here,
  // so a remembered signature / current pen style carries across tabs.
  const DOC_FIELDS = [
    'pdfDoc', 'pdfBytes', 'fileName', 'filePath', 'numPages', 'currentPage', 'zoom', 'baseViewports',
    'pageEls', 'mode', 'placements', 'selectedId', 'placementSeq',
    'scales', 'viewports', 'measurements', 'measureSeq', 'viewportSeq', 'measureSelectedId',
    'annotations', 'annoSeq', 'annoSelectedId', 'annoUndo', 'annoRedo', 'saveAnnots', 'flattenForms',
    'dirty', 'docStamp'
  ];

  let sessions = [];   // { id, state, history:{undo,redo}, scaleValue, page }
  let activeId = null;
  let seq = 0;

  T.count = () => sessions.length;
  // A document is dirty if the active one (live in App.state) or any snapshot is.
  T.anyDirty = () => sessions.some((s) => (s.id === activeId ? App.state.dirty : s.state.dirty));

  function freshState(doc, original, name, filePath) {
    return {
      pdfDoc: doc, pdfBytes: original, fileName: name || 'document.pdf', filePath: filePath || null,
      numPages: doc.numPages, currentPage: 1, zoom: 1.0, baseViewports: [], pageEls: [],
      mode: null, placements: [], selectedId: null, placementSeq: 0,
      scales: {}, viewports: {}, measurements: [], measureSeq: 0, viewportSeq: 0, measureSelectedId: null,
      annotations: [], annoSeq: 0, annoSelectedId: null, annoUndo: [], annoRedo: [], saveAnnots: false, flattenForms: false,
      dirty: false, docStamp: null
    };
  }

  function snapshotActive() {
    if (activeId == null) return;
    const s = sessions.find((x) => x.id === activeId);
    if (!s) return;
    const st = {};
    DOC_FIELDS.forEach((k) => { st[k] = App.state[k]; });
    s.state = st;
    s.history = App.History._export();
    try { s.scaleValue = App.Viewer._pdfViewer && App.Viewer._pdfViewer.currentScaleValue; } catch (_) { s.scaleValue = null; }
    s.page = App.state.currentPage || 1;
  }

  function activate(session, restoreView) {
    activeId = session.id;
    DOC_FIELDS.forEach((k) => { App.state[k] = session.state[k]; });
    App.History._import(session.history);
    if (App.setMode) App.setMode(null);
    App.Viewer._showActive(restoreView ? { scaleValue: session.scaleValue, page: session.page } : null);
    renderBar();
  }

  // Open a new document in a new tab.
  T.open = async function (arrayBuffer, name, filePath) {
    App.Viewer.init();
    App.showLoading('Opening PDF…');
    try {
      const { doc, original } = await App.Viewer._parse(arrayBuffer);
      snapshotActive();
      const session = { id: ++seq, state: freshState(doc, original, name, filePath), history: { undo: [], redo: [] }, scaleValue: null, page: 1 };
      sessions.push(session);
      activate(session, false);
      App.toast(`Opened ${session.state.fileName}`, 'success');
      return true;
    } catch (err) {
      console.error(err);
      const msg = /password|encrypted/i.test((err && err.message) || '')
        ? 'This PDF is password-protected / encrypted and cannot be opened.'
        : 'Could not open this file. It may be corrupt or not a valid PDF.';
      App.toast(msg, 'error', 6000);
      if (!sessions.length) App.Viewer.showEmpty();
      return false;
    } finally {
      App.hideLoading();
    }
  };

  // Replace the active document's content in place (organizer rebuild). Keeps the
  // same tab rather than opening a new one.
  T.replaceActive = async function (arrayBuffer, name, filePath) {
    if (activeId == null) return T.open(arrayBuffer, name, filePath);
    const ok = await App.Viewer._loadInto(arrayBuffer, name, filePath);
    if (ok) { snapshotActive(); renderBar(); }
    return ok;
  };

  T.switchTo = function (id) {
    if (id === activeId) return;
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    snapshotActive();
    activate(target, true);
  };

  // Close a tab (after confirming unsaved changes). Activates a neighbor, or the
  // empty state if it was the last one.
  T.close = function (id) {
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const wasActive = id === activeId;
    sessions.splice(idx, 1);
    if (!sessions.length) {
      activeId = null;
      App.Viewer.showEmpty();
      renderBar();
      return;
    }
    if (wasActive) {
      activeId = null; // ensure activate() runs a full restore
      activate(sessions[Math.min(idx, sessions.length - 1)], true);
    } else {
      renderBar();
    }
  };

  async function requestClose(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    const name = (id === activeId ? App.state.fileName : s.state.fileName) || 'this PDF';
    const dirty = id === activeId ? App.state.dirty : s.state.dirty;
    if (dirty) {
      const ok = await App.confirm(`Close “${name}” without saving your changes?`,
        { title: 'Unsaved changes', okLabel: 'Close without saving', danger: true });
      if (!ok) return;
    }
    T.close(id);
  }
  T.requestCloseActive = () => { if (activeId != null) requestClose(activeId); };

  // Move the dragged tab so it sits before/after the target tab, then re-render.
  // Order in `sessions` IS the tab order, so reordering is just an array splice.
  T.reorder = function (fromId, targetId, placeBefore) {
    if (fromId === targetId) return;
    const from = sessions.findIndex((s) => s.id === fromId);
    if (from === -1) return;
    const [moved] = sessions.splice(from, 1);
    let to = sessions.findIndex((s) => s.id === targetId);
    if (to === -1) { sessions.splice(from, 0, moved); return; } // target gone; undo
    if (!placeBefore) to += 1;
    sessions.splice(to, 0, moved);
    renderBar();
  };

  let dragId = null;

  // ---- Tab bar UI ----
  T.renderBar = renderBar;
  function renderBar() {
    const bar = App.$('#tab-bar');
    if (!bar) return;
    bar.innerHTML = '';
    // Hide the bar entirely with 0–1 documents (no need for a single tab); the
    // body class shifts the viewer down to make room when it's shown.
    const show = sessions.length >= 2;
    bar.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-tabs', show);
    if (show) {
      sessions.forEach((s) => {
        const isActive = s.id === activeId;
        const name = (isActive ? App.state.fileName : s.state.fileName) || 'PDF';
        const dirty = isActive ? App.state.dirty : s.state.dirty;
        const tab = document.createElement('div');
        tab.className = 'tab' + (isActive ? ' active' : '');
        tab.title = name;
        tab.addEventListener('click', () => T.switchTo(s.id));

        // Drag to reorder. Order in `sessions` drives the tab order, so a drop
        // just splices the dragged tab before/after the tab under the cursor
        // (left half → before, right half → after).
        tab.draggable = true;
        tab.addEventListener('dragstart', (e) => {
          dragId = s.id;
          tab.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(s.id)); } catch (_) { /* IE/Safari quirk */ }
          }
        });
        tab.addEventListener('dragend', () => {
          dragId = null;
          bar.querySelectorAll('.tab').forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after'));
        });
        tab.addEventListener('dragover', (e) => {
          if (dragId == null || dragId === s.id) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          const r = tab.getBoundingClientRect();
          const before = e.clientX < r.left + r.width / 2;
          tab.classList.toggle('drop-before', before);
          tab.classList.toggle('drop-after', !before);
        });
        tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after'));
        tab.addEventListener('drop', (e) => {
          if (dragId == null || dragId === s.id) return;
          e.preventDefault(); e.stopPropagation();
          const r = tab.getBoundingClientRect();
          const before = e.clientX < r.left + r.width / 2;
          T.reorder(dragId, s.id, before);
        });
        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = (dirty ? '• ' : '') + name;
        tab.appendChild(label);
        const close = document.createElement('button');
        close.className = 'tab-close';
        close.textContent = '✕';
        close.title = 'Close tab';
        close.addEventListener('click', (e) => { e.stopPropagation(); requestClose(s.id); });
        tab.appendChild(close);
        bar.appendChild(tab);
      });
      const add = document.createElement('button');
      add.className = 'tab-add';
      add.textContent = '+';
      add.title = 'Open another PDF';
      add.addEventListener('click', () => { if (App.openViaDialog) App.openViaDialog(); });
      bar.appendChild(add);
    }
  }

  App.Tabs = T;
})();
