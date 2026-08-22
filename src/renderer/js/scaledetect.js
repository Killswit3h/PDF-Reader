/*
 * Automatic per-page scale detection.
 *
 * This module is the impure half of the feature: it gets bytes out of the PDF,
 * text out of PDF.js, writes App.state and draws the review list. All the
 * parsing and arithmetic lives in src/shared/scale-detect.js, where it is
 * unit-tested without Electron. Keep it that way - anything here that starts
 * doing sums belongs over there.
 *
 * Two tiers, tried in order (FR-3):
 *
 *   A. The file already says what scale it is. A CAD/BIM exporter writes a /VP
 *      array of viewport dictionaries, each with a /BBox and a /Measure
 *      (ISO 32000 s12.9). PDF.js has no API for /VP at all, so this reads the
 *      raw page dictionary through pdf-lib - the same `page.node` route
 *      save.js:174-180 already uses to push annotations. Exact, and natively
 *      multi-scale-per-page: each viewport becomes a scaled region.
 *
 *   B. A human wrote the scale in the title block. Parsed out of the text
 *      layer, or out of OCR results on a scanned sheet. Covers the majority of
 *      real files, which carry no embedded metadata at all.
 *
 * The governing rule throughout: NEVER overwrite a scale the user set. A scale
 * with source 'user' - or with no source at all, which is what every scale in
 * a pre-existing sidecar looks like - is untouchable (FR-4, FR-5, FR-34).
 */
