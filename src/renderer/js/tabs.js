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
    // View rotation is per document, not per window: switching tabs must not
    // straighten a sheet you turned. `bookmarks` belongs here for the same
    // reason and was missed when it was added -- without it, switching tabs
    // showed the previous document's bookmarks. `scaleDetect` is per document
    // for the same reason again: it describes THIS file's pages.
    'rotation', 'bookmarks',
    'dirty', 'docStamp', 'scaleDetect'
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
      annotations: [], annoSeq: 0, annoSelectedId: null, annoUndo: [], annoRedo: [], saveAnnots: true, flattenForms: false,
      bookmarks: [], rotation: 0,
      dirty: false, docStamp: null,
      scaleDetect: { status: 'idle', pages: {} }
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
      let { doc, original } = await App.Viewer._parse(arrayBuffer);
      // Editable round-trip. This has to happen HERE, not only in
      // Viewer._loadInto. Opening a file goes through the tab manager, which
      // builds a fresh session state from the bytes on disk, so the restore
      // _loadInto performs never ran on the path users actually take — it is
      // reachable only from replaceActive() and the no-tabs fallback. The
      // result was the original defect: a file saved with a perfectly good
      // sidecar reopened with every mark flattened into the page and the model
      // silently ignored. Swap the pristine base in as the working document.
      const sidecar = await App.Viewer._readSidecar(doc);
      if (sidecar && sidecar.base) {
        const reparsed = await App.Viewer._parse(sidecar.base);
        doc = reparsed.doc; original = reparsed.original;
      }
      snapshotActive();
      const session = { id: ++seq, state: freshState(doc, original, name, filePath), history: { undo: [], redo: [] }, scaleValue: null, page: 1 };
      // Applied to the session state BEFORE activate(), so the overlay draws the
      // marks on the first render instead of popping them in afterwards.
      // Requires the base: without it the visible page is already flattened and
      // re-applying would draw every mark twice.
      if (sidecar && sidecar.base) applyModel(session.state, sidecar.data);
      // Bookmarks come from the document's own outline, which is authoritative;
      // the sidecar only says which entries this app created. Read AFTER the
      // base swap so it is the base's outline, not the flattened copy's.
      const owned = (sidecar && sidecar.data && sidecar.data.bookmarks) || [];
      session.state.bookmarks = App.Bookmarks ? await App.Bookmarks.read(doc, owned) : [];
      sessions.push(session);
      activate(session, false);
      App.toast(`Opened ${session.state.fileName}`, 'success');
      // Model with no base: recoverable data that must not vanish without a word.
      if (sidecar && !sidecar.base) App.Viewer._offerOrphanModel(sidecar.data);
      // Read the document's own scales (FR-1). This has to happen HERE for the
      // same reason the base swap above does: opening a file goes through the
      // tab manager, so a hook in Viewer.load alone never fires on the path
      // users actually take. Deliberately not awaited — the open has already
      // succeeded and the viewer stays interactive while a large set is
      // scanned (NFR-1). It runs after applyModel(), so any scale restored
      // from the sidecar is already in place and is left alone (FR-5).
      if (App.ScaleDetect && App.ScaleDetect.run) {
        App.ScaleDetect.run().catch(() => { /* detection is best-effort */ });
      }
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
  // Re-capture the active tab's state into its session. replaceActive() already
  // does this, but a caller that restores marks *after* the swap (ocr.js, which
  // rehydrates placements/measurements/markups onto the recognized document)
  // must snapshot again, or switching tabs would drop what it just restored.
  T.snapshotActive = snapshotActive;

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

  // ---- Rearranging tabs ----
  // Order in `sessions` IS the tab order, so every rearrangement is just a
  // permutation of the session ids. The arithmetic lives in the shared
  // TabOrder module (unit-tested in Node); this end only maps ids back to
  // sessions and re-renders. Reordering never changes which document is
  // active — you're rearranging the strip, not navigating it.
  const orderIds = () => sessions.map((s) => s.id);

  function applyOrder(ids) {
    if (App.TabOrder.sameOrder(orderIds(), ids)) return false;   // nothing moved
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    if (next.length !== sessions.length) return false;           // lost a tab — refuse
    sessions = next;
    renderBar();
    return true;
  }

  // Drop `fromId` before (or after) `targetId` — the drag-and-drop path.
  T.reorder = function (fromId, targetId, placeBefore) {
    return applyOrder(App.TabOrder.moveTab(orderIds(), fromId, targetId, !!placeBefore));
  };

  // Nudge a tab one or more slots along the strip — the keyboard path.
  T.move = function (id, delta) {
    return applyOrder(App.TabOrder.shiftTab(orderIds(), id, delta));
  };

  // Send a tab to the far start/end — the right-click menu path.
  T.moveToEdge = function (id, edge) {
    return applyOrder(App.TabOrder.moveTabToEdge(orderIds(), id, edge));
  };

  // Where a tab sits now, 1-based — used for the screen-reader/toast readout.
  T.positionOf = (id) => sessions.findIndex((s) => s.id === id) + 1;

  // Keyboard shortcut target: move the ACTIVE tab and say where it landed, so
  // the move is announced rather than only visible.
  T.moveActive = function (delta) {
    if (activeId == null || sessions.length < 2) return false;
    if (!T.move(activeId, delta)) return false;
    const name = App.state.fileName || 'PDF';
    App.toast(`${name} moved to ${T.positionOf(activeId)} of ${sessions.length}`, 'info', 1400);
    return true;
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
      b.innerHTML = label;   // label carries an App.icon() glyph ahead of its text
      if (disabled) b.disabled = true;
      else b.addEventListener('click', () => { closeTabMenu(); fn(); });
      menu.appendChild(b);
    };
    // Rearranging without a drag — the discoverable path, and the only one that
    // works when a tab strip is too crowded to drag comfortably.
    const at = T.positionOf(id);
    const last = sessions.length;
    item(App.icon('chevron-left') + 'Move Left', () => T.move(id, -1), at <= 1);
    item(App.icon('chevron-right') + 'Move Right', () => T.move(id, 1), at >= last);
    item(App.icon('chevrons-left') + 'Move to Start', () => T.moveToEdge(id, 'start'), at <= 1);
    item(App.icon('chevrons-right') + 'Move to End', () => T.moveToEdge(id, 'end'), at >= last);
    item(App.icon('window') + 'Open in New Window', () => T.tearOff(id), !T.canTearOff());
    document.body.appendChild(menu);
    // Keep the menu on-screen (flip left/up near the edges).
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
    document.addEventListener('pointerdown', onDocDownForMenu, true);
  }
  T._showTabMenu = showTabMenu;

  let dragId = null;

  // ---- Shared drag plumbing (mouse drag-and-drop AND the touch gesture) ----

  const tabEls = () => App.$$('#tab-bar .tab');
  const clearDropMarks = () => tabEls().forEach((t) => t.classList.remove('drop-before', 'drop-after'));
  const tabElById = (id) => App.$(`#tab-bar .tab[data-tab-id="${id}"]`);
  function focusTabEl(id) { const el = tabElById(id); if (el) el.focus(); }

  // Which tab is under this point, and which half of it — the insertion side.
  // Both drag paths ask the same question, so they agree on where a drop lands.
  function dropTargetAt(x, y, exceptEl) {
    const hit = document.elementFromPoint(x, y);
    const tab = hit && hit.closest ? hit.closest('#tab-bar .tab') : null;
    if (!tab || tab === exceptEl || tab.dataset.tabId == null) return null;
    const r = tab.getBoundingClientRect();
    return { tab, id: Number(tab.dataset.tabId), before: x < r.left + r.width / 2 };
  }

  // Paint the insertion bar on the tab under the cursor and nowhere else.
  function markDropTarget(hit) {
    clearDropMarks();
    if (!hit) return;
    hit.tab.classList.toggle('drop-before', hit.before);
    hit.tab.classList.toggle('drop-after', !hit.before);
  }

  // A crowded strip scrolls, so a drag that reaches either edge has to pull the
  // off-screen tabs into view — otherwise you can only reorder what you can see.
  const EDGE_ZONE = 48;
  function autoScroll(x) {
    const bar = App.$('#tab-bar');
    if (!bar || bar.scrollWidth <= bar.clientWidth) return;
    const r = bar.getBoundingClientRect();
    if (x < r.left + EDGE_ZONE) bar.scrollLeft -= Math.max(6, (r.left + EDGE_ZONE - x) / 2);
    else if (x > r.right - EDGE_ZONE) bar.scrollLeft += Math.max(6, (x - (r.right - EDGE_ZONE)) / 2);
  }

  // ---- Rearranging by touch ----
  // HTML5 drag events never fire on a touchscreen, so Android/iOS get their own
  // gesture: press and hold a tab to pick it up, slide to the slot you want, and
  // lift to drop it. The hold delay is what lets an ordinary swipe still scroll a
  // crowded strip instead of grabbing whichever tab it started on.
  const HOLD_MS = 350;
  const HOLD_SLOP = 10;      // movement (px) before the hold fires = a scroll, not a grab
  let touchDrag = null;      // { id, el, pointerId, timer, x0, y0, active }
  let swallowClick = false;  // a completed drag must not also read as a tap that switches tabs

  function endTouchDrag() {
    if (!touchDrag) return;
    clearTimeout(touchDrag.timer);
    const { el, pointerId, active } = touchDrag;
    if (el) {
      el.classList.remove('dragging', 'touch-dragging');
      el.style.transform = '';
      try { if (el.hasPointerCapture && el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId); } catch (_) { /* already gone */ }
    }
    clearDropMarks();
    const bar = App.$('#tab-bar');
    if (bar) bar.classList.remove('reordering');
    touchDrag = null;
    return active;
  }

  function beginTouchDrag() {
    if (!touchDrag || touchDrag.active) return;
    touchDrag.active = true;
    touchDrag.el.classList.add('dragging', 'touch-dragging');
    const bar = App.$('#tab-bar');
    if (bar) bar.classList.add('reordering');
    try { touchDrag.el.setPointerCapture(touchDrag.pointerId); } catch (_) { /* capture is a nicety */ }
    // A short buzz is the only signal a touch user gets that the tab is now held.
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) { /* unsupported */ }
  }

  function onTabPointerDown(e, id, el) {
    if (e.pointerType !== 'touch' || !e.isPrimary || sessions.length < 2) return;
    endTouchDrag();
    touchDrag = { id, el, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, active: false, timer: null };
    touchDrag.timer = setTimeout(beginTouchDrag, HOLD_MS);
  }

  function onTabPointerMove(e) {
    if (!touchDrag || e.pointerId !== touchDrag.pointerId) return;
    if (!touchDrag.active) {
      // Moved before the hold fired — the user is scrolling the strip, not
      // picking a tab up. Let the browser have the gesture.
      if (Math.abs(e.clientX - touchDrag.x0) > HOLD_SLOP || Math.abs(e.clientY - touchDrag.y0) > HOLD_SLOP) endTouchDrag();
      return;
    }
    e.preventDefault();
    // Carry the tab under the finger so the gesture reads as picking it up.
    touchDrag.el.style.transform = `translateX(${e.clientX - touchDrag.x0}px)`;
    autoScroll(e.clientX);
    markDropTarget(dropTargetAt(e.clientX, e.clientY, touchDrag.el));
  }

  function onTabPointerUp(e) {
    if (!touchDrag || e.pointerId !== touchDrag.pointerId) return;
    const hit = touchDrag.active ? dropTargetAt(e.clientX, e.clientY, touchDrag.el) : null;
    const fromId = touchDrag.id;
    const wasActive = endTouchDrag();
    if (wasActive) {
      swallowClick = true;                       // the tap that follows a drop is not a tab switch
      setTimeout(() => { swallowClick = false; }, 0);
      if (hit) T.reorder(fromId, hit.id, hit.before);
    }
  }

  // touch-action can't be flipped mid-gesture, so stop the strip scrolling under
  // an active drag the one way that always works: refuse the touchmove outright.
  // Must be non-passive, or preventDefault() is ignored.
  function installTouchGuard(bar) {
    bar.addEventListener('touchmove', (e) => {
      if (touchDrag && touchDrag.active) e.preventDefault();
    }, { passive: false });
  }

  // ---- Tab bar UI ----
  T.renderBar = renderBar;
  function renderBar() {
    const bar = App.$('#tab-bar');
    if (!bar) return;
    // Rebuilding the strip destroys the focused element, which would drop a
    // keyboard user back to the document body in the middle of a move. Note
    // which tab held focus so it can be handed back after the rebuild.
    const focusedEl = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('#tab-bar .tab') : null;
    const refocusId = focusedEl && focusedEl.dataset.tabId != null ? Number(focusedEl.dataset.tabId) : null;
    bar.innerHTML = '';
    // Hide the bar entirely with 0–1 documents (no need for a single tab); the
    // body class shifts the viewer down to make room when it's shown.
    const show = sessions.length >= 2;
    bar.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-tabs', show);
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Open documents');
    if (!bar._touchGuard) { installTouchGuard(bar); bar._touchGuard = true; }
    if (show) {
      sessions.forEach((s, i) => {
        const isActive = s.id === activeId;
        const name = (isActive ? App.state.fileName : s.state.fileName) || 'PDF';
        const dirty = isActive ? App.state.dirty : s.state.dirty;
        const tab = document.createElement('div');
        tab.className = 'tab' + (isActive ? ' active' : '');
        tab.title = name;
        tab.dataset.tabId = String(s.id);
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        // Position is spoken aloud, so a screen-reader user hears a move land.
        tab.setAttribute('aria-label',
          `${name}${dirty ? ', unsaved changes' : ''}, tab ${i + 1} of ${sessions.length}`);
        // Roving tabindex: one stop for the whole strip, arrows walk within it.
        tab.tabIndex = isActive ? 0 : -1;
        tab.addEventListener('click', () => { if (!swallowClick) T.switchTo(s.id); });
        // Right-click → tab actions (rearrange, Open in New Window).
        tab.addEventListener('contextmenu', (e) => {
          if (touchDrag && touchDrag.active) { e.preventDefault(); return; } // long-press is a grab here
          e.preventDefault();
          showTabMenu(e.clientX, e.clientY, s.id);
        });

        // Keyboard: arrows walk the strip, and with Ctrl/Cmd+Shift they carry
        // the tab along instead — the no-pointer equivalent of dragging it.
        tab.addEventListener('keydown', (e) => {
          const rearrange = (e.ctrlKey || e.metaKey) && e.shiftKey;
          const ids = orderIds();
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const dir = e.key === 'ArrowRight' ? 1 : -1;
            if (rearrange) { T.move(s.id, dir); return; }
            const at = ids.indexOf(s.id) + dir;
            if (at >= 0 && at < ids.length) focusTabEl(ids[at]);
            return;
          }
          if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            if (rearrange) { T.moveToEdge(s.id, e.key === 'Home' ? 'start' : 'end'); return; }
            focusTabEl(e.key === 'Home' ? ids[0] : ids[ids.length - 1]);
            return;
          }
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); T.switchTo(s.id); return; }
          if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); requestClose(s.id); }
        });

        // Touch: press and hold to pick the tab up, slide, lift to drop.
        tab.addEventListener('pointerdown', (e) => onTabPointerDown(e, s.id, tab));
        tab.addEventListener('pointermove', onTabPointerMove);
        tab.addEventListener('pointerup', onTabPointerUp);
        tab.addEventListener('pointercancel', endTouchDrag);

        // Drag to reorder. Order in `sessions` drives the tab order, so a drop
        // just splices the dragged tab before/after the tab under the cursor
        // (left half → before, right half → after).
        tab.draggable = true;
        tab.addEventListener('dragstart', (e) => {
          dragId = s.id;
          tab.classList.add('dragging');
          bar.classList.add('reordering');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(s.id)); } catch (_) { /* IE/Safari quirk */ }
          }
        });
        tab.addEventListener('dragend', (e) => {
          const draggedId = dragId;
          dragId = null;
          bar.classList.remove('reordering');
          tabEls().forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after'));
          // Dragged clean out of the window → tear the tab off into its own
          // window. (A drop back inside the strip is a reorder, handled below.)
          if (draggedId != null && T.canTearOff() && e.screenX != null) {
            const outside = e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth ||
              e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
            if (outside) T.tearOff(s.id);
          }
        });
        tab.addEventListener('dragover', (e) => {
          if (dragId == null || dragId === s.id) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          autoScroll(e.clientX);
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
          const moved = dragId;
          dragId = null;          // a completed drop is not a tear-off, whatever dragend sees next
          clearDropMarks();
          T.reorder(moved, s.id, before);
        });
        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = (dirty ? '• ' : '') + name;
        tab.appendChild(label);
        const close = document.createElement('button');
        close.className = 'tab-close';
        close.innerHTML = App.icon('close');
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

      // Dropping in the empty run past the last tab (or on the + button) is the
      // natural way to say "put it at the end" — without this the gap is dead
      // space and the drag springs back for no visible reason.
      if (!bar._stripDrop) {
        bar._stripDrop = true;
        bar.addEventListener('dragover', (e) => {
          if (dragId == null || e.target.closest('.tab')) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        });
        bar.addEventListener('drop', (e) => {
          if (dragId == null || e.target.closest('.tab')) return;
          e.preventDefault();
          const moved = dragId;
          dragId = null;
          clearDropMarks();
          T.moveToEdge(moved, 'end');
        });
      }

      // Hand focus back to the tab that had it before the rebuild.
      if (refocusId != null) focusTabEl(refocusId);
    }
  }

  App.Tabs = T;
})();
