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

  // Open documents as { id, name, active } — used by the Split View doc picker.
  T.list = () => sessions.map((s) => ({
    id: s.id,
    name: (s.id === activeId ? App.state.fileName : s.state.fileName) || 'PDF',
    active: s.id === activeId
  }));
  // Raw PDF bytes / name for a tab (the active tab's live values, or a snapshot's).
  T.bytesOf = (id) => (id === activeId ? App.state.pdfBytes
    : (sessions.find((x) => x.id === id) || { state: {} }).state.pdfBytes || null);
  T.nameOf = (id) => (id === activeId ? App.state.fileName
    : (sessions.find((x) => x.id === id) || { state: {} }).state.fileName || null);

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

  // ---- Tear-off: pop a tab into its own window (desktop only) ----

  // Serialize a session's marks into the model shape Viewer._rehydrate consumes.
  function buildModel(st) {
    return {
      placements: st.placements || [], measurements: st.measurements || [], annotations: st.annotations || [],
      scales: st.scales || {}, viewports: st.viewports || {}, saveAnnots: !!st.saveAnnots,
      seqs: { placementSeq: st.placementSeq || 0, measureSeq: st.measureSeq || 0, viewportSeq: st.viewportSeq || 0, annoSeq: st.annoSeq || 0 }
    };
  }
  // Apply a transferred marks model onto a plain state object (mirrors
  // Viewer._rehydrate, but targets a session's state so the marks are present
  // BEFORE the doc renders — refreshOverlays() then draws them on pagerendered).
  function applyModel(st, m) {
    if (!m) return;
    st.placements = Array.isArray(m.placements) ? m.placements : [];
    st.measurements = Array.isArray(m.measurements) ? m.measurements : [];
    st.annotations = Array.isArray(m.annotations) ? m.annotations : [];
    st.scales = m.scales && typeof m.scales === 'object' ? m.scales : {};
    st.viewports = m.viewports && typeof m.viewports === 'object' ? m.viewports : {};
    st.saveAnnots = !!m.saveAnnots;
    const maxId = (arr) => arr.reduce((n, o) => Math.max(n, (o && o.id) || 0), 0);
    const s = m.seqs || {};
    st.placementSeq = Math.max(s.placementSeq || 0, maxId(st.placements));
    st.measureSeq = Math.max(s.measureSeq || 0, maxId(st.measurements));
    st.viewportSeq = s.viewportSeq || 0;
    st.annoSeq = Math.max(s.annoSeq || 0, maxId(st.annotations));
  }
  function hasMarks(st) {
    return !!((st.placements || []).length || (st.annotations || []).length || (st.measurements || []).length);
  }

  T.canTearOff = () => !!(window.api && window.api.isDesktop && window.api.openTearoff && sessions.length >= 2);

  // Move a tab into its own OS window, carrying its unsaved edits (base bytes +
  // marks model). On success the tab leaves this window.
  T.tearOff = async function (id) {
    if (!window.api || !window.api.isDesktop || !window.api.openTearoff) return false;
    if (sessions.length < 2) { App.toast('Open another PDF first, then move this one to its own window.', 'info', 3500); return false; }
    if (id === activeId) snapshotActive();
    const s = sessions.find((x) => x.id === id);
    if (!s || !s.state.pdfBytes) return false;
    const st = s.state;
    const ok = await window.api.openTearoff({
      base: st.pdfBytes, model: buildModel(st),
      fileName: st.fileName, filePath: st.filePath, dirty: !!st.dirty
    });
    if (ok) T.close(id); // moved to the new window — its edits went with it
    return ok;
  };
  T.tearOffActive = () => (activeId == null ? false : T.tearOff(activeId));

  // Receive a document torn off from another window and open it as a tab here,
  // rehydrating its marks from the transferred model.
  T.openTearoff = async function (payload) {
    if (!payload || !payload.base) return false;
    App.Viewer.init();
    App.showLoading('Opening PDF…');
    try {
      const { doc, original } = await App.Viewer._parse(payload.base);
      snapshotActive();
      const session = { id: ++seq, state: freshState(doc, original, payload.fileName, payload.filePath), history: { undo: [], redo: [] }, scaleValue: null, page: 1 };
      applyModel(session.state, payload.model);
      session.state.dirty = !!payload.dirty;
      sessions.push(session);
      activate(session, false); // marks already in state → drawn on first render
      if (hasMarks(session.state)) App.$('#btn-save').disabled = false;
      App.toast(`Opened ${session.state.fileName}`, 'success');
      return true;
    } catch (err) {
      console.error(err);
      App.toast('Could not open the PDF in this window.', 'error', 5000);
      if (!sessions.length) App.Viewer.showEmpty();
      return false;
    } finally {
      App.hideLoading();
    }
  };

  // ---- Tab context menu (right-click) ----
  function closeTabMenu() {
    const m = App.$('#tab-menu');
    if (m) m.remove();
    document.removeEventListener('pointerdown', onDocDownForMenu, true);
  }
  function onDocDownForMenu(e) {
    if (!e.target.closest('#tab-menu')) closeTabMenu();
  }
  function showTabMenu(x, y, id) {
    closeTabMenu();
    const menu = document.createElement('div');
    menu.id = 'tab-menu';
    menu.className = 'tab-menu';
    const item = (label, fn, disabled) => {
      const b = document.createElement('button');
      b.className = 'tab-menu-item';
      b.textContent = label;
      if (disabled) b.disabled = true;
      else b.addEventListener('click', () => { closeTabMenu(); fn(); });
      menu.appendChild(b);
    };
    item('🗔 Open in New Window', () => T.tearOff(id), !T.canTearOff());
    document.body.appendChild(menu);
    // Keep the menu on-screen (flip left/up near the edges).
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
    document.addEventListener('pointerdown', onDocDownForMenu, true);
  }
  T._showTabMenu = showTabMenu;

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
        // Right-click → tab actions (Open in New Window).
        tab.addEventListener('contextmenu', (e) => { e.preventDefault(); showTabMenu(e.clientX, e.clientY, s.id); });

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
        tab.addEventListener('dragend', (e) => {
          dragId = null;
          bar.querySelectorAll('.tab').forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after'));
          // Dragged out of the window → tear the tab off into its own window.
          // (A drop back inside the bar is a reorder, handled by the drop below.)
          if (T.canTearOff() && e.screenX != null) {
            const outside = e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth ||
              e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
            if (outside) T.tearOff(s.id);
          }
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