(function () {
  'use strict';

  const S = App.ScaleDetect; // pure half, loaded from src/shared/scale-detect.js

  let running = false;

  // Local, like markup.js:702 and toolchest.js:123 - every string in the review
  // list came out of an arbitrary PDF and none of it is trusted markup.
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Hand the event loop back between pages. A 200-sheet set must never freeze
  // the viewer while it is being scanned (NFR-1, NFR-2).
  const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

  /* ------------------------------------------------------ pdf-lib /VP reader */

  // pdf-lib getters, defensively: any of these can be a different type - or
  // missing - in a file we did not write.
  function numOf(o) {
    return o && typeof o.asNumber === 'function' ? o.asNumber() : null;
  }
  function strOf(o) {
    if (!o) return null;
    if (typeof o.decodeText === 'function') { try { return o.decodeText(); } catch (_) { /* fall through */ } }
    if (typeof o.asString === 'function') return o.asString();
    return null;
  }
  // PDFName.asString() gives '/RL'; the spec value is 'RL'.
  function nameOf(o) {
    const s = (o && typeof o.asString === 'function') ? o.asString() : null;
    return typeof s === 'string' ? s.replace(/^\//, '') : null;
  }

  // Flatten one pdf-lib /Measure dictionary into the plain shape the pure
  // module takes. Keeping pdf-lib on this side of the boundary is ADR-2.
  function flattenMeasure(md, PDFName, PDFArray, PDFDict) {
    if (!md) return null;
    const out = { subtype: nameOf(md.lookup(PDFName.of('Subtype'))), R: strOf(md.lookup(PDFName.of('R'))), X: [] };
    let xa = null;
    try { xa = md.lookup(PDFName.of('X'), PDFArray); } catch (_) { xa = null; }
    if (xa && typeof xa.size === 'function') {
      for (let i = 0; i < xa.size(); i++) {
        let nf = null;
        try { nf = xa.lookup(i, PDFDict); } catch (_) { continue; }
        if (!nf) continue;
        out.X.push({ U: strOf(nf.lookup(PDFName.of('U'))), C: numOf(nf.lookup(PDFName.of('C'))) });
      }
    }
    return out;
  }

  // Every page's embedded viewports, as raw PDF-user-space boxes plus a scale.
  // Returns { [page]: [{ bbox:[x0,y0,x1,y1], scale, name, reason }] } or null
  // when the document cannot be parsed at all (FR-42 - tier B still runs).
  async function readEmbedded(bytes) {
    if (!bytes || !window.PDFLib) return null;
    const { PDFDocument, PDFName, PDFArray, PDFDict } = window.PDFLib;
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (_) {
      return null; // FR-42: skip tier A document-wide, silently.
    }
    const out = {};
    let pages;
    try { pages = doc.getPages(); } catch (_) { return null; }

    pages.forEach((page, i) => {
      let arr = null;
      try { arr = page.node.lookup(PDFName.of('VP'), PDFArray); } catch (_) { arr = null; }
      if (!arr || typeof arr.size !== 'function' || !arr.size()) return;

      const found = [];
      for (let k = 0; k < arr.size(); k++) {
        let vp = null;
        try { vp = arr.lookup(k, PDFDict); } catch (_) { continue; }
        if (!vp) continue;

        let bboxArr = null;
        try { bboxArr = vp.lookup(PDFName.of('BBox'), PDFArray); } catch (_) { bboxArr = null; }
        const bbox = (bboxArr && typeof bboxArr.size === 'function' && bboxArr.size() >= 4)
          ? [0, 1, 2, 3].map((n) => numOf(bboxArr.lookup(n)))
          : null;

        let mdict = null;
        try { mdict = vp.lookup(PDFName.of('Measure'), PDFDict); } catch (_) { mdict = null; }
        const res = S.measureToScale(flattenMeasure(mdict, PDFName, PDFArray, PDFDict));

        if (!res.ok) { found.push({ bbox, scale: null, reason: res.reason }); continue; }
        // FR-14: a viewport we cannot place is a viewport we cannot use.
        if (!bbox || bbox.some((n) => n == null || !isFinite(n))) {
          found.push({ bbox: null, scale: null, reason: 'unusable region (/BBox)' });
          continue;
        }
        found.push({ bbox, scale: res, name: S.safeLabel(strOf(vp.lookup(PDFName.of('Name'))) || ''), reason: null });
      }
      if (found.length) out[i + 1] = found;
    });
    return out;
  }

  /* -------------------------------------------------------------- geometry */

  // /BBox (PDF user space, bottom-left origin) -> the app's scale-1 viewport
  // rectangle (top-left origin). convertToViewportPoint is PDF.js's own inverse
  // of the convertToPdfPoint that save.js exports through, so page rotation and
  // a non-zero crop box are both handled for us. Hand-rolling the Y flip here
  // would be wrong on every rotated sheet (ADR-4, and CLAUDE.md says so).
  function bboxToRect(bbox, viewport) {
    const a = viewport.convertToViewportPoint(bbox[0], bbox[1]);
    const b = viewport.convertToViewportPoint(bbox[2], bbox[3]);
    const rect = App.Geom.rectFrom({ vx: a[0], vy: a[1] }, { vx: b[0], vy: b[1] });
    if (!(rect.vw > 0.5) || !(rect.vh > 0.5)) return null; // FR-14
    return rect;
  }

  /* ------------------------------------------------------------ text source */

  // A page's text, from the text layer if it has one, else from OCR results if
  // any have been produced. Detection never STARTS an OCR run (spec §2.2) - it
  // only reads what is already there.
  async function pageText(pdfPage, pageNum) {
    let text = '';
    try {
      const tc = await pdfPage.getTextContent();
      text = (tc.items || []).map((it) => (it && typeof it.str === 'string' ? it.str : '')).join(' ');
    } catch (_) {
      text = '';
    }
    if (text.trim()) return { text, from: 'text' };

    const ocr = App.state.ocr && App.state.ocr[pageNum];
    const words = ocr && Array.isArray(ocr.words) ? ocr.words : null;
    if (words && words.length) {
      return { text: words.map((w) => (w && w.text) || '').join(' '), from: 'ocr' };
    }
    return { text: '', from: null };
  }

  /* --------------------------------------------------------- state writing */

  // Is this page's scale ours to touch? A user's scale never is - not on the
  // first run, not on a re-detect (FR-4, FR-6). A scale with no `source` is a
  // user scale from a sidecar written before this feature existed (FR-34).
  function canWriteScale(page) {
    const cur = App.state.scales[page];
    if (!cur) return true;
    return !!cur.source && cur.source !== 'user';
  }

  function setPageScale(page, scale) {
    App.state.scales[page] = scale;
  }

  // Replace this page's embedded regions, leaving any the user drew alone.
  function setEmbeddedViewports(page, regions) {
    const kept = (App.state.viewports[page] || []).filter((v) => v.source !== 'embedded');
    App.state.viewports[page] = kept.concat(regions);
    if (!App.state.viewports[page].length) delete App.state.viewports[page];
  }

  /* ------------------------------------------------------------------- run */

  App.ScaleDetect.isRunning = () => running;

  // `opts.force` is accepted for the Re-detect button's benefit but is
  // deliberately a no-op: a scale this module set is ALWAYS re-applied on a
  // re-run, and a scale the user set is never touched on any run (FR-6). There
  // is no third case for a flag to select, and pretending otherwise would
  // suggest a way to override the user that does not, and should not, exist.
  App.ScaleDetect.run = async function (opts) {
    opts = opts || {};
    if (running) return;                      // spec §5: ignore a second invocation
    const doc = App.state.pdfDoc;
    if (!doc) return;
    const n = App.state.numPages || 0;
    if (!n) return;

    running = true;
    const det = { status: 'running', pages: {} };
    App.state.scaleDetect = det;
    // Every await below can outlive the document; bail rather than write
    // detections from the old file into the new one (spec §5).
    const alive = () => App.state.pdfDoc === doc;

    try {
      // ---- page geometry. baseViewports is only filled in as pages render
      // (viewer.js:129), so ask PDF.js directly rather than trust it here.
      const viewports = [];
      const sizes = [];
      for (let p = 1; p <= n; p++) {
        if (!alive()) return;
        try {
          const pg = await doc.getPage(p);
          const vp = pg.getViewport({ scale: 1 });
          viewports[p] = vp;
          sizes.push({ w: vp.width / 72, h: vp.height / 72 });
        } catch (_) {
          viewports[p] = null;
          sizes.push(null);
        }
      }
      const half = S.halfSizePages(sizes);     // FR-28, FR-29

      // ---- tier A, one document parse for the whole file
      const embedded = await readEmbedded(App.state.pdfBytes);
      if (!alive()) return;

      let applied = 0; let review = 0; let halfCount = 0;

      for (let p = 1; p <= n; p++) {
        if (!alive()) return;
        await yieldToUI();
        if (!alive()) return;

        const entry = { state: 'none', source: null, candidates: [], reason: '', half: half[p - 1] || { half: false, of: null } };
        det.pages[p] = entry;

        try {
          // ---------------- tier A ----------------
          const vps = embedded && embedded[p];
          if (vps && vps.length) {
            entry.source = 'embedded';
            const regions = [];
            const bad = [];
            for (const v of vps) {
              if (!v.scale) { bad.push(v.reason || 'unreadable'); continue; }
              const rect = viewports[p] ? bboxToRect(v.bbox, viewports[p]) : null;
              if (!rect) { bad.push('unusable region (/BBox)'); continue; }
              regions.push({
                id: ++App.state.viewportSeq,
                vx: rect.vx, vy: rect.vy, vw: rect.vw, vh: rect.vh,
                factor: v.scale.factor, unit: v.scale.unit,
                ratioLabel: v.scale.ratioLabel,
                label: v.name || v.scale.ratioLabel,
                source: 'embedded'
              });
            }

            // A region BEATS the page scale in measure.js scaleFor, so adding
            // one over a page the user calibrated by hand would silently
            // override that calibration for anything drawn inside the box -
            // the exact surprise FR-4 exists to prevent. Hold them instead.
            if (regions.length && !canWriteScale(p)) {
              const f = regions[0];
              entry.state = 'review';
              entry.candidates = [{
                factor: f.factor, unit: f.unit, ratioLabel: f.ratioLabel, confidence: 'high'
              }];
              entry.reason = 'this page already has a scale you set';
              review++;
              continue;
            }

            if (regions.length) {
              setEmbeddedViewports(p, regions);                       // FR-12
              // FR-13: when every region agrees, the page as a whole is that
              // scale too, so a measurement outside every box still reads right.
              const first = regions[0];
              const uniform = regions.every((r) => r.unit === first.unit
                && Math.abs(r.factor - first.factor) <= 1e-9 * Math.max(r.factor, first.factor));
              if (uniform) {
                // FR-32: embedded metadata already describes the plotted
                // geometry - a half-size correction on top would double-count.
                setPageScale(p, {
                  factor: first.factor, unit: first.unit, ratioLabel: first.ratioLabel,
                  source: 'embedded', confidence: 'high'
                });
              }
              entry.state = 'applied';
              entry.candidates = [{
                factor: first.factor, unit: first.unit,
                ratioLabel: first.ratioLabel, confidence: 'high'
              }];
              entry.reason = regions.length > 1
                ? regions.length + ' embedded regions, each with its own scale'
                : 'embedded page scale';
              applied++;
              continue;                                                // FR-3
            }
            if (bad.length) {
              entry.state = 'none';
              entry.reason = bad[0];
              // fall through to tier B - an unreadable /VP is not a reason to
              // ignore a perfectly good title block.
            }
          }

          // ---------------- tier B ----------------
          const pg = await doc.getPage(p);
          if (!alive()) return;
          const src = await pageText(pg, p);
          if (!alive()) return;

          if (!src.text.trim()) {
            entry.state = 'undetectable';
            entry.reason = 'no text on this page — run OCR to read its title block'; // FR-45
            continue;
          }

          const notes = S.parseScaleNotes(src.text);
          entry.source = 'note';

          if (notes.noScaleMarker) {                                   // FR-21, FR-22
            entry.state = 'none';
            entry.reason = 'sheet declares ' + notes.noScaleMarker;
            continue;
          }

          const cls = S.classify(notes.candidates);
          entry.candidates = cls.distinct.map((c) => ({
            factor: c.factor, unit: c.unit, ratioLabel: c.ratioLabel, confidence: cls.confidence
          }));

          if (!entry.candidates.length) {
            entry.state = 'none';
            entry.reason = 'no scale note found';
            continue;
          }

          if (cls.apply && canWriteScale(p)) {                          // FR-26
            const scale = buildNoteScale(cls.chosen, entry.half, 'high');
            setPageScale(p, scale);
            entry.state = 'applied';
            entry.reason = scale.halfSize
              ? 'half-size plot of ' + entry.half.of + ' — doubled'
              : 'from the title block';
            if (scale.halfSize) { entry.needsConfirm = true; halfCount++; } // FR-31
            applied++;
          } else {
            entry.state = 'review';                                     // FR-24, FR-27
            entry.reason = !canWriteScale(p)
              ? 'this page already has a scale you set'
              : (entry.candidates.length > 1
                ? entry.candidates.length + ' different scales on this sheet'
                : 'not labelled “SCALE” — confirm before using');
            review++;
          }
        } catch (err) {
          entry.state = 'failed';                                       // FR-43
          entry.reason = 'could not read this page';
          if (window.console) console.warn('[scaledetect] page ' + p, err);
        }
      }

      if (!alive()) return;
      det.status = 'done';

      if (halfCount) {                                                  // FR-31
        App.toast(
          halfCount === 1
            ? '1 sheet looks like a half-size plot — its scale was doubled. Check it in Scale ▸ Detected.'
            : halfCount + ' sheets look like half-size plots — their scales were doubled. Check them in Scale ▸ Detected.',
          'info', 8000
        );
      }
      if (applied || review) {                                          // FR-41
        App.toast(
          'Scale detected on ' + applied + ' page' + (applied === 1 ? '' : 's') +
          (review ? ', ' + review + (review === 1 ? ' needs' : ' need') + ' review' : ''),
          'success', 6000
        );
      }
      if (applied) App.Measure.recomputeAll();                          // FR-40
      refreshTabIfOpen();
    } catch (err) {
      det.status = 'done';
      if (window.console) console.warn('[scaledetect]', err);
    } finally {
      running = false;
    }
  };

  // One note candidate -> a scale object, with the half-size correction folded
  // in when this sheet is a reduced plot (FR-30).
  function buildNoteScale(c, halfInfo, confidence) {
    const scale = {
      factor: c.factor, unit: c.unit, ratioLabel: c.ratioLabel,
      source: 'note', confidence: confidence
    };
    // Doubling is the only arithmetic done to a factor after the pure module
    // validated it, so re-check rather than let the invariant "everything in
    // state.scales passed plausibleFactor" hold only by arithmetic luck.
    if (halfInfo && halfInfo.half && S.plausibleFactor(c.factor * 2)) {
      scale.factor = c.factor * 2;
      scale.halfSize = true;
      scale.ratioLabel = c.ratioLabel + ' (half-size)';
    }
    return scale;
  }

  /* ------------------------------------------------ accept / clear / render */

  App.ScaleDetect.accept = function (page, index) {
    const det = App.state.scaleDetect;
    const entry = det && det.pages && det.pages[page];
    if (!entry) return;
    const c = entry.candidates[index];
    if (!c) return;

    App.History.snapshot();                                            // FR-39
    if (entry.source === 'embedded') {
      App.state.scales[page] = {
        factor: c.factor, unit: c.unit, ratioLabel: c.ratioLabel,
        source: 'embedded', confidence: 'high'
      };
    } else {
      App.state.scales[page] = buildNoteScale(c, entry.half, 'high');   // FR-36
    }
    entry.state = 'applied';
    entry.needsConfirm = false;
    entry.reason = 'accepted by you';
    App.Measure.recomputeAll();                                        // FR-40
    App.ScaleDetect.renderTab();
    App.toast('Page ' + page + ' scale: ' + App.state.scales[page].ratioLabel, 'success');
  };

  App.ScaleDetect.clear = function (page) {
    const det = App.state.scaleDetect;
    const entry = det && det.pages && det.pages[page];
    App.History.snapshot();                                            // FR-39
    const cur = App.state.scales[page];
    // Only ever clears what detection put there; a user's scale is not ours.
    if (cur && cur.source && cur.source !== 'user') delete App.state.scales[page];
    setEmbeddedViewports(page, []);                                    // FR-37
    if (entry) {
      entry.state = 'review';
      entry.needsConfirm = false;
      entry.reason = 'cleared — set it yourself if you need one';
    }
    App.Measure.recomputeAll();                                        // FR-40
    App.ScaleDetect.renderTab();
  };

  function badge(text, kind) {
    return '<span class="sd-badge sd-' + kind + '">' + esc(text) + '</span>';
  }

  App.ScaleDetect.renderTab = function () {
    const list = App.$('#sd-list');
    const summary = App.$('#sd-summary');
    if (!list || !summary) return;
    const det = App.state.scaleDetect;

    if (!det || det.status === 'idle') {
      summary.textContent = 'Open a drawing and FieldMark will read its scale.';
      list.innerHTML = '';
      return;
    }
    if (det.status === 'running') {
      summary.textContent = 'Reading scales…';
    }

    const pages = Object.keys(det.pages).map(Number).sort((a, b) => a - b);
    const shown = pages.filter((p) => det.pages[p].state !== 'none' || det.pages[p].reason);
    const applied = pages.filter((p) => det.pages[p].state === 'applied').length;
    const needing = pages.filter((p) => det.pages[p].state === 'review' || det.pages[p].needsConfirm).length;

    if (det.status === 'done') {
      summary.textContent = applied
        ? applied + ' page' + (applied === 1 ? '' : 's') + ' scaled automatically'
          + (needing ? ', ' + needing + ' to check' : '')
        : 'No scale could be read from this document.';
    }

    if (!shown.length) { list.innerHTML = '<div class="sd-empty">Nothing to report.</div>'; return; }

    list.innerHTML = shown.map((p) => {
      const e = det.pages[p];
      const head = '<span class="sd-page">Page ' + p + '</span>';
      let tag = '';
      if (e.state === 'applied') tag = badge(e.needsConfirm ? 'check this' : 'applied', e.needsConfirm ? 'warn' : 'ok');
      else if (e.state === 'review') tag = badge('needs review', 'warn');
      else if (e.state === 'failed') tag = badge('failed', 'bad');
      else if (e.state === 'undetectable') tag = badge('no text', 'muted');
      else tag = badge('no scale', 'muted');

      const src = e.source ? badge(e.source === 'embedded' ? 'from file' : 'from title block', 'src') : '';
      const cur = App.state.scales[p];
      const val = (e.state === 'applied' && cur)
        ? '<span class="sd-val">' + esc(cur.ratioLabel) + '</span>' : '';

      const actions = [];
      if (e.state === 'applied') {
        actions.push('<button class="tb-btn sd-clear" data-page="' + p + '" aria-label="Clear the detected scale on page ' + p + '">Clear</button>');
      }
      e.candidates.forEach((c, i) => {
        if (e.state === 'applied' && e.candidates.length === 1) return;
        actions.push('<button class="tb-btn sd-accept" data-page="' + p + '" data-i="' + i +
          '" aria-label="Use ' + esc(c.ratioLabel) + ' on page ' + p + '">Use ' + esc(c.ratioLabel) + '</button>');
      });

      return '<div class="sd-row" role="listitem">' +
        '<div class="sd-row-main">' + head + ' ' + tag + ' ' + src + ' ' + val + '</div>' +
        (e.reason ? '<div class="sd-reason">' + esc(e.reason) + '</div>' : '') +
        (actions.length ? '<div class="sd-actions">' + actions.join('') + '</div>' : '') +
        '</div>';
    }).join('');

    list.querySelectorAll('.sd-accept').forEach((b) => b.addEventListener('click', () => {
      App.ScaleDetect.accept(+b.dataset.page, +b.dataset.i);
    }));
    list.querySelectorAll('.sd-clear').forEach((b) => b.addEventListener('click', () => {
      App.ScaleDetect.clear(+b.dataset.page);
    }));
  };

  function refreshTabIfOpen() {
    const panel = App.$('.scale-panel[data-spanel="detected"]');
    if (panel && !panel.classList.contains('hidden')) App.ScaleDetect.renderTab();
  }

  App.ScaleDetect.initUI = function () {
    const btn = App.$('#sd-redetect');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (App.ScaleDetect.isRunning()) return;
        await App.ScaleDetect.run({ force: true });                    // FR-6
        App.ScaleDetect.renderTab();
      });
    }
  };
})();
