'use strict';

/* Top-level wiring: toolbar, open/drop, modes, keyboard shortcuts. */
(function () {
  const DEFAULT_SIG_WIDTH_PT = 200;
  const DEFAULT_INITIALS_WIDTH_PT = 90;

  // On the Electron desktop build the native application menu owns the Cmd/Ctrl
  // accelerators (Open/Save/Find/Undo/…). The in-page keyboard handler below
  // then skips those combos so they don't fire twice.
  const IS_DESKTOP = !!(window.api && window.api.isDesktop);

  // ---------- Mode / banner ----------
  App.setMode = function (mode, kind) {
    const prev = App.state.mode;
    App.state.mode = mode;
    document.body.classList.toggle('tool-active', !!mode);
    const banner = App.$('#mode-banner');
    const textEl = App.$('#mode-banner-text');

    // leaving measure/markup mode -> commit/clean up any in-progress drawing
    if (prev === 'measure' && mode !== 'measure' && App.Measure) App.Measure.stop();
    if (prev === 'markup' && mode !== 'markup' && App.Markup) App.Markup.stop();

    // toolbar armed highlight. Select is the resting tool — it lights up
    // whenever no drawing/placement tool is armed, so clicking anything on the
    // page selects it (to move, resize, delete, or nudge).
    const selBtn = App.$('#btn-select');
    if (selBtn) selBtn.classList.toggle('armed', !mode);
    App.$('#btn-sign').classList.toggle('armed', mode === 'signature');
    App.$('#btn-initials').classList.toggle('armed', mode === 'initials');
    App.$('#btn-date').classList.toggle('armed', mode === 'date');
    App.$('#btn-measure').classList.toggle('armed', mode === 'measure');
    App.$('#btn-markup').classList.toggle('armed', mode === 'markup');
    // Keep the right-hand markup rail's per-tool highlight in step.
    if (App.MarkupRail) App.MarkupRail.sync();

    // remove any previously injected "new" link
    const existing = document.getElementById('mode-new');
    if (existing) existing.remove();

    // A tappable "Finish shape" for measure/markup — the touch-friendly
    // equivalent of pressing Enter (or double-tapping) to close a polyline/polygon.
    App.$('#mode-finish').classList.toggle('hidden', !(mode === 'measure' || mode === 'markup'));

    if (!mode) {
      banner.classList.add('hidden');
      document.body.classList.remove('has-banner');
      App.Placement.disarm();
      App.refreshChrome();
      return;
    }

    if (mode === 'measure' || mode === 'markup') {
      textEl.textContent = mode === 'markup'
        ? 'Markup — draw on the page. Enter finishes a shape, Esc stops.'
        : 'Measuring — press Enter to finish a shape, Esc to stop.';
      banner.classList.remove('hidden');
      document.body.classList.add('has-banner');
      App.refreshChrome();
      return;
    }

    const label = mode === 'signature' ? 'signature'
      : mode === 'initials' ? 'initials'
        : mode === 'stamp' ? 'stamp' : 'date';
    textEl.textContent = `Click on the page where the ${label} should go.`;
    banner.classList.remove('hidden');
    document.body.classList.add('has-banner');

    // Offer to recreate the remembered signature/initials.
    if (mode === 'signature' || mode === 'initials') {
      const link = document.createElement('button');
      link.id = 'mode-new';
      link.className = 'link-btn';
      link.textContent = mode === 'initials' ? 'Create new initials' : 'Create new signature';
      link.addEventListener('click', () => openCreateThenArm(mode));
      App.$('#mode-cancel').before(link);
    }
    App.refreshChrome();
  };

  // Show the markup properties bar during markup mode or when an item is selected.
  App.refreshChrome = function () {
    const show = App.state.mode === 'markup' || App.state.annoSelectedId != null;
    App.$('#markup-props').classList.toggle('hidden', !show);
    document.body.classList.toggle('has-props', show);
  };

  // ---------- Arm an image (signature/initials) ----------
  function armImage(kind, creation) {
    App.Placement.arm({
      type: 'image',
      dataUrl: creation.dataUrl,
      aspect: creation.aspect,
      defaultWidthPt: kind === 'initials' ? DEFAULT_INITIALS_WIDTH_PT : DEFAULT_SIG_WIDTH_PT
    });
    App.setMode(kind);
  }

  async function openCreateThenArm(kind) {
    const creation = await App.Signature.open(kind);
    if (!creation) return; // cancelled
    if (kind === 'initials') App.state.lastInitials = creation;
    else App.state.lastSignature = creation;
    // Remember it on this computer so "Sign"/"Initials" re-places it next launch
    // without redrawing (App.Prefs persists to localStorage).
    if (App.Prefs) { try { App.Prefs.set(kind === 'initials' ? 'lastInitials' : 'lastSignature', creation); } catch (_) { /* quota */ } }
    armImage(kind, creation);
  }

  // Restore a remembered signature/initials image from a previous session.
  function loadRememberedSignatures() {
    if (!App.Prefs) return;
    const sig = App.Prefs.get('lastSignature', null);
    const ini = App.Prefs.get('lastInitials', null);
    if (sig && sig.dataUrl) App.state.lastSignature = sig;
    if (ini && ini.dataUrl) App.state.lastInitials = ini;
  }

  // Sign / Initials button: reuse remembered creation, else open modal.
  async function startImagePlacement(kind) {
    if (!App.state.pdfDoc) return;
    const remembered = kind === 'initials' ? App.state.lastInitials : App.state.lastSignature;
    if (remembered) armImage(kind, remembered);
    else openCreateThenArm(kind);
  }

  function startDatePlacement() {
    if (!App.state.pdfDoc) return;
    App.Placement.arm({ type: 'date' });
    App.setMode('date');
  }

  // Build the exported PDF (all edits baked in) and hand it to the platform's
  // print path. Shared by the native File → Print menu and the Ctrl/Cmd+P key.
  async function doPrint() {
    if (!App.state.pdfDoc) return;
    let bytes;
    try {
      bytes = await App.Save.buildBytes();
    } catch (e) {
      App.toast('Could not prepare print: ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    // Show the pages that will print (rendered from the exported bytes) and let
    // the user confirm, narrow to a page range, or back out before we hand
    // anything to the printer.
    let printBytes = bytes;
    if (App.Print && App.Print.preview) {
      const sel = await App.Print.preview(bytes, App.state.currentPage);
      if (!sel) return;
      // Narrow to just the chosen pages (a no-op when all pages are selected).
      try {
        printBytes = await App.Print.buildSubset(bytes, sel.pages, sel.total);
      } catch (e) {
        App.toast('Could not select those pages: ' + (e && e.message ? e.message : e), 'error');
        return;
      }
    }
    try {
      // Hand the finished PDF to the platform's printer: the native system print
      // dialog on desktop (Windows/macOS/Linux print it from a hidden window so
      // the OS printer picker pops up directly), the system print or a new tab on
      // Android/web. Each provides a working print preview + printer picker.
      const res = await window.api.print(printBytes);
      if (res && res.ok === false) {
        App.toast('Could not print: ' + (res.error || 'unknown error'), 'error');
        return;
      }
      // The browser path opens the print dialog directly; the desktop / native
      // path hands off to the system PDF viewer to print from there.
      App.toast(res && res.dialog
        ? 'Opening the print dialog…'
        : 'Opened in your PDF viewer — print from there.', 'info', 3000);
    } catch (e) {
      App.toast('Could not print: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  // ---------- Open a PDF ----------
  // Multi-select: each chosen PDF opens as its own tab, in the order the dialog
  // reports them (drag the tabs to rearrange afterwards). Falls back to the
  // single-file dialog when the platform doesn't expose the multi variant.
  async function openViaDialog() {
    const res = window.api.openPdfDialogMulti
      ? await window.api.openPdfDialogMulti()
      : await window.api.openPdfDialog();
    if (!res) return;
    const list = Array.isArray(res) ? res : [res];
    let failed = 0;
    // Sequential: App.Viewer.load snapshots/activates App.state per document, so
    // awaiting each keeps the tab order and per-tab state consistent.
    for (const r of list) {
      if (r && r.ok) await App.Viewer.load(r.data, r.name, r.path);
      else failed++;
    }
    if (failed) App.toast(`Could not read ${failed} file${failed > 1 ? 's' : ''}.`, 'error');
  }

  async function openFromPath(filePath) {
    const res = await window.api.readPdf(filePath);
    if (!res || !res.ok) {
      App.toast('Could not read file' + (res ? ': ' + res.error : ''), 'error');
      return;
    }
    App.Viewer.load(res.data, res.name, res.path);
  }

  // ---------- Drag & drop ----------
  function setupDragDrop() {
    const overlay = App.$('#drop-overlay');
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      overlay.classList.remove('hidden');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlay.classList.add('hidden');
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.add('hidden');
      const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!dropped.length) return;
      // Drop several PDFs at once → open every one as its own tab. Non-PDFs are
      // skipped (and reported), so a mixed drop still opens the PDFs it contained.
      const pdfs = dropped.filter((f) => /\.pdf$/i.test(f.name));
      if (!pdfs.length) {
        App.toast('Please drop a .pdf file.', 'error');
        return;
      }
      // Sequential: App.Viewer.load snapshots/activates App.state per document,
      // so awaiting each keeps tab order and per-tab state consistent.
      for (const file of pdfs) {
        // Prefer the real path (keeps the original untouched); else read bytes.
        if (file.path) await openFromPath(file.path);
        else await App.Viewer.load(await file.arrayBuffer(), file.name, null);
      }
      const skipped = dropped.length - pdfs.length;
      if (skipped) App.toast(`Skipped ${skipped} non-PDF file${skipped > 1 ? 's' : ''}.`, 'error');
    });
  }

  // ---------- Keyboard shortcuts ----------
  function inEditable(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.isContentEditable);
  }

  // ---- In-app clipboard: copy / paste / duplicate a placed object across the
  // three layers. Distinct from the OS clipboard (which copies selected PDF
  // *text*). Holds a deep clone of a placement, markup, or measurement.
  let _clip = null;
  const OBJ_LAYERS = [
    { kind: 'placement', idKey: 'selectedId', mod: () => App.Placement },
    { kind: 'markup', idKey: 'annoSelectedId', mod: () => App.Markup },
    { kind: 'measure', idKey: 'measureSelectedId', mod: () => App.Measure }
  ];
  function selectedLayer() { return OBJ_LAYERS.find((L) => App.state[L.idKey] != null) || null; }
  function clearObjectSelection() {
    App.Placement.deselect(); App.Markup.deselect();
    if (App.state.measureSelectedId != null) { App.state.measureSelectedId = null; App.Measure.repositionAll(); }
  }
  function copySelectedObject() {
    const L = selectedLayer(); if (!L) return false;
    const obj = L.mod().getSelected && L.mod().getSelected();
    if (!obj) return false;
    _clip = { kind: L.kind, data: JSON.parse(JSON.stringify(obj)) };
    return true;
  }
  function pasteObject() {
    if (!_clip) return false;
    const L = OBJ_LAYERS.find((x) => x.kind === _clip.kind); if (!L) return false;
    clearObjectSelection();
    const OFF = 14; // viewport points, so the copy sits just off the original
    const id = L.mod().paste(JSON.parse(JSON.stringify(_clip.data)), OFF, OFF);
    if (id == null) return false;
    // Cascade repeated pastes: the next one offsets from the item just dropped.
    const dropped = L.mod().getSelected && L.mod().getSelected();
    if (dropped) _clip.data = JSON.parse(JSON.stringify(dropped));
    App.$('#btn-save').disabled = false;
    return true;
  }
  // Shottr-style single-key tool switching: bare letter arms a markup tool
  // instantly (no menu), and the tool stays armed after each draw so you can drop
  // several in a row. `v` is the resting Select/move tool (disarm everything).
  // `r` is intentionally absent — it stays bound to Rotate page. Guarded by
  // inEditable() so these never fire while typing in a field or a text box.
  const MARKUP_KEYS = {
    v: null, a: 'arrow', l: 'line', b: 'rect', o: 'ellipse',
    p: 'ink', h: 'highlight', t: 'text', c: 'callout'
  };
  function setupKeys() {
    window.addEventListener('keydown', (e) => {
      // Escape closes whichever modal is open (via its cancel/close button, so
      // any pending promise resolves cleanly).
      if (e.key === 'Escape') {
        const open = [
          ['#sig-modal', '#sig-cancel'], ['#scale-modal', '#scale-cancel'],
          ['#update-modal', '#upd-close'], ['#confirm-modal', '#confirm-no'],
          ['#docstamp-modal', '#ds-cancel'], ['#shortcuts-modal', '#sc-close'],
          ['#digisign-modal', '#dsig-close'], ['#compare-modal', '#cmp-close'],
          ['#printprev-modal', '#pp-cancel']
        ].find(([m]) => { const el = App.$(m); return el && !el.classList.contains('hidden'); });
        if (open) { e.preventDefault(); const btn = App.$(open[1]); if (btn) btn.click(); return; }
      }
      // Let the signature modal handle its own remaining keys.
      if (!App.$('#sig-modal').classList.contains('hidden')) return;

      // On desktop these Cmd/Ctrl combos are the native menu's accelerators —
      // skip them here so a single keystroke doesn't trigger the action twice.
      if (!IS_DESKTOP) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
          e.preventDefault(); openViaDialog(); return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (App.$('#btn-save').disabled) return;
          if (e.shiftKey) App.Save.saveAs();
          else App.Save.save();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
          e.preventDefault(); doPrint(); return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          if (App.state.pdfDoc) { e.preventDefault(); App.Viewer.openFind(); }
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) App.Markup.redo(); else App.Markup.undo();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
          e.preventDefault(); App.Markup.redo(); return;
        }
      }
      if (inEditable(e.target)) return;

      // Copy / paste / duplicate the selected placed object (text box, image,
      // markup, measurement). An in-app clipboard — PDF-text copy stays native.
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'c') {
          const winSel = window.getSelection();
          if (winSel && !winSel.isCollapsed && String(winSel).trim()) return; // copying PDF text
          if (copySelectedObject()) { e.preventDefault(); App.toast('Copied', 'info', 1200); }
          return;
        }
        if (k === 'v') {
          if (pasteObject()) { e.preventDefault(); App.toast('Pasted', 'success', 1200); }
          return;
        }
        if (k === 'd') {
          e.preventDefault();
          if (copySelectedObject() && pasteObject()) App.toast('Duplicated', 'success', 1200);
          return;
        }
      }

      // '?' (Shift+/) or F1 opens the keyboard-shortcuts help on any platform.
      if (e.key === '?' || e.key === 'F1') { e.preventDefault(); App.Shortcuts.open(); return; }

      if (e.key === 'Enter' && App.state.mode === 'measure') { e.preventDefault(); App.Measure.finishDrawing(); return; }
      if (e.key === 'Enter' && App.state.mode === 'markup') { e.preventDefault(); App.Markup.finishDrawing(); return; }
      if (e.key === 'Escape') {
        if (App.Markup && App.Markup.textTool) App.Markup.stopTextMarkup();
        else if (App.state.mode === 'measure' && App.Measure._active) App.Measure.cancelActive();
        else if (App.state.mode === 'markup' && App.Markup.active) App.Markup.cancelActive();
        else if (App.state.mode) App.setMode(null);
        else { App.Placement.deselect(); App.Markup.deselect(); }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (App.state.selectedId != null) { e.preventDefault(); App.Placement.remove(App.state.selectedId); return; }
        if (App.state.measureSelectedId != null) { e.preventDefault(); App.Measure.remove(App.state.measureSelectedId); return; }
        if (App.state.annoSelectedId != null) { e.preventDefault(); App.Markup.remove(App.state.annoSelectedId); return; }
      }
      // Arrow keys nudge the selected item (Shift = ×10); otherwise fall through
      // to page navigation below.
      if (e.key.indexOf('Arrow') === 0) {
        const sel = App.state.selectedId != null ? 'placement'
          : App.state.annoSelectedId != null ? 'markup'
            : App.state.measureSelectedId != null ? 'measure' : null;
        if (sel) {
          e.preventDefault();
          const s = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0;
          const dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
          if (sel === 'placement') App.Placement.nudge(dx, dy);
          else if (sel === 'markup') App.Markup.nudge(dx, dy);
          else App.Measure.nudge(dx, dy);
          return;
        }
      }
      if (!App.state.pdfDoc) return;
      // Single-key markup tool switching (bare keys only — modifiers stay
      // reserved for app/OS commands). A single character key that maps to a tool
      // arms it and consumes the event.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        const mk = MARKUP_KEYS[e.key.toLowerCase()];
        if (mk !== undefined) {
          e.preventDefault();
          if (App.Markup.textTool) App.Markup.stopTextMarkup();
          if (mk === null) { App.setMode(null); App.toast('Select / move tool', 'info', 1500); }
          else App.Markup.startTool(mk);
          return;
        }
      }
      // Backslash toggles the side-by-side split pane.
      if (e.key === '\\' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); if (App.SplitView) App.SplitView.toggle(); return;
      }
      if (e.key === '+' || e.key === '=') { App.Viewer.zoomIn(); }
      else if (e.key === '-' || e.key === '_') { App.Viewer.zoomOut(); }
      else if (e.key === '0') { App.Viewer.resetZoom(); }
      else if (e.key === 'r' || e.key === 'R') { App.Viewer.rotate(90); }
      else if (e.key === 'PageDown' || e.key === 'ArrowRight') { App.Viewer.next(); }
      else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { App.Viewer.prev(); }
    });
  }

  // ---------- Placement click delegation ----------
  // Resolve the page number + markup layer for an event inside the viewer.
  function pageLayerFor(e) {
    const pageDiv = e.target.closest('.page');
    if (!pageDiv) return null;
    const page = parseInt(pageDiv.dataset.pageNumber, 10);
    const layer = pageDiv.querySelector('.markup-layer');
    if (!page || !layer) return null;
    return { page, layer };
  }

  function setupPlacementClicks() {
    const container = App.$('#viewer');
    container.addEventListener('click', (e) => {
      if (e.target.closest('.placed') || e.target.closest('.hit') || e.target.closest('.handle')) return;
      const pl = pageLayerFor(e);
      if (!pl) return;
      if (App.state.mode === 'markup') {
        App.Markup.handleClick(pl.page, pl.layer, e);
      } else if (App.state.mode === 'measure') {
        App.Measure.handleClick(pl.page, pl.layer, e);
      } else if (App.state.mode) {
        App.Placement.handleOverlayClick(pl.page, pl.layer, e);
      } else {
        App.Placement.deselect();
        App.Markup.deselect();
      }
    });

    // Freehand press-drag-release (ink + highlight) — pointer events so touch/pen
    // work, not just mouse.
    container.addEventListener('pointerdown', (e) => {
      if (App.state.mode !== 'markup' || !App.Markup.isFreehand(App.Markup.tool)) return;
      const pl = pageLayerFor(e);
      if (!pl) return;
      e.preventDefault();
      App.Markup.inkStart(pl.page, pl.layer, e);
    });
    window.addEventListener('pointerup', () => { if (App.Markup) App.Markup.inkEnd(); });
    window.addEventListener('pointercancel', () => { if (App.Markup) App.Markup.inkEnd(); });

    // live preview (measure + markup) + ink drag. Prevent the WebView from
    // stealing an ink drag as a page scroll while freehand drawing.
    container.addEventListener('pointermove', (e) => {
      const pl = pageLayerFor(e);
      if (!pl) return;
      if (App.Markup && App.Markup.inkDrawing) e.preventDefault();
      if (App.state.mode === 'measure') App.Measure.handleMove(pl.page, pl.layer, e);
      else if (App.state.mode === 'markup') App.Markup.handleMove(pl.page, pl.layer, e);
    }, { passive: false });

    // double-click finishes a polyline/polygon
    container.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (App.state.mode === 'measure') App.Measure.finishDrawing();
      else if (App.state.mode === 'markup') App.Markup.finishDrawing();
    });
  }

  function setupFind() {
    const input = App.$('#find-input');
    input.addEventListener('input', () => App.Viewer.find(input.value, false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); App.Viewer.find(input.value, e.shiftKey); }
      if (e.key === 'Escape') { e.preventDefault(); App.Viewer.closeFind(); }
    });
    App.$('#find-next').addEventListener('click', () => App.Viewer.find(input.value, false));
    App.$('#find-prev').addEventListener('click', () => App.Viewer.find(input.value, true));
    App.$('#find-close').addEventListener('click', () => App.Viewer.closeFind());
  }

  // ---------- Boot ----------
  function setupMeasureMenu() {
    const btn = App.$('#btn-measure');
    const menu = App.$('#measure-menu');
    const close = () => menu.classList.add('hidden');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      menu.classList.toggle('hidden');
    });
    menu.querySelectorAll('button[data-mtool]').forEach((b) => {
      b.addEventListener('click', () => {
        close();
        const tool = b.dataset.mtool;
        if (tool === 'toggle-panel') App.Measure.togglePanel();
        else App.Measure.startTool(tool);
      });
    });
    // close menu on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tb-dropdown')) close();
    });
  }

  function setupMarkupMenu() {
    const btn = App.$('#btn-markup');
    const menu = App.$('#markup-menu');
    const close = () => menu.classList.add('hidden');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      menu.classList.toggle('hidden');
    });
    menu.querySelectorAll('button[data-mk]').forEach((b) => {
      b.addEventListener('click', () => {
        close();
        const mk = b.dataset.mk;
        if (mk === '__list') App.MarkupPanel.toggle();
        else if (App.Markup.isTextTool && App.Markup.isTextTool(mk)) App.Markup.startTextMarkup(mk);
        else App.Markup.startTool(mk);
      });
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.tb-dropdown')) close(); });
    App.$('#mk-undo').addEventListener('click', () => App.Markup.undo());
    App.$('#mk-redo').addEventListener('click', () => App.Markup.redo());
  }

  // Right-hand markup rail (Bluebeam-style): a compact, always-visible strip of
  // one-click drawing tools. Each icon runs the same App.Markup entry points as
  // the left-rail dropdown, so behaviour is identical — this is a faster surface,
  // not a second implementation. Exposed as App.MarkupRail so setMode() and the
  // e2e harness can keep the armed highlight in sync with the active tool.
  function setupMarkupRail() {
    const rail = App.$('#markup-rail');
    const reopen = App.$('#mr-reopen');
    if (!rail) return;
    const PREF = 'markupRailOff';

    const applyVisible = (off) => {
      document.body.classList.toggle('markup-rail-off', off);
      const t = App.$('#mr-toggle');
      if (t) { t.title = 'Hide markup toolbar'; t.setAttribute('aria-expanded', String(!off)); }
    };
    applyVisible(App.Prefs && App.Prefs.get(PREF, false) === true);

    const setOff = (off) => { applyVisible(off); if (App.Prefs) App.Prefs.set(PREF, off); };
    const tgl = App.$('#mr-toggle');
    if (tgl) tgl.addEventListener('click', () => setOff(true));
    if (reopen) reopen.addEventListener('click', () => setOff(false));

    rail.querySelectorAll('.mr-btn').forEach((b) => {
      b.addEventListener('click', () => {
        if (!App.state.pdfDoc) return;
        const mr = b.dataset.mr, mk = b.dataset.mk;
        if (mr === 'select') { App.setMode(null); }
        else if (mr === 'undo') { App.Markup.undo(); }
        else if (mr === 'redo') { App.Markup.redo(); }
        else if (mr === 'list') { App.MarkupPanel.toggle(); }
        else if (mk) {
          if (App.Markup.isTextTool && App.Markup.isTextTool(mk)) App.Markup.startTextMarkup(mk);
          else App.Markup.startTool(mk);
        }
        App.MarkupRail.sync();
      });
    });

    App.MarkupRail = {
      // Highlight whichever tool is currently armed (drawing tool, text-select
      // markup, or the resting Select state). Called from setMode().
      sync() {
        const drawTool = App.Markup && App.Markup.tool;
        const textTool = App.Markup && App.Markup.textTool;
        const markupMode = App.state.mode === 'markup';
        rail.querySelectorAll('.mr-btn').forEach((b) => {
          const mk = b.dataset.mk, mr = b.dataset.mr;
          let on = false;
          if (mk && markupMode && drawTool) on = (mk === drawTool);
          else if (mk && textTool) on = (mk === textTool);
          else if (mr === 'select') on = !App.state.mode && !textTool;
          b.classList.toggle('armed', on);
        });
      }
    };
    App.MarkupRail.sync();
  }

  // Document tools live under one dropdown (Organize / Stamps / Tool Chest) so
  // the rail stays compact — especially on the mobile bottom bar.
  function setupDocumentMenu() {
    const btn = App.$('#btn-document');
    const menu = App.$('#document-menu');
    if (!btn || !menu) return;
    const close = () => menu.classList.add('hidden');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      menu.classList.toggle('hidden');
    });
    menu.querySelectorAll('button[data-doc]').forEach((b) => {
      b.addEventListener('click', () => {
        close();
        const d = b.dataset.doc;
        if (d === 'organize') App.Organize.toggle();
        else if (d === 'stamp') App.DocStamp.open();
        else if (d === 'chest') App.ToolChest.toggle();
        else if (d === 'digisign') App.DigiSign.open();
        else if (d === 'compare') App.Compare.open();
        else if (d === 'overlay') App.Overlay.open();
        else if (d === 'split') App.SplitView.toggle();
      });
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.tb-dropdown')) close(); });
  }

  // Collapse the left tool rail to an icon-only strip (desktop). The armed
  // tool's tooltip keeps every action quick to reach; state is remembered.
  function setupRailToggle() {
    const btn = App.$('#rail-toggle');
    if (!btn) return;
    const apply = (collapsed) => {
      document.body.classList.toggle('rail-collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = collapsed ? 'Expand toolbar' : 'Collapse toolbar';
      btn.setAttribute('aria-label', btn.title);
      const ico = btn.querySelector('.rail-toggle-ico');
      if (ico) ico.textContent = collapsed ? '»' : '«';
    };
    apply(App.Prefs && App.Prefs.get('railCollapsed', false) === true);
    btn.addEventListener('click', () => {
      const collapsed = !document.body.classList.contains('rail-collapsed');
      apply(collapsed);
      if (App.Prefs) App.Prefs.set('railCollapsed', collapsed);
    });
  }

  // ---------- Mobile top-bar overflow ----------
  // On narrow screens the top bar can't hold every control, so the secondary
  // ones (marked data-overflow in the HTML) are physically moved into a "⋯"
  // dropdown. We relocate the real nodes — not copies — so their existing event
  // wiring keeps working and desktop layout is untouched. Each node remembers
  // its home (parent + next sibling) so it snaps back exactly when the viewport
  // widens again.
  function setupMobileOverflow() {
    const moreBtn = App.$('#btn-more');
    const menu = App.$('#more-menu');
    if (!moreBtn || !menu) return;
    const mq = window.matchMedia('(max-width: 820px)');
    const nodes = Array.from(document.querySelectorAll('#toolbar [data-overflow]'));
    nodes.forEach((n) => { n._home = { parent: n.parentNode, next: n.nextSibling }; });

    const closeMenu = () => { menu.classList.add('hidden'); moreBtn.setAttribute('aria-expanded', 'false'); };

    function apply() {
      if (mq.matches) {
        // Collapse: move secondary controls into the dropdown (in DOM order).
        nodes.forEach((n) => menu.appendChild(n));
      } else {
        // Expand: return each control to its original slot, then hide the menu.
        nodes.forEach((n) => n._home.parent.insertBefore(n, n._home.next));
        closeMenu();
      }
    }

    // matchMedia fires on rotation / window resize (and the Android split-screen).
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else mq.addListener(apply); // older WebView fallback
    apply();

    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden');
      moreBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    // Tapping an action button inside the sheet runs it and dismisses the sheet;
    // taps on the page-number input keep it open so the value can be edited.
    menu.addEventListener('click', (e) => {
      if (e.target.closest('button')) closeMenu();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.g-more')) closeMenu(); });
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const btn = App.$('#btn-theme');
    if (btn) {
      btn.textContent = theme === 'light' ? '☀' : '☾';
      btn.title = `Theme: ${theme} — click for ${theme === 'light' ? 'dark' : 'light'}`;
    }
  }
  function setupTheme() {
    // The inline <head> bootstrap already set data-theme before paint; mirror it
    // into the toggle button, then persist on change.
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    applyTheme(current);
    App.$('#btn-theme').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      applyTheme(next);
      if (App.Prefs) App.Prefs.set('theme', next);
    });
  }

  // ---------- Updates ----------
  let latestUpdate = null;
  // 'idle' → 'downloading' → 'ready'. Only meaningful on desktop; web/Android
  // always take the openExternal fallback so it stays 'idle'.
  let updState = 'idle';

  async function initVersionBadge() {
    try {
      const v = await window.api.getVersion();
      App.$('#btn-updates').textContent = 'v' + v;
      App.$('#btn-updates').title = `Version ${v} — click to check for updates`;
    } catch (_) { /* ignore */ }
  }

  function setDownloadBtn() {
    const b = App.$('#upd-download');
    if (updState === 'downloading') { b.disabled = true; b.textContent = 'Downloading…'; }
    else if (updState === 'ready') { b.disabled = false; b.textContent = 'Restart & Install'; }
    else { b.disabled = false; b.textContent = 'Download'; }
  }

  function showUpdateModal(res) {
    App.$('#upd-msg').textContent =
      `A new version (v${res.latest}) is available. You have v${res.current}.`;
    App.$('#upd-notes').textContent = (res.notes || '').trim() || 'No release notes.';
    setDownloadBtn();
    App.$('#update-modal').classList.remove('hidden');
  }

  // Download button: kick off an in-app download, restart to install once ready,
  // or fall back to opening the download page when self-install isn't available.
  async function onUpdateAction() {
    if (updState === 'ready') { window.api.installUpdate(); return; }
    if (updState === 'downloading') return;
    if (!latestUpdate) return;
    let r = null;
    try { r = await window.api.startUpdateDownload(); } catch (_) { r = null; }
    if (!r || !r.started) {
      window.api.openExternal(latestUpdate.url);          // web / macOS / dev / error
      App.$('#update-modal').classList.add('hidden');
      return;
    }
    updState = 'downloading';
    setDownloadBtn();
  }

  async function checkForUpdates(manual) {
    if (manual) App.toast('Checking for updates…', 'info', 1500);
    const res = await window.api.checkUpdates();
    if (!res || !res.ok) {
      if (manual) App.toast('Couldn\'t check for updates (are you online?).', 'error', 5000);
      return;
    }
    if (res.hasUpdate) {
      latestUpdate = res;
      const badge = App.$('#btn-updates');
      badge.classList.add('armed');
      badge.textContent = '⬆ Update';
      badge.title = `Update available: v${res.latest}`;
      showUpdateModal(res);
    } else if (manual) {
      App.toast(`You're up to date (v${res.current}).`, 'success', 3500);
    }
  }

  function setupUpdates() {
    App.$('#btn-updates').addEventListener('click', () => {
      if (latestUpdate) showUpdateModal(latestUpdate);
      else checkForUpdates(true);
    });
    App.$('#upd-close').addEventListener('click', () => App.$('#update-modal').classList.add('hidden'));
    App.$('#upd-later').addEventListener('click', () => App.$('#update-modal').classList.add('hidden'));
    App.$('#upd-download').addEventListener('click', onUpdateAction);

    // electron-updater lifecycle (desktop; no-ops elsewhere).
    window.api.onUpdateProgress((d) => {
      if (updState !== 'downloading') return;
      const pct = Math.max(0, Math.min(100, Math.round((d && d.percent) || 0)));
      App.$('#upd-download').textContent = 'Downloading… ' + pct + '%';
    });
    window.api.onUpdateDownloaded(() => {
      updState = 'ready';
      setDownloadBtn();
      App.toast('Update downloaded — click Restart & Install.', 'success', 6000);
    });
    window.api.onUpdateError(() => {
      if (updState === 'idle') return;
      updState = 'idle';
      setDownloadBtn();
      App.toast('Update download failed; opening the download page…', 'error', 5000);
      if (latestUpdate) window.api.openExternal(latestUpdate.url);
    });

    initVersionBadge();
    // quiet check shortly after launch
    setTimeout(() => checkForUpdates(false), 3000);
  }

  // ---------- Keyboard shortcuts help ----------
  // Each combo is an array of key tokens; multiple combos in a row are shown as
  // alternatives ("A / B"). 'mod' renders as ⌘ on macOS, Ctrl elsewhere. Tokens
  // are arrays (not '+'-joined strings) so a literal '+' key is unambiguous.
  const SHORTCUTS = [
    { title: 'File', rows: [
      { combos: [['mod', 'O']], label: 'Open PDF' },
      { combos: [['mod', 'S']], label: 'Save' },
      { combos: [['mod', 'Shift', 'S']], label: 'Save As…' },
      { combos: [['mod', 'P']], label: 'Print' }
    ] },
    { title: 'Editing', rows: [
      { combos: [['mod', 'Z']], label: 'Undo' },
      { combos: [['mod', 'Shift', 'Z']], label: 'Redo' },
      { combos: [['Enter']], label: 'Finish shape' },
      { combos: [['Arrows']], label: 'Nudge selected' },
      { combos: [['Shift', 'Arrows']], label: 'Nudge ×10' },
      { combos: [['mod', 'D']], label: 'Duplicate selected' },
      { combos: [['mod', 'C'], ['mod', 'V']], label: 'Copy / paste selected' },
      { combos: [['Delete']], label: 'Remove selected' },
      { combos: [['Esc']], label: 'Cancel / deselect' }
    ] },
    { title: 'Markup tools', rows: [
      { combos: [['V']], label: 'Select / move' },
      { combos: [['A']], label: 'Arrow' },
      { combos: [['L']], label: 'Line' },
      { combos: [['B']], label: 'Box (rectangle)' },
      { combos: [['O']], label: 'Oval (ellipse)' },
      { combos: [['P']], label: 'Pen (freehand)' },
      { combos: [['H']], label: 'Highlighter' },
      { combos: [['T'], ['C']], label: 'Text / callout' }
    ] },
    { title: 'View', rows: [
      { combos: [['mod', 'F']], label: 'Find' },
      { combos: [['+'], ['−'], ['0']], label: 'Zoom in / out / 100%' },
      { combos: [['mod', 'scroll']], label: 'Zoom to pointer' },
      { combos: [['\\']], label: 'Side by side' }
    ] },
    { title: 'Navigation', rows: [
      { combos: [['←'], ['→']], label: 'Previous / next page' },
      { combos: [['PageUp'], ['PageDown']], label: 'Page up / down' },
      { combos: [['?'], ['F1']], label: 'Show this help' }
    ] }
  ];

  function renderShortcuts() {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const mod = mac ? '⌘' : 'Ctrl';
    const body = App.$('#sc-body');
    body.innerHTML = '';
    SHORTCUTS.forEach((sec) => {
      const col = document.createElement('div');
      col.className = 'sc-sec';
      const h = document.createElement('h3');
      h.textContent = sec.title;
      col.appendChild(h);
      sec.rows.forEach((row) => {
        const el = document.createElement('div');
        el.className = 'sc-row';
        const lab = document.createElement('span');
        lab.className = 'sc-label';
        lab.textContent = row.label;
        const keys = document.createElement('span');
        keys.className = 'sc-keys';
        row.combos.forEach((combo, i) => {
          if (i) keys.appendChild(document.createTextNode(' / '));
          combo.forEach((tok) => {
            const k = document.createElement('kbd');
            k.textContent = tok === 'mod' ? mod : tok;
            keys.appendChild(k);
          });
        });
        el.appendChild(lab);
        el.appendChild(keys);
        col.appendChild(el);
      });
      body.appendChild(col);
    });
  }

  App.Shortcuts = {
    open() { App.$('#shortcuts-modal').classList.remove('hidden'); },
    close() { App.$('#shortcuts-modal').classList.add('hidden'); }
  };

  function setupShortcuts() {
    renderShortcuts();
    App.$('#sc-close').addEventListener('click', () => App.Shortcuts.close());
    App.$('#sc-ok').addEventListener('click', () => App.Shortcuts.close());
  }

  // ---------- Native-menu commands (desktop) ----------
  // The Electron main process forwards menu clicks here as command strings; map
  // each to the same action its toolbar button / shortcut already performs.
  function handleMenuCommand(cmd) {
    switch (cmd) {
      case 'open': openViaDialog(); break;
      case 'save': if (!App.$('#btn-save').disabled) App.Save.save(); break;
      case 'save-as': if (App.state.pdfDoc) App.Save.saveAs(); break;
      case 'print': doPrint(); break;
      case 'find': if (App.state.pdfDoc) App.Viewer.openFind(); break;
      case 'undo': App.Markup.undo(); break;
      case 'redo': App.Markup.redo(); break;
      case 'zoom-in': if (App.state.pdfDoc) App.Viewer.zoomIn(); break;
      case 'zoom-out': if (App.state.pdfDoc) App.Viewer.zoomOut(); break;
      case 'zoom-reset': if (App.state.pdfDoc) App.Viewer.resetZoom(); break;
      case 'fit-width': if (App.state.pdfDoc) App.Viewer.fitWidth(); break;
      case 'rotate': if (App.state.pdfDoc) App.Viewer.rotate(90); break;
      case 'split-view': if (App.SplitView) App.SplitView.toggle(); break;
      case 'tile-windows': if (window.api && window.api.tileSideBySide) window.api.tileSideBySide(); break;
      case 'toggle-theme': App.$('#btn-theme').click(); break;
      case 'check-updates': checkForUpdates(true); break;
      case 'shortcuts': App.Shortcuts.open(); break;
      case 'close-tab': if (App.Tabs) App.Tabs.requestCloseActive(); break;
      default: break;
    }
  }

  function boot() {
    setupTheme();
    // Stamp today's date into the empty-state title block.
    const tbDate = App.$('#tb-date');
    if (tbDate) tbDate.textContent = App.todayFormatted();
    App.Signature.init();
    App.Measure.init();
    App.Markup.init();
    if (App.Organize) App.Organize.init();
    if (App.DocStamp) App.DocStamp.init();
    if (App.ToolChest) App.ToolChest.init();
    if (App.DigiSign) App.DigiSign.init();
    if (App.Compare) App.Compare.init();
    if (App.Overlay) App.Overlay.init();
    if (App.SplitView) App.SplitView.init();
    if (App.TextCopy) App.TextCopy.init();
    loadRememberedSignatures();
    setupUpdates();
    setupShortcuts();
    setupDragDrop();
    setupKeys();
    setupPlacementClicks();
    setupMeasureMenu();
    setupMarkupMenu();
    setupMarkupRail();
    setupDocumentMenu();
    setupRailToggle();
    setupMobileOverflow();
    setupFind();
    App.Viewer.init();

    App.openViaDialog = openViaDialog;   // used by the tab bar "+" and native menu
    App.$('#btn-open').addEventListener('click', openViaDialog);
    App.$('#btn-open-empty').addEventListener('click', openViaDialog);
    // Select tool: disarm any drawing/placement tool so clicking the page
    // selects existing items instead of drawing new ones. Selection, drag,
    // resize, Delete and arrow-nudge already work in this state across markups,
    // measurements and placements — this button just makes it discoverable.
    App.$('#btn-select').addEventListener('click', () => {
      if (!App.state.pdfDoc) return;
      App.setMode(null);
      App.toast('Select — click any markup, measurement, or placement to move, resize, or delete it.', 'info', 3500);
    });
    App.$('#btn-sign').addEventListener('click', () => startImagePlacement('signature'));
    App.$('#btn-initials').addEventListener('click', () => startImagePlacement('initials'));
    App.$('#btn-date').addEventListener('click', startDatePlacement);
    App.$('#btn-save').addEventListener('click', () => App.Save.save());
    App.$('#btn-save-as').addEventListener('click', () => App.Save.saveAs());
    App.$('#mode-cancel').addEventListener('click', () => App.setMode(null));
    App.$('#mode-finish').addEventListener('click', () => {
      if (App.state.mode === 'measure') App.Measure.finishDrawing();
      else if (App.state.mode === 'markup') App.Markup.finishDrawing();
    });

    App.$('#btn-zoom-in').addEventListener('click', () => App.Viewer.zoomIn());
    App.$('#btn-zoom-out').addEventListener('click', () => App.Viewer.zoomOut());
    App.$('#btn-fit-width').addEventListener('click', () => App.Viewer.fitWidth());
    App.$('#btn-rotate').addEventListener('click', () => App.Viewer.rotate(90));
    App.$('#btn-prev').addEventListener('click', () => App.Viewer.prev());
    App.$('#btn-next').addEventListener('click', () => App.Viewer.next());
    App.$('#page-input').addEventListener('change', (e) =>
      App.Viewer.goToPage(parseInt(e.target.value, 10) || 1));

    // "Open with" / command-line file.
    window.api.onOpenFilePath((p) => openFromPath(p));

    // Native application-menu commands (desktop only; no-op elsewhere).
    window.api.onMenuCommand(handleMenuCommand);

    // A tab torn off from another window arrives here (desktop only).
    if (window.api.onOpenTearoff) {
      window.api.onOpenTearoff((payload) => { if (App.Tabs) App.Tabs.openTearoff(payload); });
    }

    // Now that the listener above is wired up, tell the main process we're ready.
    // It will deliver any file the app was launched to open (which may have
    // arrived before this listener existed).
    window.api.notifyReady();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
