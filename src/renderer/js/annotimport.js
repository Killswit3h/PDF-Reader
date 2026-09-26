'use strict';

/*
 * Make other apps' annotations editable (specs/feature-annot-import-spec.md).
 *
 * Detect (FR-1): after a document opens, count the annotations pdf.js reports
 * that could become FieldMark markups, and offer "Make editable" in the
 * Markups List. Nothing changes until the user presses it.
 *
 * Import (FR-2..FR-6): read every page's /Annots with pdf-lib, map the
 * supported ones through the pure App.annotToMarkups (src/shared/annot-import.js),
 * then REMOVE the originals from the working document and swap it in place.
 * Removing them is what stops the double draw (pdf.js would still paint the
 * original under the editable copy) and the duplicate on save (save.js builds
 * from App.state.pdfBytes and appends the markup as a new annotation). Because
 * the working bytes no longer hold the originals, the saved output and the
 * sidecar base are both clean with no change to save.js, and a reopen goes
 * through the normal sidecar path (FR-7).
 *
 * Undo: the stripped refs live in App.state.annotImportIds, which History
 * snapshots. The bytes before the first import are kept in annotImportSource;
 * after an undo/redo, sync() rebuilds the working document for whatever set
 * of refs the restored state names. pdf-lib keeps object numbers on save, so
 * a ref read from the source still names the same object in any stripped copy.
 */
