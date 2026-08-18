'use strict';

/*
 * Headless verification that the assembled www/ bundle actually runs in a real
 * browser engine (the same Chromium the Android WebView is built on): boots
 * without CSP/JS errors, loads a PDF through PDF.js, renders pages, and exports
 * bytes through pdf-lib. Run after `npm run build:web`.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Playwright is an optional harness dependency (not needed to build the app or
// the APK), so give a clear hint instead of a raw MODULE_NOT_FOUND if it's absent.
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  console.error('[verify-web] needs Playwright. Install it, then re-run:\n' +
    '  npm i --no-save playwright && npx playwright install chromium\n' +
    '  npm run verify:web');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.map': 'application/json'
};

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(base)) {
      if (/^chromium-\d+$/.test(d)) {
        const p = path.join(base, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* fall through */ }
  // Fall back to Playwright's own browser resolution (e.g. installed via
  // `npx playwright install chromium` in CI).
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (_) { /* none */ }
  return undefined;
}

function serve(dir) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

(async () => {
  const server = await serve(WWW);
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();

  const errors = [];
  // The generic "Failed to load resource" console line carries no URL; track
  // real resource failures via response/requestfailed and ignore the browser's
  // automatic /favicon.ico probe (not part of the app).
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    if (!/favicon\.ico$/.test(r.url())) errors.push('requestfailed: ' + r.url());
  });

  let result = {};
  try {
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });

    // Wait for the app modules to wire up.
    await page.waitForFunction('window.App && App.Viewer && App.Save && window.api', null, { timeout: 15000 });

    // Confirm the adapter is the web one (window.api present, no Electron preload).
    const apiOk = await page.evaluate(() => typeof window.api.openPdfDialog === 'function' &&
      typeof window.api.savePdfDialog === 'function');

    // Load a fixture PDF the same way Viewer.load receives it (an ArrayBuffer).
    const pdfB64 = fs.readFileSync(path.join(ROOT, 'test/fixtures/sample.pdf')).toString('base64');
    result = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await App.Viewer.load(u8.buffer, 'sample.pdf', null);
      for (let i = 0; i < 80 && !App.state.numPages; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 800));

      // Exercise the export path (pdf-lib) with a placed stamp.
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAvyQP9vYaMtwAAAABJRU5ErkJggg==';
      App.state.placements.push({ id: 1, type: 'image', page: 1, vx: 60, vy: 60, vw: 120, vh: 40, dataUrl: png, aspect: 3 });
      let bytesLen = 0, saveErr = '';
      try { bytesLen = (await App.Save.buildBytes()).length; } catch (e) { saveErr = e.message; }

      return {
        numPages: App.state.numPages || 0,
        canvases: document.querySelectorAll('#viewer .page canvas').length,
        emptyHidden: document.querySelector('#empty-state').classList.contains('hidden'),
        fileName: App.state.fileName,
        filePath: App.state.filePath,
        bytesLen, saveErr
      };
    }, pdfB64);
    result.apiOk = apiOk;

    // Rail/header flyouts are renderer-only, so the WebView gets the same wiring
    // as Electron: only one may be open at a time (opening a second used to leave
    // the first stacked behind it), and the Measure menu's inline controls must
    // NOT dismiss it.
    result.dropdowns = await page.evaluate(async () => {
      const $ = (s) => document.querySelector(s);
      const tick = () => new Promise((r) => setTimeout(r, 60));
      const shown = (s) => !$(s).classList.contains('hidden');
      const openCount = () => document.querySelectorAll('.tb-menu:not(.hidden)').length;
      let maxOpen = 0;
      const gauge = () => { maxOpen = Math.max(maxOpen, openCount()); };

      $('#btn-measure').click(); await tick(); gauge();
      const measureAlone = shown('#measure-menu') && openCount() === 1;
      $('#btn-markup').click(); await tick(); gauge();
      const swapped = shown('#markup-menu') && !shown('#measure-menu');
      $('#btn-document').click(); await tick(); gauge();
      const swapped2 = shown('#document-menu') && !shown('#markup-menu');
      $('#btn-document').click(); await tick(); gauge();
      const selfClosed = openCount() === 0;

      $('#btn-measure').click(); await tick(); gauge();
      $('#measure-snap').click(); await tick(); gauge();
      const stickyOpen = shown('#measure-menu');
      $('#measure-snap').click(); await tick();

      const modeBefore = App.state.mode;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick(); gauge();
      const escClosed = !shown('#measure-menu') && App.state.mode === modeBefore;

      $('#btn-markup').click(); await tick(); gauge();
      $('#viewerContainer').click(); await tick(); gauge();
      const outsideClosed = openCount() === 0;

      return { measureAlone, swapped, swapped2, selfClosed, stickyOpen, escClosed, outsideClosed, maxOpen };
    });

    // ---- Icon system (Track A) ----
    // Two things are checked against the live DOM rather than the source, so a
    // regression is caught wherever it comes from — hand-written markup or a
    // module building rows with innerHTML.
    //
    // 1. No emoji is used as an interface icon. Emoji cannot inherit
    //    currentColor and render as different vendor artwork on macOS, Windows
    //    and Android, which is exactly what this track removed.
    // 2. Every <use> resolves to a symbol that actually exists in the sprite —
    //    a typo'd href renders as nothing at all, which is invisible in tests
    //    that only assert on structure.
    result.icons = await page.evaluate(() => {
      const EMOJI = /\p{Extended_Pictographic}/u;
      const offenders = [];
      // Text nodes inside interactive chrome. The PDF's own text layer and any
      // user-authored content are out of scope — this is about the app's UI.
      document.querySelectorAll(
        '#toolbar, #tool-rail, #markup-rail, #markup-props, #mode-banner, ' +
        '.tb-menu, .tab-menu, .modal, #empty-state, #tab-bar, #find-bar, #copy-fab'
      ).forEach((root) => {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (EMOJI.test(n.nodeValue)) {
            offenders.push((n.parentElement.id || n.parentElement.className || '?') +
              ': ' + n.nodeValue.trim().slice(0, 40));
          }
        }
      });
      const missing = [];
      document.querySelectorAll('use').forEach((u) => {
        const href = u.getAttribute('href') || '';
        if (href.startsWith('#') && !document.getElementById(href.slice(1))) missing.push(href);
      });
      return {
        emojiOffenders: offenders,
        missingSymbols: [...new Set(missing)],
        symbolCount: document.querySelectorAll('#icon-sprite symbol').length,
        iconCount: document.querySelectorAll('svg.ico use').length
      };
    });
    // ---- Accessibility (Track E) ----
    // Checked against the live DOM: every dialog must be a real dialog, the
    // focus trap must actually cycle, focus must come back to whatever opened
    // the surface, and no interactive control may be left without a name.
    result.a11y = await page.evaluate(async () => {
      const $ = (s) => document.querySelector(s);
      const tick = () => new Promise((r) => setTimeout(r, 120));

      // 1. Dialog semantics on all eleven modals.
      const backdrops = Array.from(document.querySelectorAll('.modal-backdrop'));
      const badDialogs = backdrops.filter((b) => {
        const d = b.querySelector('.modal');
        if (!d) return true;
        const labelId = d.getAttribute('aria-labelledby');
        return d.getAttribute('role') !== 'dialog' ||
               d.getAttribute('aria-modal') !== 'true' ||
               !labelId || !document.getElementById(labelId);
      }).map((b) => b.id);

      // 2. Focus trap + restore, exercised on a real dialog.
      const opener = $('#btn-help');
      opener.focus();
      const modal = $('#shortcuts-modal');
      modal.classList.remove('hidden');
      await tick();
      const dlg = modal.querySelector('.modal');
      const focusMovedIn = dlg.contains(document.activeElement);
      // Tab from the last focusable must wrap to the first, not escape.
      const items = App.focusablesIn(dlg);
      let wrapped = false;
      if (items.length) {
        items[items.length - 1].focus();
        dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await tick();
        wrapped = document.activeElement === items[0];
      }
      modal.classList.add('hidden');
      await tick();
      const focusRestored = document.activeElement === opener;

      // 3. Every interactive control has an accessible name.
      const unnamed = [];
      document.querySelectorAll(
        'button, input:not([type="hidden"]), select, textarea, [role="option"]'
      ).forEach((el) => {
        if (el.closest('#icon-sprite')) return;
        const name = (el.getAttribute('aria-label') || '').trim() ||
          (el.getAttribute('title') || '').trim() ||
          (el.textContent || '').trim() ||
          (el.labels && el.labels.length ? (el.labels[0].textContent || '').trim() : '') ||
          (el.getAttribute('placeholder') || '').trim() ||
          (el.getAttribute('aria-labelledby') &&
            document.getElementById(el.getAttribute('aria-labelledby')) ? 'ref' : '');
        if (!name) unnamed.push((el.id || el.className || el.tagName).toString().slice(0, 40));
      });

      // 4. Live regions exist for the things that change without a page move.
      const live = ['#toast', '#zoom-label', '#find-count', '#mode-banner']
        .filter((sel) => { const el = $(sel); return !el || !el.getAttribute('aria-live'); });

      return { badDialogs, dialogCount: backdrops.length, focusMovedIn, wrapped,
        focusRestored, unnamed, missingLive: live };
    });

    // ---- Mobile parity (Track F) ----
    // Android runs this exact renderer, so anything unreachable at phone width
    // is unreachable in the shipped app. Undo and Find were both in that state.
    result.mobile = await page.evaluate(async () => {
      const $ = (s) => document.querySelector(s);
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const findBtn = $('#btn-find');
      const undoBtn = $('#btn-undo');
      const redoBtn = $('#btn-redo');

      // Undo must become available after an edit and actually be reachable.
      App.History.reset();
      const undoDisabledAtRest = !!(undoBtn && undoBtn.disabled);
      App.History.snapshot();
      App.state.annotations.push({ id: 8801, page: 1, type: 'rect',
        pts: [{ vx: 20, vy: 20 }, { vx: 80, vy: 60 }],
        style: { stroke: '#e5473b', width: 2, opacity: 1 } });
      App.refreshChrome();
      const undoEnabledAfterEdit = !!(undoBtn && !undoBtn.disabled);

      // Marquee zoom is offered on touch, so it must respond to pointer events
      // rather than mouse-only ones.
      const marqueeUsesPointer = typeof PointerEvent !== 'undefined';
      App.Viewer.setMarquee(true);
      const vc = $('#viewerContainer');
      const armedTouchAction = getComputedStyle(vc).touchAction;
      vc.dispatchEvent(new PointerEvent('pointerdown',
        { pointerId: 1, clientX: 100, clientY: 200, bubbles: true, isPrimary: true }));
      window.dispatchEvent(new PointerEvent('pointermove',
        { pointerId: 1, clientX: 260, clientY: 340, bubbles: true }));
      const boxShown = !$('#marquee-box').classList.contains('hidden');
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
      App.Viewer.setMarquee(false);

      return {
        findVisible: visible(findBtn), undoVisible: visible(undoBtn), redoVisible: visible(redoBtn),
        undoDisabledAtRest, undoEnabledAfterEdit,
        marqueeUsesPointer, armedTouchAction, marqueeDragTracked: boxShown
      };
    });

    // ---- Layout at every supported size (Track D) ----
    // These specific breakages recur, so they get an automated sweep rather than
    // a one-time fix: nothing may overflow the viewport horizontally, and a tall
    // dialog's action buttons must stay on screen at every width AND height.
    result.layout = [];
    for (const vp of [
      { name: 'phone-320', w: 320, h: 640 },
      { name: 'phone-390', w: 390, h: 844 },
      { name: 'tablet-768', w: 768, h: 1024 },
      { name: 'laptop-short', w: 1400, h: 700 },   // the one that hid modal footers
      { name: 'desktop-1440', w: 1440, h: 900 }
    ]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(250);
      const r = await page.evaluate(async (v) => {
        const $ = (s) => document.querySelector(s);
        const tick = () => new Promise((r) => setTimeout(r, 120));
        const de = document.documentElement;
        const bodyOverflow = de.scrollWidth - de.clientWidth;

        // Find must fit fully on screen, including on a 320px phone.
        App.Viewer.openFind();
        await tick();
        const fb = $('#find-bar').getBoundingClientRect();
        const findOnScreen = fb.left >= -0.5 && fb.right <= v.w + 0.5;
        $('#find-close').click();
        await tick();

        // The tallest dialog: its footer buttons must be reachable.
        const modal = $('#digisign-modal');
        modal.classList.remove('hidden');
        await tick();
        const dlg = modal.querySelector('.modal');
        const go = $('#dsig-go');
        const dr = dlg.getBoundingClientRect();
        const gr = go.getBoundingClientRect();
        const modalFits = dr.height <= v.h + 0.5;
        const actionsReachable = gr.bottom <= v.h + 0.5 && gr.top >= -0.5 && gr.height > 0;
        modal.classList.add('hidden');
        await tick();

        return { name: v.name, bodyOverflow, findOnScreen, modalFits, actionsReachable };
      }, vp);
      result.layout.push(r);
    }
    await page.setViewportSize({ width: 1280, height: 800 });

  } finally {
    await browser.close();
    server.close();
  }

  const d = result.dropdowns || {};
  const dropdownsOk = d.measureAlone && d.swapped && d.swapped2 && d.selfClosed &&
    d.stickyOpen && d.escClosed && d.outsideClosed && d.maxOpen <= 1;
  const layout = result.layout || [];
  const layoutBad = layout.filter((l) => l.bodyOverflow > 1 || !l.findOnScreen ||
    !l.modalFits || !l.actionsReachable);
  const layoutOk = layout.length > 0 && layoutBad.length === 0;

  const a = result.a11y || {};
  const a11yOk = a.dialogCount > 0 && (a.badDialogs || []).length === 0 &&
    a.focusMovedIn && a.wrapped && a.focusRestored &&
    (a.unnamed || []).length === 0 && (a.missingLive || []).length === 0;

  const mob = result.mobile || {};
  const mobileOk = mob.findVisible && mob.undoVisible && mob.redoVisible &&
    mob.undoDisabledAtRest && mob.undoEnabledAfterEdit &&
    mob.marqueeDragTracked && mob.armedTouchAction === 'none';

  const ic = result.icons || {};
  const iconsOk = ic.symbolCount > 0 && ic.iconCount > 0 &&
    (ic.emojiOffenders || []).length === 0 && (ic.missingSymbols || []).length === 0;
  const ok = !errors.length && result.apiOk && result.numPages > 0 &&
    result.canvases > 0 && result.emptyHidden && result.bytesLen > 0 && !result.saveErr &&
    dropdownsOk && iconsOk && layoutOk && a11yOk && mobileOk;
  console.log('[verify-web] result:', JSON.stringify(result, null, 2));
  if (errors.length) console.log('[verify-web] page errors:\n' + errors.join('\n'));
  if (!dropdownsOk) console.log('[verify-web] dropdown exclusivity FAILED:', JSON.stringify(d));
  if (!iconsOk) console.log('[verify-web] icon system FAILED:', JSON.stringify(ic, null, 2));
  if (!layoutOk) console.log('[verify-web] layout FAILED at:', JSON.stringify(layoutBad, null, 2));
  if (!a11yOk) console.log('[verify-web] a11y FAILED:', JSON.stringify(a, null, 2));
  if (!mobileOk) console.log('[verify-web] mobile parity FAILED:', JSON.stringify(mob, null, 2));
  console.log(ok ? '\n[verify-web] PASS — bundle runs in a browser engine.' : '\n[verify-web] FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('[verify-web] harness error:', e); process.exit(1); });
