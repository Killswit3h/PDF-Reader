'use strict';

/*
 * Text recognition (OCR) — turn a scanned page into searchable text.
 *
 * How it works
 * ------------
 * Each selected page is rasterized (bounded by ocr-layout's DPI/megapixel caps),
 * handed to Tesseract, and the words that come back are written into the PDF as
 * text drawn in *invisible* rendering mode (`Tr 3`), positioned over the ink they
 * were read from. That is the standard "searchable PDF" construction: the page
 * looks exactly the same, but it now carries a real text layer.
 *
 * The payoff is that we then reload the recognized bytes into the tab, and
 * PDF.js simply sees an ordinary text layer — so find, text selection and
 * select-to-copy all start working on a scan with no further code in this app.
 *
 * Deliberately NOT routed through save.js
 * ---------------------------------------
 * This module builds its own output with pdf-lib from App.state.pdfBytes rather
 * than calling Save.buildBytes. Going through the shared export path would
 * flatten the user's live markups into the page as a side effect of merely
 * running OCR, and would put the save/print/sign path at risk. save.js is
 * untouched by this feature.
 *
 * Geometry
 * --------
 * Words are stored in scale-1 viewport points, top-left origin — the same space
 * as placements, measurements and markups — and exported through the page
 * viewport's convertToPdfPoint, which is what makes recognition land correctly
 * on pages with a /Rotate.
 *
 * Renderer-only (canvas + WASM), so it ships to Windows, macOS and Android from
 * this one implementation.
 */
