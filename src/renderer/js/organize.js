'use strict';

/*
 * Page Organizer — reorder / rotate / delete / insert-blank / extract / merge.
 *
 * Renderer-only (Tier A): thumbnails come from PDF.js, the output document is
 * assembled with pdf-lib's copyPages(), then re-loaded through Viewer.load —
 * so it ships identically to Windows, macOS and the Android WebView.
 *
 * Model: an ordered list describing the OUTPUT document. Each entry references
 * a source doc + source page index (0-based) plus a rotation delta, or is a
 * freshly inserted blank page:
 *   { srcId:'main'|'imp<N>', srcIndex, rotate:0|90|180|270, deleted, selected }
 *   { blank:{ w, h }, rotate:0, deleted, selected }
 *
 * "Apply" rebuilds the PDF from the (non-deleted) entries and reloads it as the
 * current document — a clean structural edit, so in-app overlays are reset
 * (we confirm first when any exist). Organizing is a pre-markup step.
 */
(function () {
  const O = {};
  const pdfjsLib = window.pdfjsLib;

  let model = [];             // see shape above
  let imported = {};          // id -> { bytes:Uint8Array, doc:pdfjsProxy, name }
  let impSeq = 0;
  let observer = null;        // IntersectionObserver for lazy thumbnails

  function panel() { return App.$('#organize-panel'); }
  function isOpen() { return panel() && !panel().classList.contains('hidden'); }

  // ---- source bytes / pdf.js doc lookup -------------------------------------
  function bytesFor(srcId) {
    return srcId === 'main' ? App.state.pdfBytes : (imported[srcId] && imported[srcId].bytes);
  }
  function jsDocFor(srcId) {
    return srcId === 'main' ? App.state.pdfDoc : (imported[srcId] && imported[srcId].doc);
  }

  // ---- open / close ---------------------------------------------------------
  O.toggle = function () {
    if (!App.state.pdfDoc) return;
    const p = panel();
    if (isOpen()) { close(); return; }
    buildModel();
    p.classList.remove('hidden');
    document.body.classList.add('has-orgpanel');
    renderGrid();
  };
  function close() {
    panel().classList.add('hidden');
    document.body.classList.remove('has-orgpanel');
    if (observer) { observer.disconnect(); observer = null; }
    // Release imported pdf.js docs.
    Object.values(imported).forEach((im) => { try { im.doc.destroy(); } catch (_) { /* ignore */ } });
    imported = {};
  }
  O.close = close;

  function buildModel() {
    model = [];
    imported = {};
    for (let i = 0; i < App.state.numPages; i++) {
      model.push({ srcId: 'main', srcIndex: i, rotate: 0, deleted: false, selected: false });
    }
  }

  // ---- grid rendering -------------------------------------------------------
  function outIndexMap() {
    // Output page number (1-based) for each model entry, skipping deleted ones.
    const map = new Array(model.length).fill(null);
    let n = 0;
    model.forEach((e, i) => { if (!e.deleted) map[i] = ++n; });
    return map;
  }

  function renderGrid() {
    const grid = App.$('#org-grid');
    if (!grid) return;
    if (observer) observer.disconnect();
    observer = ('IntersectionObserver' in window)
      ? new IntersectionObserver(onVisible, { root: grid, rootMargin: '200px' })
      : null;

    grid.innerHTML = '';
    const map = outIndexMap();
    model.forEach((e, i) => {
      const tile = document.createElement('div');
      tile.className = 'org-tile' + (e.deleted ? ' deleted' : '') + (e.selected ? ' selected' : '');
      tile.dataset.i = String(i);

      const sel = document.createElement('input');
      sel.type = 'checkbox'; sel.className = 'org-sel'; sel.checked = !!e.selected;
      sel.title = 'Select (for Extract)';
      sel.addEventListener('change', () => { e.selected = sel.checked; tile.classList.toggle('selected', e.selected); });

      const canvas = document.createElement('canvas');
      canvas.className = 'org-thumb';
      const badge = document.createElement('div');
      badge.className = 'org-badge';
      badge.textContent = e.deleted ? '—' : (e.blank ? 'blank' : String(map[i]));

      const acts = document.createElement('div');
      acts.className = 'org-acts';
      acts.appendChild(actBtn('◀', 'Move left', () => moveEntry(i, -1)));
      acts.appendChild(actBtn('⟳', 'Rotate 90°', () => rotateEntry(i)));
      acts.appendChild(actBtn(e.deleted ? '↺' : '✕', e.deleted ? 'Restore' : 'Delete', () => toggleDelete(i)));
      acts.appendChild(actBtn('▶', 'Move right', () => moveEntry(i, 1)));

      tile.appendChild(sel);
      tile.appendChild(canvas);
      tile.appendChild(badge);
      tile.appendChild(acts);
      grid.appendChild(tile);

      if (observer) observer.observe(tile);
      else renderThumb(tile); // no IO support: render eagerly
    });
  }

  function actBtn(label, title, fn) {
    const b = document.createElement('button');
    b.className = 'org-act'; b.textContent = label; b.title = title;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    return b;
  }

  function onVisible(entries) {
    entries.forEach((en) => {
      if (en.isIntersecting) { renderThumb(en.target); observer.unobserve(en.target); }
    });
  }

  async function renderThumb(tile) {
    const i = parseInt(tile.dataset.i, 10);
    const e = model[i];
    const canvas = tile.querySelector('canvas');
    if (!e || !canvas || canvas.dataset.done) return;
    try {
      if (e.blank) {
        // Draw a plain white sheet for an inserted blank page.
        const w = 90, h = Math.round(90 * (e.blank.h / e.blank.w));
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#ccc'; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      } else {
        const doc = jsDocFor(e.srcId);
        const page = await doc.getPage(e.srcIndex + 1);
        const base = page.getViewport({ scale: 1 });
        const scale = 120 / base.width;
        const vp = page.getViewport({ scale, rotation: (page.rotate + e.rotate) % 360 });
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      }
      canvas.dataset.done = '1';
    } catch (_) { /* leave placeholder */ }
  }

  // ---- entry operations -----------------------------------------------------
  function moveEntry(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= model.length) return;
    const t = model[i]; model[i] = model[j]; model[j] = t;
    renderGrid();
  }
  function rotateEntry(i) {
    model[i].rotate = (model[i].rotate + 90) % 360;
    const tile = App.$(`.org-tile[data-i="${i}"]`);
    const c = tile && tile.querySelector('canvas');
    if (c) { delete c.dataset.done; renderThumb(tile); }
  }
  function toggleDelete(i) {
    model[i].deleted = !model[i].deleted;
    renderGrid();
  }

  function refSize() {
    // Size for a new blank page: match the first live source page, else US Letter.
    const first = model.find((e) => !e.deleted && !e.blank);
    if (first && App.state.baseViewports[first.srcIndex]) {
      const vp = App.state.baseViewports[first.srcIndex];
      return { w: vp.width, h: vp.height };
    }
    return { w: 612, h: 792 };
  }
  function insertBlank() {
    const sz = refSize();
    // Insert after the last selected entry, else at the end.
    let at = model.length;
    for (let i = model.length - 1; i >= 0; i--) { if (model[i].selected) { at = i + 1; break; } }
    model.splice(at, 0, { blank: { w: sz.w, h: sz.h }, rotate: 0, deleted: false, selected: false });
    renderGrid();
  }

  // ---- merge another PDF ----------------------------------------------------
  async function mergeFile() {
    const res = await window.api.openPdfDialog();
    if (!res) return;
    if (!res.ok) { App.toast('Could not read file: ' + res.error, 'error'); return; }
    App.showLoading('Loading pages…');
    try {
      const ab = res.data;
      const forLib = new Uint8Array(ab.byteLength); forLib.set(new Uint8Array(ab));
      const forJs = new Uint8Array(ab.byteLength); forJs.set(new Uint8Array(ab));
      const doc = await pdfjsLib.getDocument({ data: forJs }).promise;
      const id = 'imp' + (++impSeq);
      imported[id] = { bytes: forLib, doc, name: res.name || 'merged.pdf' };
      for (let i = 0; i < doc.numPages; i++) {
        model.push({ srcId: id, srcIndex: i, rotate: 0, deleted: false, selected: false });
      }
      renderGrid();
      App.toast(`Added ${doc.numPages} page(s) from ${imported[id].name}`, 'success');
    } catch (err) {
      App.toast('Could not merge that PDF.', 'error');
    } finally {
      App.hideLoading();
    }
  }

  // ---- build a pdf-lib document from a set of entries -----------------------
  async function assemble(entries) {
    const { PDFDocument, degrees } = window.PDFLib;
    const out = await PDFDocument.create();
    const libCache = {};
    async function libDoc(srcId) {
      if (!libCache[srcId]) libCache[srcId] = await PDFDocument.load(bytesFor(srcId));
      return libCache[srcId];
    }
    for (const e of entries) {
      if (e.blank) { out.addPage([e.blank.w, e.blank.h]); continue; }
      const src = await libDoc(e.srcId);
      const [pg] = await out.copyPages(src, [e.srcIndex]);
      if (e.rotate) pg.setRotation(degrees(((pg.getRotation().angle || 0) + e.rotate) % 360));
      out.addPage(pg);
    }
    return out.save();
  }

  // ---- extract selected -----------------------------------------------------
  async function extractSelected() {
    const sel = model.filter((e) => e.selected && !e.deleted);
    if (!sel.length) { App.toast('Select one or more pages first (tick the boxes).', 'error'); return; }
    App.showLoading('Extracting pages…');
    try {
      const bytes = await assemble(sel);
      const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
      const res = await window.api.savePdfDialog(`${base}-extract.pdf`, bytes);
      if (res && res.ok) App.toast(`Saved ${sel.length} page(s): ${res.path}`, 'success', 5000);
      else if (res && res.error) App.toast('Could not save: ' + res.error, 'error');
    } catch (err) {
      App.toast('Extract failed. ' + (err.message || ''), 'error');
    } finally {
      App.hideLoading();
    }
  }

  // ---- apply changes (rebuild + reload) -------------------------------------
  async function apply() {
    const live = model.filter((e) => !e.deleted);
    if (!live.length) { App.toast('A document needs at least one page.', 'error'); return; }

    const hasOverlays = App.state.placements.length || App.state.measurements.length ||
      App.state.annotations.length;
    if (hasOverlays) {
      const ok = await App.confirm(
        'Applying page changes rebuilds the document, which clears the current ' +
        'signatures, measurements and markups. Save first if you want to keep them.\n\n' +
        'Continue?',
        { title: 'Reorganize pages', okLabel: 'Rebuild', danger: true });
      if (!ok) return;
    }

    App.showLoading('Rebuilding document…');
    try {
      const bytes = await assemble(live);
      const name = App.state.fileName || 'document.pdf';
      const filePath = App.state.filePath;
      close();
      await App.Viewer.load(bytes.buffer, name, filePath);
      App.state.dirty = true;
      App.$('#btn-save').disabled = false;
      App.toast(`Rebuilt: ${live.length} page(s).`, 'success', 4000);
    } catch (err) {
      App.hideLoading();
      App.toast('Could not rebuild the document. ' + (err.message || ''), 'error', 6000);
    }
  }

  // Expose for tests / programmatic drives.
  O._assemble = assemble;
  O._model = () => model;
  O.apply = apply;
  O.extractSelected = extractSelected;

  O.init = function () {
    const b = (id, fn) => { const el = App.$(id); if (el) el.addEventListener('click', fn); };
    b('#org-close', close);
    b('#org-cancel', close);
    b('#org-apply', apply);
    b('#org-insert', insertBlank);
    b('#org-merge', mergeFile);
    b('#org-extract', extractSelected);
  };

  App.Organize = O;
})();
