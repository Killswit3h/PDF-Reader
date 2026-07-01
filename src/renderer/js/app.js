'use strict';

/* Top-level wiring: toolbar, open/drop, modes, keyboard shortcuts. */
(function () {
  const DEFAULT_SIG_WIDTH_PT = 200;
  const DEFAULT_INITIALS_WIDTH_PT = 90;

  // ---------- Mode / banner ----------
  App.setMode = function (mode, kind) {
    const prev = App.state.mode;
    App.state.mode = mode;
    const banner = App.$('#mode-banner');
    const textEl = App.$('#mode-banner-text');

    // leaving measure mode -> commit/clean up any in-progress drawing
    if (prev === 'measure' && mode !== 'measure' && App.Measure) App.Measure.stop();

    // toolbar armed highlight
    App.$('#btn-sign').classList.toggle('armed', mode === 'signature');
    App.$('#btn-initials').classList.toggle('armed', mode === 'initials');
    App.$('#btn-date').classList.toggle('armed', mode === 'date');
    App.$('#btn-measure').classList.toggle('armed', mode === 'measure');

    // remove any previously injected "new" link
    const existing = document.getElementById('mode-new');
    if (existing) existing.remove();

    if (!mode) {
      banner.classList.add('hidden');
      document.body.classList.remove('has-banner');
      App.Placement.disarm();
      return;
    }

    if (mode === 'measure') {
      textEl.textContent = 'Measuring — press Enter to finish a shape, Esc to stop.';
      banner.classList.remove('hidden');
      document.body.classList.add('has-banner');
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
      // Let the modal handle its own keys.
      if (!App.$('#sig-modal').classList.contains('hidden')) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault(); openViaDialog(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!App.$('#btn-save').disabled) App.Save.save();
        return;
      }
      if (inEditable(e.target)) return;

      if (e.key === 'Enter' && App.state.mode === 'measure') {
        e.preventDefault();
        App.Measure.finishDrawing();
        return;
      }
      if (e.key === 'Escape') {
        if (App.state.mode === 'measure' && App.Measure._active) App.Measure.cancelActive();
        else if (App.state.mode) App.setMode(null);
        else { App.Placement.deselect(); }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (App.state.selectedId != null) { e.preventDefault(); App.Placement.remove(App.state.selectedId); return; }
        if (App.state.measureSelectedId != null) { e.preventDefault(); App.Measure.remove(App.state.measureSelectedId); return; }
      }
      if (!App.state.pdfDoc) return;
      if (e.key === '+' || e.key === '=') { App.Viewer.zoomIn(); }
      else if (e.key === '-' || e.key === '_') { App.Viewer.zoomOut(); }
      else if (e.key === 'PageDown' || e.key === 'ArrowRight') { App.Viewer.next(); }
      else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { App.Viewer.prev(); }
    });
  }

  // ---------- Placement click delegation ----------
  function setupPlacementClicks() {
    const container = App.$('#pages-container');
    container.addEventListener('click', (e) => {
      const overlay = e.target.closest('.page-overlay');
      if (!overlay) return;
      if (e.target.closest('.placed')) return; // clicks on items handled locally
      const page = parseInt(overlay.dataset.page, 10);
      if (App.state.mode === 'measure') {
        App.Measure.handleClick(page, overlay, e);
      } else if (App.state.mode) {
        App.Placement.handleOverlayClick(page, overlay, e);
      } else {
        App.Placement.deselect();
      }
    });

    // live preview while measuring
    container.addEventListener('mousemove', (e) => {
      if (App.state.mode !== 'measure') return;
      const overlay = e.target.closest('.page-overlay');
      if (!overlay) return;
      App.Measure.handleMove(parseInt(overlay.dataset.page, 10), overlay, e);
    });

    // double-click finishes a polyline/polygon
    container.addEventListener('dblclick', (e) => {
      if (App.state.mode !== 'measure') return;
      e.preventDefault();
      App.Measure.finishDrawing();
    });
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

  function boot() {
    App.Signature.init();
    App.Measure.init();
    setupDragDrop();
    setupKeys();
    setupPlacementClicks();
    setupMeasureMenu();
    App.Viewer.trackScroll();

    App.$('#btn-open').addEventListener('click', openViaDialog);
    App.$('#btn-open-empty').addEventListener('click', openViaDialog);
    App.$('#btn-sign').addEventListener('click', () => startImagePlacement('signature'));
    App.$('#btn-initials').addEventListener('click', () => startImagePlacement('initials'));
    App.$('#btn-date').addEventListener('click', startDatePlacement);
    App.$('#btn-save').addEventListener('click', () => App.Save.save());
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