(function () {
  const O = {};
  const $ = (s) => App.$(s);
  const LO = () => App.OcrLayout;

  let running = false;
  let cancelled = false;

  // ---- Asset locations -------------------------------------------------------
  // Same convention as viewer.js's VENDOR: Electron resolves out of node_modules,
  // the web/APK build sets window.PDFJS_VENDOR and reads from vendor/.
  //
  // These are made ABSOLUTE on purpose. Tesseract resolves corePath and langPath
  // from inside its own worker, where a document-relative path would resolve
  // against the worker script's URL instead of the page's and quietly 404.
  function assetPaths() {
    const web = !!window.PDFJS_VENDOR;
    const abs = (p) => new URL(p, document.baseURI).href;
    return {
      worker: abs(web ? 'vendor/tesseract/worker.min.js'
        : '../../node_modules/tesseract.js/dist/worker.min.js'),
      core: abs(web ? 'vendor/tesseract-core/'
        : '../../node_modules/tesseract.js-core/'),
      lang: abs(web ? 'assets/tessdata/' : '../assets/tessdata/')
    };
  }
  O._assetPaths = assetPaths;

  // ---- Small helpers ---------------------------------------------------------
  const angleDeg = (p, q) =>
    (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;

  function setStatus(text, pct) {
    const s = $('#ocr-status');
    if (s) s.textContent = text;
    const f = $('#ocr-bar-fill');
    if (f) f.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  }

  // ---- Engine ----------------------------------------------------------------
  // One worker per run. `cacheMethod: 'none'` keeps the language data out of
  // IndexedDB — it is already bundled locally, so caching it would only duplicate
  // ~2 MB into the user's profile for nothing.
  async function makeWorker() {
    const Tesseract = await App.ensureLib('tesseract');
    const p = assetPaths();
    return Tesseract.createWorker('eng', 1, {
      workerPath: p.worker,
      corePath: p.core,
      langPath: p.lang,
      cacheMethod: 'none',
      legacyCore: false,
      legacyLang: false
    });
  }

  // FR-A-15: can recognition run at all in this build? Used to fail fast with a
  // clear message instead of dying partway through a run.
  O.isAvailable = async function () {
    try {
      const w = await makeWorker();
      await w.terminate();
      return true;
    } catch (_) {
      return false;
    }
  };

  // ---- Page inspection + rasterizing ----------------------------------------
  // FR-A-8: a page that already yields text is left alone unless the user asks
  // for it, because recognizing it again would lay a second, less accurate text
  // layer over a perfectly good one.
  async function pageHasText(pageNum) {
    try {
      const page = await App.state.pdfDoc.getPage(pageNum);
      const tc = await page.getTextContent();
      return (tc.items || []).some(
        (it) => it && typeof it.str === 'string' && it.str.trim().length > 0);
    } catch (_) {
      return false;
    }
  }

  // Render a page to a canvas for recognition. The viewport carries the page's
  // /Rotate (PDF.js applies it by default), and App.state.baseViewports is built
  // the same way, so raster pixels divided by `scale` land in the very same
  // coordinate space the rest of the app uses.
  async function rasterize(pageNum) {
    const page = await App.state.pdfDoc.getPage(pageNum);
    const v1 = page.getViewport({ scale: 1 });
    const scale = LO().rasterScale(v1.width, v1.height);
    if (!(scale >= LO().MIN_SCALE)) {
      // E4 — even at the floor resolution this page busts the pixel cap.
      const err = new Error('page too large to rasterize');
      err.tooLarge = true;
      throw err;
    }
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    // A PDF page is transparent where nothing is drawn; Tesseract reads a
    // transparent bitmap as black and returns noise. Lay down white first.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { canvas, scale, v1 };
  }

  // ---- The run ---------------------------------------------------------------
  /**
   * Recognize text across the selected pages and swap the recognized document in.
   * opts = { scope: 'page' | 'all', force: boolean }
   * Resolves { recognized, skipped, failed, empty, cancelled, words }.
   */
  O.run = async function (opts) {
    opts = opts || {};
    const summary = {
      recognized: 0, skipped: 0, failed: 0, empty: 0, cancelled: false, words: 0
    };
    if (!App.state.pdfDoc || running) return summary;

    const pages = opts.scope === 'all'
      ? Array.from({ length: App.state.numPages }, (_, i) => i + 1)
      : [App.state.currentPage || 1];

    running = true;
    cancelled = false;
    let worker = null;
    // Results accumulate here and touch the document only at the very end, which
    // is what makes cancel byte-safe (FR-A-6) with no rollback logic.
    const results = {};
    const viewports = {};

    try {
      setStatus('Starting text recognition…', 0);
      try {
        worker = await makeWorker();
      } catch (e) {
        // FR-A-15 / E1
        App.toast('Text recognition is unavailable in this build.', 'error', 6000);
        return summary;
      }

      for (let i = 0; i < pages.length; i++) {
        if (cancelled) { summary.cancelled = true; break; }
        const pageNum = pages[i];
        const base = Math.round((i / pages.length) * 100);
        setStatus(`Recognizing page ${pageNum} — ${i + 1} of ${pages.length}`, base);

        if (!opts.force && await pageHasText(pageNum)) {
          results[pageNum] = { status: 'skipped', words: [] };
          summary.skipped++;
          continue;
        }

        try {
          const { canvas, scale, v1 } = await rasterize(pageNum);
          if (cancelled) { summary.cancelled = true; break; }

          const res = await worker.recognize(canvas);
          // Free the raster immediately; a D-size page is a very large bitmap and
          // holding several would be the difference between finishing and being
          // killed on a tablet.
          canvas.width = canvas.height = 0;

          const raw = (res && res.data && res.data.words) || [];
          const words = [];
          for (const w of raw) {
            if (!LO().usableWord(w)) continue;
            const text = LO().sanitizeText(w.text.trim());
            if (!text) continue;
            const box = LO().wordToViewport(w.bbox, scale);
            words.push({
              text, vx: box.vx, vy: box.vy, vw: box.vw, vh: box.vh,
              conf: Math.round(w.confidence)
            });
          }

          viewports[pageNum] = v1;
          if (words.length) {
            results[pageNum] = { status: 'done', dpi: LO().dpiOf(scale), words };
            summary.recognized++;
            summary.words += words.length;
          } else {
            // E5 — nothing legible on this page.
            results[pageNum] = { status: 'empty', dpi: LO().dpiOf(scale), words: [] };
            summary.empty++;
          }
        } catch (e) {
          // FR-A-16 / E2, E4, E7 — one bad page must not end the run.
          results[pageNum] = { status: 'failed', words: [] };
          summary.failed++;
          if (window.console) console.warn('OCR failed on page ' + pageNum + ':', e && e.message);
        }
      }
    } finally {
      if (worker) { try { await worker.terminate(); } catch (_) { /* ignore */ } }
      running = false;
    }

    App.state.ocr = results;

    // FR-A-6: cancelled runs never touch the document.
    if (summary.cancelled || !summary.recognized) return summary;

    setStatus('Adding the recognized text…', 98);
    try {
      const built = await O._buildBytes(App.state.pdfBytes, results, viewports);
      await swapIn(built.bytes);
    } catch (e) {
      App.toast('Recognition finished, but the text could not be added. '
        + (e && e.message ? e.message : ''), 'error', 6000);
      summary.failed += summary.recognized;
      summary.recognized = 0;
    }
    return summary;
  };

  O.cancel = function () { cancelled = true; };
  O.isRunning = () => running;

  // ---- Writing the invisible text layer -------------------------------------
  /**
   * Draw each recognized word into `srcBytes` as invisible text.
   * `viewports[pageNum]` is that page's scale-1 PDF.js viewport.
   * Exposed for tests.
   */
  O._buildBytes = async function (srcBytes, results, viewports) {
    const {
      PDFDocument, StandardFonts, degrees,
      setTextRenderingMode, TextRenderingMode, setCharacterSqueeze
    } = window.PDFLib;

    const pdfDoc = await PDFDocument.load(srcBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    let wrote = 0;

    for (const key of Object.keys(results)) {
      const entry = results[key];
      if (!entry || entry.status !== 'done' || !entry.words.length) continue;
      const pageNum = parseInt(key, 10);
      const vp = viewports[pageNum];
      if (!vp) continue;
      const page = pdfDoc.getPage(pageNum - 1);

      // Text render mode and horizontal scaling are text *state*: set once here,
      // inherited by each drawText's q/Q block, and reset after the page.
      page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));

      for (const w of entry.words) {
        const size = LO().fontSizeFor(w);
        let natural;
        try {
          natural = font.widthOfTextAtSize(w.text, size);
        } catch (_) { continue; }
        const by = LO().baselineY(w);
        const anchor = vp.convertToPdfPoint(w.vx, by);
        // A second point one viewport-x unit along gives the on-page writing
        // direction, so the invisible run is rotated to match a /Rotate page —
        // the same technique save.js uses for flattened text.
        const dir = vp.convertToPdfPoint(w.vx + 1, by);

        page.pushOperators(setCharacterSqueeze(LO().squeeze(w.vw, natural)));
        try {
          page.drawText(w.text, {
            x: anchor[0], y: anchor[1], size, font,
            rotate: degrees(angleDeg(anchor, dir))
          });
          wrote++;
        } catch (_) {
          // Last-resort guard: skip a word the font still cannot encode rather
          // than lose the whole document to it.
        }
      }

      page.pushOperators(
        setCharacterSqueeze(100),
        setTextRenderingMode(TextRenderingMode.Fill));
    }

    return { bytes: await pdfDoc.save(), wrote };
  };

  // ---- Swapping the recognized document in ----------------------------------
  // FR-A-12. Reloading clears app state by design (Viewer._clearState), so the
  // marks are serialized first and rehydrated after — unlike the page organizer,
  // which warns that a rebuild loses them. OCR changes no geometry, so there is
  // no reason for the user to lose work over it.
  async function swapIn(bytes) {
    const model = App.Save.serializeModel();
    delete model.__count;
    const name = App.state.fileName || 'document.pdf';
    const filePath = App.state.filePath;

    const ok = App.Tabs
      ? await App.Tabs.replaceActive(bytes.buffer, name, filePath)
      : await App.Viewer._loadInto(bytes.buffer, name, filePath);
    if (!ok) throw new Error('could not reopen the recognized document');

    App.Viewer._rehydrate(model);
    App.Viewer.refreshOverlays();
    // replaceActive snapshotted the tab before the marks were restored, so
    // snapshot again or a tab switch would drop them.
    if (App.Tabs && App.Tabs.snapshotActive) App.Tabs.snapshotActive();

    App.state.dirty = true;              // FR-A-13
    const save = $('#btn-save');
    if (save) save.disabled = false;
  }

  // ---- UI --------------------------------------------------------------------
  function showSetup() {
    $('#ocr-setup').classList.remove('hidden');
    $('#ocr-progress').classList.add('hidden');
    $('#ocr-start').disabled = false;
    $('#ocr-cancel').textContent = 'Cancel';
  }

  O.open = function () {
    if (!App.state.pdfDoc) return;         // FR-A-17
    showSetup();
    setStatus('', 0);
    $('#ocr-modal').classList.remove('hidden');
    const first = $('#ocr-modal input[name="ocr-scope"]');
    if (first) first.focus();
  };

  O.close = function () {
    if (running) return;                   // never abandon a run mid-flight
    $('#ocr-modal').classList.add('hidden');
  };

  function summaryMessage(s) {
    if (s.cancelled) return { msg: 'Recognition cancelled.', kind: 'info' };
    const bits = [];
    if (s.recognized) bits.push(`${s.recognized} page${s.recognized === 1 ? '' : 's'} recognized`);
    if (s.skipped) bits.push(`${s.skipped} already had text`);
    if (s.empty) bits.push(`${s.empty} with no text found`);
    if (s.failed) bits.push(`${s.failed} failed`);
    if (!bits.length) return { msg: 'Nothing to recognize.', kind: 'info' };
    const kind = s.recognized ? 'success' : (s.failed ? 'error' : 'info');
    return { msg: bits.join(' · '), kind };
  }

  async function start() {
    const scopeEl = $('#ocr-modal input[name="ocr-scope"]:checked');
    const opts = {
      scope: scopeEl ? scopeEl.value : 'page',
      force: !!($('#ocr-force') && $('#ocr-force').checked)
    };

    $('#ocr-setup').classList.add('hidden');
    $('#ocr-progress').classList.remove('hidden');
    $('#ocr-start').disabled = true;
    $('#ocr-cancel').textContent = 'Cancel';

    let s;
    try {
      s = await O.run(opts);
    } catch (e) {
      App.toast('Text recognition failed. ' + (e && e.message ? e.message : ''), 'error', 6000);
      $('#ocr-modal').classList.add('hidden');
      showSetup();
      return;
    }

    $('#ocr-modal').classList.add('hidden');
    showSetup();
    const { msg, kind } = summaryMessage(s);
    App.toast(msg, kind, 5000);
  }

  O.init = function () {
    const wire = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    wire('#ocr-close', 'click', () => (running ? O.cancel() : O.close()));
    wire('#ocr-cancel', 'click', () => (running ? O.cancel() : O.close()));
    wire('#ocr-start', 'click', start);
    // NFR-10: Escape closes the dialog, or stops a run in progress.
    wire('#ocr-modal', 'keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); running ? O.cancel() : O.close(); }
    });
  };

  App.OCR = O;
})();