(function () {
  const I = {};
  let chain = Promise.resolve();   // serializes swaps; an undo during an import waits
  let busy = false;

  const refKey = (ref) => `${ref.objectNumber} ${ref.generationNumber} R`;
  const idsKey = (ids) => (ids || []).slice().sort().join('|');

  function st() { return App.state; }

  // ---- reading a pdf-lib annotation dictionary into a plain descriptor ----
  function descriptor(ctx, dict) {
    const { PDFName, PDFNumber, PDFArray, PDFString, PDFHexString, PDFDict, PDFRef } = window.PDFLib;
    const get = (k) => {
      const v = dict.get(PDFName.of(k));
      return v instanceof PDFRef ? ctx.lookup(v) : v;
    };
    const num = (v) => (v instanceof PDFNumber ? v.asNumber() : null);
    const nums = (v) => {
      if (!(v instanceof PDFArray)) return null;
      const out = [];
      for (let i = 0; i < v.size(); i++) {
        let e = v.get(i);
        if (e instanceof PDFRef) e = ctx.lookup(e);
        const n = num(e);
        if (n == null) return null;
        out.push(n);
      }
      return out;
    };
    const str = (v) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null);
    const name = (v) => (v instanceof PDFName ? v.decodeText() : null);

    const bs = get('BS');
    let width = bs instanceof PDFDict ? num(bs.get(PDFName.of('W'))) : null;
    if (width == null) {
      const border = nums(get('Border'));
      if (border && border.length >= 3) width = border[2];
    }
    const le = get('LE');
    const leNames = le instanceof PDFArray
      ? [name(le.get(0)), name(le.get(1))]
      : le instanceof PDFName ? [name(le), null] : null;
    const be = get('BE');
    const ink = get('InkList');
    let inkList = null;
    if (ink instanceof PDFArray) {
      inkList = [];
      for (let i = 0; i < ink.size(); i++) {
        let s = ink.get(i);
        if (s instanceof PDFRef) s = ctx.lookup(s);
        inkList.push(nums(s) || []);
      }
    }
    return {
      subtype: name(get('Subtype')),
      rect: nums(get('Rect')),
      color: nums(get('C')),
      ic: nums(get('IC')),
      width,
      ca: num(get('CA')),
      contents: str(get('Contents')) || '',
      author: str(get('T')) || '',
      flags: num(get('F')) || 0,
      measure: !!get('Measure'),
      irt: !!dict.get(PDFName.of('IRT')),
      it: name(get('IT')),
      be: be instanceof PDFDict ? name(be.get(PDFName.of('S'))) : null,
      rd: nums(get('RD')),
      l: nums(get('L')),
      le: leNames,
      vertices: nums(get('Vertices')),
      inkList,
      quadPoints: nums(get('QuadPoints')),
      cl: nums(get('CL')),
      da: str(get('DA'))
    };
  }

  // Every importable annotation in `bytes`, as { key, popup, page, markups }.
  async function collect(bytes) {
    const { PDFDocument, PDFArray, PDFRef, PDFDict, PDFName } = window.PDFLib;
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    const ctx = doc.context;
    const found = [];
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const annots = pages[i].node.Annots();
      if (!(annots instanceof PDFArray)) continue;
      let vp = null;
      for (let j = 0; j < annots.size(); j++) {
        const ref = annots.get(j);
        // A direct (unreferenced) annotation has no name to strip it by later.
        if (!(ref instanceof PDFRef)) continue;
        const dict = ctx.lookup(ref);
        if (!(dict instanceof PDFDict)) continue;
        const d = descriptor(ctx, dict);
        if (!App.annotImportable(d)) continue;
        if (!vp) vp = await viewportFor(i + 1);
        const markups = App.annotToMarkups(d, (x, y) => {
          const p = vp.convertToViewportPoint(x, y);
          return { vx: p[0], vy: p[1] };
        });
        if (!markups.length) continue;
        const popup = dict.get(PDFName.of('Popup'));
        found.push({ key: refKey(ref), popup: popup instanceof PDFRef ? refKey(popup) : null, page: i + 1, markups });
      }
    }
    return found;
  }

  async function viewportFor(pageNum) {
    const cached = st().baseViewports[pageNum - 1];
    if (cached) return cached;
    const page = await st().pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    st().baseViewports[pageNum - 1] = vp;
    return vp;
  }

  // `source` minus the annotations named in `ids`, plus any popup whose parent
  // is one of them (a popup left behind would open an empty note in Acrobat).
  async function strip(source, ids) {
    const { PDFDocument, PDFArray, PDFRef, PDFDict, PDFName } = window.PDFLib;
    const doc = await PDFDocument.load(source, { updateMetadata: false, ignoreEncryption: true });
    const ctx = doc.context;
    const gone = new Set(ids);
    doc.getPages().forEach((page) => {
      const annots = page.node.Annots();
      if (!(annots instanceof PDFArray)) return;
      for (let j = annots.size() - 1; j >= 0; j--) {
        const ref = annots.get(j);
        if (!(ref instanceof PDFRef)) continue;
        let drop = gone.has(refKey(ref));
        if (!drop) {
          const dict = ctx.lookup(ref);
          const parent = dict instanceof PDFDict ? dict.get(PDFName.of('Parent')) : null;
          drop = parent instanceof PDFRef && gone.has(refKey(parent)) &&
            dict.get(PDFName.of('Subtype')) === PDFName.of('Popup');
        }
        if (drop) annots.remove(j);
      }
    });
    return new Uint8Array(await doc.save());
  }

  // Swap `bytes` in as the working document without touching the marks,
  // history, view or tab. Form values typed this session are carried across:
  // pdf-lib keeps object numbers, so the widget ids pdf.js keys them by match.
  async function swapIn(bytes) {
    const old = st().pdfDoc;
    const { doc, original } = await App.Viewer._parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    try {
      const vals = old && old.annotationStorage && old.annotationStorage.getAll();
      if (vals) Object.keys(vals).forEach((k) => doc.annotationStorage.setValue(k, vals[k]));
    } catch (_) { /* form values are best-effort */ }
    const pv = App.Viewer._pdfViewer;
    let scaleValue = null;
    try { scaleValue = pv && pv.currentScaleValue; } catch (_) { scaleValue = null; }
    st().pdfDoc = doc;
    st().pdfBytes = original;
    App.Viewer._showActive({ scaleValue, page: st().currentPage || 1 });
    if (App.Tabs && App.Tabs.snapshotActive) App.Tabs.snapshotActive();
    // Split view and compare hold bytes, not this proxy, so it is safe to free.
    if (old && old !== doc) { try { old.destroy(); } catch (_) { /* ignore */ } }
  }

  // Bring the working document in line with App.state.annotImportIds.
  async function applyIds() {
    const s = st();
    const want = idsKey(s.annotImportIds);
    if (want === (s.annotImportApplied || '')) return;
    if (!s.annotImportSource) return;
    const bytes = (s.annotImportIds && s.annotImportIds.length)
      ? await strip(s.annotImportSource, s.annotImportIds)
      : s.annotImportSource;
    await swapIn(bytes);
    s.annotImportApplied = want;
  }

  // Called by History after undo/redo restores a snapshot.
  I.sync = function () {
    const s = st();
    if (!s.pdfDoc || !s.annotImportSource) return;
    if (idsKey(s.annotImportIds) === (s.annotImportApplied || '')) return;
    const doc = s.pdfDoc;
    chain = chain.then(async () => {
      if (st().pdfDoc !== doc) return;       // tab changed underneath us
      try { await applyIds(); } catch (e) {
        if (window.console) console.warn('annot import sync failed:', e && e.message);
      }
      I.scan();
    });
    return chain;
  };

  // ---- FR-1: detection ------------------------------------------------------
  // First pass through pdf.js, which the viewer already has parsed, so a file
  // with no candidate annotations (the common case) costs no second parse.
  // pdf.js does not expose /Measure or /IT, so a Bluebeam takeoff would be
  // offered and then convert nothing; when there are candidates, the exact
  // count comes from the same pdf-lib read importAll() uses.
  const SUB = new Set(App.ANNOT_IMPORT_SUBTYPES || []);
  I.scan = async function () {
    const doc = st().pdfDoc;
    if (!doc) return 0;
    let n = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      let anns;
      try { anns = await (await doc.getPage(p)).getAnnotations(); } catch (_) { continue; }
      if (st().pdfDoc !== doc) return 0;      // another document took over
      (anns || []).forEach((a) => {
        const flags = a.annotationFlags || 0;
        if (SUB.has(a.subtype) && !a.inReplyTo && !(flags & (2 | 32 | 64 | 128))) n++;
      });
    }
    if (n && st().pdfDoc === doc) {
      try { n = (await collect(st().pdfBytes)).length; } catch (_) { n = 0; }
    }
    if (st().pdfDoc !== doc) return 0;
    st().foreignAnnots = n;
    if (App.Tabs && App.Tabs.snapshotActive) App.Tabs.snapshotActive();
    I.renderBanner();
    return n;
  };

  I.renderBanner = function () {
    const box = App.$('#mkp-import');
    if (!box) return;
    const n = st().pdfDoc ? (st().foreignAnnots || 0) : 0;
    box.classList.toggle('hidden', !n);
    const msg = App.$('#mkp-import-msg');
    if (msg) msg.textContent = `${n} markup${n === 1 ? '' : 's'} from another app`;
    const btn = App.$('#mkp-import-btn');
    if (btn) btn.disabled = busy;
  };

  // ---- FR-2: import ---------------------------------------------------------
  I.importAll = function () {
    const doc = st().pdfDoc;
    if (!doc || busy) return Promise.resolve(0);
    busy = true;
    I.renderBanner();
    App.showLoading('Making markups editable…');
    const run = chain.then(async () => {
      const s = st();
      if (s.pdfDoc !== doc) return 0;
      const found = await collect(s.pdfBytes);
      if (!found.length) {
        s.foreignAnnots = 0;
        App.toast('Nothing to convert: these are measurements, replies or locked marks, left as they are.', 'info', 6000);
        return 0;
      }
      // One snapshot, so a single undo reverts the whole import.
      App.History.snapshot();
      // If the swap below fails, the markups must not stay on top of the
      // originals: that is the double draw, and a save would duplicate them.
      const prev = { annotations: s.annotations.slice(), annoSeq: s.annoSeq, ids: s.annotImportIds, source: s.annotImportSource };
      if (!s.annotImportSource) s.annotImportSource = s.pdfBytes;
      let made = 0;
      found.forEach((f) => {
        f.markups.forEach((m) => {
          s.annoSeq = (s.annoSeq || 0) + 1;
          s.annotations.push(Object.assign({ id: s.annoSeq, page: f.page }, m));
          made++;
        });
      });
      const ids = (s.annotImportIds || []).slice();
      found.forEach((f) => { ids.push(f.key); if (f.popup) ids.push(f.popup); });
      s.annotImportIds = Array.from(new Set(ids));
      try { await applyIds(); } catch (e) {
        s.annotations = prev.annotations; s.annoSeq = prev.annoSeq;
        s.annotImportIds = prev.ids; s.annotImportSource = prev.source;
        if (App.Markup) App.Markup.repositionAll();
        throw e;
      }
      s.foreignAnnots = 0;
      const save = App.$('#btn-save'); if (save) save.disabled = false;
      if (App.Markup) App.Markup.repositionAll();
      if (App.MarkupPanel) App.MarkupPanel.render();
      if (App.Tabs && App.Tabs.snapshotActive) App.Tabs.snapshotActive();
      App.toast(`${made} markup${made === 1 ? '' : 's'} can now be edited. The originals are replaced when you save.`, 'success', 6000);
      I.scan();
      return made;
    });
    chain = run.catch(() => 0);
    return run.catch((e) => {
      if (window.console) console.error(e);
      App.toast('Could not convert the markups. ' + ((e && e.message) || ''), 'error', 6000);
      return 0;
    }).finally(() => {
      busy = false;
      App.hideLoading();
      I.renderBanner();
    });
  };

  I.init = function () {
    const btn = App.$('#mkp-import-btn');
    if (btn) btn.addEventListener('click', () => { I.importAll(); });
  };

  // Test hooks.
  I._collect = collect;
  I._strip = strip;

  App.AnnotImport = I;
})();
