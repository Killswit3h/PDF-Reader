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

    // toolbar armed highlight
    App.$('#btn-sign').classList.toggle('armed', mode === 'signature');
    App.$('#btn-initials').classList.toggle('armed', mode === 'initials');
    App.$('#btn-date').classList.toggle('armed', mode === 'date');
    App.$('#btn-measure').classList.toggle('armed', mode === 'measure');
    App.$('#btn-markup').classList.toggle('armed', mode === 'markup');

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
    armImage(kind, creation);
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
    App.toast('Preparing print…', 'info', 1500);
    try {
      const bytes = await App.Save.buildBytes();
      await window.api.print(bytes);
    } catch (e) {
      App.toast('Could not print: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  // ---------- Open a PDF ----------
  async function openViaDialog() {
    const res = await window.api.openPdfDialog();
    if (!res) return;
    if (!res.ok) { App.toast('Could not read file: ' + res.error, 'error'); return; }
    App.Viewer.load(res.data, res.name, res.path);
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
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (!/\.pdf$/i.test(file.name)) {
        App.toast('Please drop a .pdf file.', 'error');
        return;
      }
      // Prefer the real path (lets us keep the original untouched); else read bytes.
      if (file.path) {
        openFromPath(file.path);
      } else {
        const buf = await file.arrayBuffer();
        App.Viewer.load(buf, file.name, null);
      }
    });
  }

  // ---------- Keyboard shortcuts ----------
  function inEditable(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.isContentEditable);
  }
  function setupKeys() {
    window.addEventListener('keydown', (e) => {
      // Escape closes whichever modal is open (via its cancel/close button, so
      // any pending promise resolves cleanly).
      if (e.key === 'Escape') {
        const open = [
          ['#sig-modal', '#sig-cancel'], ['#scale-modal', '#scale-cancel'],
          ['#update-modal', '#upd-close'], ['#confirm-modal', '#confirm-no'],
          ['#docstamp-modal', '#ds-cancel']
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

      if (e.key === 'Enter' && App.state.mode === 'measure') { e.preventDefault(); App.Measure.finishDrawing(); return; }
      if (e.key === 'Enter' && App.state.mode === 'markup') { e.preventDefault(); App.Markup.finishDrawing(); return; }
      if (e.key === 'Escape') {
        if (App.state.mode === 'measure' && App.Measure._active) App.Measure.cancelActive();
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
      if (e.key === '+' || e.key === '=') { App.Viewer.zoomIn(); }
      else if (e.key === '-' || e.key === '_') { App.Viewer.zoomOut(); }
      else if (e.key === '0') { App.Viewer.resetZoom(); }
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

    // ink press-drag-release (pointer events so touch/pen work, not just mouse)
    container.addEventListener('pointerdown', (e) => {
      if (App.state.mode !== 'markup' || App.Markup.tool !== 'ink') return;
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
        if (b.dataset.mk === '__list') App.MarkupPanel.toggle();
        else App.Markup.startTool(b.dataset.mk);
      });
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.tb-dropdown')) close(); });
    App.$('#mk-undo').addEventListener('click', () => App.Markup.undo());
    App.$('#mk-redo').addEventListener('click', () => App.Markup.redo());
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
      });
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.tb-dropdown')) close(); });
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
      case 'toggle-theme': App.$('#btn-theme').click(); break;
      case 'check-updates': checkForUpdates(true); break;
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
    setupUpdates();
    setupDragDrop();
    setupKeys();
    setupPlacementClicks();
    setupMeasureMenu();
    setupMarkupMenu();
    setupDocumentMenu();
    setupFind();
    App.Viewer.init();

    App.$('#btn-open').addEventListener('click', openViaDialog);
    App.$('#btn-open-empty').addEventListener('click', openViaDialog);
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
    App.$('#btn-prev').addEventListener('click', () => App.Viewer.prev());
    App.$('#btn-next').addEventListener('click', () => App.Viewer.next());
    App.$('#page-input').addEventListener('change', (e) =>
      App.Viewer.goToPage(parseInt(e.target.value, 10) || 1));

    // "Open with" / command-line file.
    window.api.onOpenFilePath((p) => openFromPath(p));

    // Native application-menu commands (desktop only; no-op elsewhere).
    window.api.onMenuCommand(handleMenuCommand);

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
