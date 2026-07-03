'use strict';

/* Top-level wiring: toolbar, open/drop, modes, keyboard shortcuts. */
(function () {
  const DEFAULT_SIG_WIDTH_PT = 200;
  const DEFAULT_INITIALS_WIDTH_PT = 90;

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
      : mode === 'initials' ? 'initials' : 'date';
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
          ['#update-modal', '#upd-close'], ['#confirm-modal', '#confirm-no']
        ].find(([m]) => { const el = App.$(m); return el && !el.classList.contains('hidden'); });
        if (open) { e.preventDefault(); const btn = App.$(open[1]); if (btn) btn.click(); return; }
      }
      // Let the signature modal handle its own remaining keys.
      if (!App.$('#sig-modal').classList.contains('hidden')) return;

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

    // ink press-drag-release
    container.addEventListener('mousedown', (e) => {
      if (App.state.mode !== 'markup' || App.Markup.tool !== 'ink') return;
      const pl = pageLayerFor(e);
      if (!pl) return;
      e.preventDefault();
      App.Markup.inkStart(pl.page, pl.layer, e);
    });
    window.addEventListener('mouseup', () => { if (App.Markup) App.Markup.inkEnd(); });

    // live preview (measure + markup)
    container.addEventListener('mousemove', (e) => {
      const pl = pageLayerFor(e);
      if (!pl) return;
      if (App.state.mode === 'measure') App.Measure.handleMove(pl.page, pl.layer, e);
      else if (App.state.mode === 'markup') App.Markup.handleMove(pl.page, pl.layer, e);
    });

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

  async function initVersionBadge() {
    try {
      const v = await window.api.getVersion();
      App.$('#btn-updates').textContent = 'v' + v;
      App.$('#btn-updates').title = `Version ${v} — click to check for updates`;
    } catch (_) { /* ignore */ }
  }

  function showUpdateModal(res) {
    App.$('#upd-msg').textContent =
      `A new version (v${res.latest}) is available. You have v${res.current}.`;
    App.$('#upd-notes').textContent = (res.notes || '').trim() || 'No release notes.';
    App.$('#update-modal').classList.remove('hidden');
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
    App.$('#upd-download').addEventListener('click', () => {
      if (latestUpdate) window.api.openExternal(latestUpdate.url);
      App.$('#update-modal').classList.add('hidden');
    });
    initVersionBadge();
    // quiet check shortly after launch
    setTimeout(() => checkForUpdates(false), 3000);
  }

  function boot() {
    setupTheme();
    // Stamp today's date into the empty-state title block.
    const tbDate = App.$('#tb-date');
    if (tbDate) tbDate.textContent = App.todayFormatted();
    App.Signature.init();
    App.Measure.init();
    App.Markup.init();
    setupUpdates();
    setupDragDrop();
    setupKeys();
    setupPlacementClicks();
    setupMeasureMenu();
    setupMarkupMenu();
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

    App.$('#btn-zoom-in').addEventListener('click', () => App.Viewer.zoomIn());
    App.$('#btn-zoom-out').addEventListener('click', () => App.Viewer.zoomOut());
    App.$('#btn-fit-width').addEventListener('click', () => App.Viewer.fitWidth());
    App.$('#btn-prev').addEventListener('click', () => App.Viewer.prev());
    App.$('#btn-next').addEventListener('click', () => App.Viewer.next());
    App.$('#page-input').addEventListener('change', (e) =>
      App.Viewer.goToPage(parseInt(e.target.value, 10) || 1));

    // "Open with" / command-line file.
    window.api.onOpenFilePath((p) => openFromPath(p));

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
