'use strict';

/*
 * Split View — show a second PDF side by side inside the same window.
 *
 * The left pane is the normal, fully-interactive viewer (the active tab). The
 * right pane is a read-only MiniViewer showing another open document (or one
 * opened from disk) for reference. Renderer-only, so it ships to desktop and
 * Android alike. (To put a document on a *separate monitor*, use "Open in New
 * Window" / tab tear-off, which needs the desktop multi-window layer.)
 */
(function () {
  const S = {};
  let mv = null;         // the right-pane MiniViewer instance
  let rightId = null;    // which open-tab id the right pane is showing (or null for a file)
  let on = false;

  const $ = (s) => App.$(s);

  S.isOpen = () => on;

  S.toggle = function () {
    if (on) return S.close();
    if (!App.state.pdfDoc) { App.toast('Open a PDF first.', 'info', 2500); return; }
    S.open();
  };

  S.open = function () {
    if (on) return;
    on = true;
    document.body.classList.add('has-split');
    const pane = $('#split-pane');
    if (pane) pane.classList.remove('hidden');
    if (!mv && window.MiniViewer) mv = window.MiniViewer.create($('#split-body'), { vendor: window.PDFJS_VENDOR });
    // Default the right pane to another open document if there is one; otherwise
    // prompt to open a file so the pane isn't empty.
    const others = App.Tabs.list().filter((d) => !d.active);
    populatePicker();
    if (others.length) loadTab(others[0].id);
    else openFile();
    // The left viewer's width changed; let PDF.js re-fit to the narrower pane.
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  };

  S.close = function () {
    if (!on) return;
    on = false;
    document.body.classList.remove('has-split');
    const pane = $('#split-pane');
    if (pane) pane.classList.add('hidden');
    if (mv) { mv.destroy(); }
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  };

  function populatePicker() {
    const sel = $('#split-pick');
    if (!sel) return;
    sel.innerHTML = '';
    App.Tabs.list().forEach((d) => {
      const o = document.createElement('option');
      o.value = 'tab:' + d.id;
      o.textContent = d.name + (d.active ? ' (left)' : '');
      sel.appendChild(o);
    });
    const openOpt = document.createElement('option');
    openOpt.value = 'open';
    openOpt.textContent = '＋ Open a file…';
    sel.appendChild(openOpt);
    if (rightId != null) sel.value = 'tab:' + rightId;
  }

  async function loadTab(id) {
    const bytes = App.Tabs.bytesOf(id);
    if (!bytes || !mv) return;
    rightId = id;
    const sel = $('#split-pick'); if (sel) sel.value = 'tab:' + id;
    try { await mv.loadBytes(bytes, App.Tabs.nameOf(id)); }
    catch (_) { App.toast('Could not show that document.', 'error'); }
  }

  async function openFile() {
    let res = null;
    try { res = window.api && window.api.openPdfDialog ? await window.api.openPdfDialog() : null; }
    catch (_) { res = null; }
    if (!res || !res.ok) { if (rightId == null) populatePicker(); return; }
    rightId = null;
    if (mv) { try { await mv.loadBytes(res.data, res.name); } catch (_) { App.toast('Could not open that file.', 'error'); } }
    populatePicker();
    const sel = $('#split-pick'); if (sel) sel.value = 'open';
  }

  S.init = function () {
    const wire = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    wire('#split-pick', 'change', (e) => {
      const v = e.target.value;
      if (v === 'open') openFile();
      else if (v.startsWith('tab:')) loadTab(parseInt(v.slice(4), 10));
    });
    wire('#split-zoom-in', 'click', () => mv && mv.zoomIn());
    wire('#split-zoom-out', 'click', () => mv && mv.zoomOut());
    wire('#split-fit', 'click', () => mv && mv.fitWidth());
    wire('#split-close', 'click', () => S.close());
  };

  App.SplitView = S;
})();
