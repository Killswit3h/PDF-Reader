'use strict';

/*
 * Shared state + small helpers. Everything hangs off window.App so the
 * separate <script> modules can talk to each other without a bundler.
 */
window.App = window.App || {};

// Names of the attachments used for the editable round-trip: a JSON copy of the
// in-app marks and a pristine copy of the base PDF (see save.js / viewer.js).
App.SIDECAR = { MODEL: 'pdfsigner-model.json', BASE: 'pdfsigner-base.pdf' };

App.state = {
  // Source PDF
  pdfDoc: null, // pdf.js document proxy
  pdfBytes: null, // ArrayBuffer of the original file (for pdf-lib on save)
  fileName: null, // e.g. contract.pdf
  filePath: null,

  // View
  numPages: 0,
  currentPage: 1,
  zoom: 1.0, // render scale multiplier
  baseViewports: [], // unscaled (scale=1) viewport per page, index 0 == page 1

  // Rendering bookkeeping
  pageEls: [], // { holder, canvas, overlay } per page

  // Placement
  mode: null, // null | 'signature' | 'initials' | 'date'
  placements: [], // see placement.js
  selectedId: null,
  placementSeq: 0,

  // Remembered creations for quick re-place
  lastSignature: null, // { dataUrl, aspect }  transparent PNG
  lastInitials: null, // { dataUrl, aspect }

  // ---- Measurement feature ----
  // Per-page scale: { [page]: { factor, unit, ratioLabel } }
  // factor = real-world units per scale-1 viewport point.
  scales: {},
  // Per-page viewports (regions with their own scale):
  // { [page]: [ { id, vx, vy, vw, vh, factor, unit, ratioLabel, label } ] }
  viewports: {},
  // Measurement records (geometry in scale-1 viewport points, top-left origin):
  // { id, page, type, pts:[{vx,vy}], value, unit, label }
  measurements: [],
  measureSeq: 0,
  viewportSeq: 0,
  measureSelectedId: null,
  // What automatic scale detection found, per page. Derived from the open
  // document and NOT persisted to the sidecar — the scales it produces are,
  // via the `source`/`confidence`/`halfSize` fields on `scales` above.
  // { status, pages: { [page]: { state, source, candidates, reason, half } } }
  scaleDetect: { status: 'idle', pages: {} },

  // ---- Markup / annotation feature ----
  annotations: [],
  annoSeq: 0,
  annoSelectedId: null,
  annoStyle: null, // { stroke, fill, width, opacity, fontSize }
  annoUndo: [],
  annoRedo: [],
  // true = write real PDF annotations; false = flatten into page content.
  // Defaults ON: flattened marks are dead pixels to Bluebeam and Acrobat, and
  // the sidecar that keeps them editable here is an attachment any other tool
  // may strip. Real annotations are the only form that survives the trip. The
  // trade-off — a recipient can move or delete them in their copy — is accepted,
  // because the sender keeps the original.
  saveAnnots: true,

  // ---- OCR ----
  // Recognition results per page: { [page]: { status, dpi, words:[{text,vx,vy,vw,vh,conf}] } }
  // Geometry is in scale-1 viewport points like everything else. Populated by
  // ocr.js; kept after a run so Track B can edit recognized words on a scan.
  ocr: {},

  // Unsaved-changes flag — set on every edit (via App.History.snapshot), cleared
  // on save. Drives the "save before closing?" prompt in the main process.
  dirty: false
};

/* Units (App.UNITS), measurement formatting (App.fmtMeasure / App.computeValue),
 * date formatting (App.todayFormatted), and geometry (App.Geom) are provided by
 * the shared, unit-tested modules loaded ahead of this file:
 *   src/shared/geometry.js, measure-math.js, date-util.js
 */

App.$ = (sel) => document.querySelector(sel);
App.$$ = (sel) => Array.from(document.querySelectorAll(sel));

// -------- Icons --------
// Markup for one icon from the sprite in index.html. Modules that build rows and
// tiles with innerHTML call this instead of hand-rolling <svg>, so every icon in
// the app — static or generated — stays one edit away from the sprite.
//   App.icon('trash')            -> 16px
//   App.icon('rotate', 'ico-lg') -> 20px
// aria-hidden because the icon never carries the accessible name; its button
// does, via aria-label or visible text.
App.icon = (name, cls = '') =>
  `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// -------- Loading overlay --------
App.showLoading = (text) => {
  App.$('#loading-text').textContent = text || 'Loading…';
  App.$('#loading').classList.remove('hidden');
};
App.hideLoading = () => App.$('#loading').classList.add('hidden');

// -------- Toast --------
// A queue, not a single slot. The old version overwrote #toast's text and reset
// one shared timer, so opening five files showed only the last "Opened X", and —
// worse — a success message 200ms later erased an error the user had not read
// yet. Errors are the whole point of this surface, so they outlive successes and
// never get silently replaced.
const toastQueue = [];
let toastTimer = null;
let toastShowing = false;

function nextToast() {
  const el = App.$('#toast');
  if (!el) return;
  if (!toastQueue.length) {
    toastShowing = false;
    el.classList.add('hidden');
    return;
  }
  const { msg, kind, ms } = toastQueue.shift();
  toastShowing = true;
  el.textContent = msg;
  el.className = kind === 'info' ? '' : kind;
  // Errors are announced assertively so a screen reader interrupts; routine
  // confirmations wait their turn.
  el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hidden');
    // Let the fade finish before the next message swaps in, so two toasts in a
    // row read as two messages rather than one flickering box.
    setTimeout(nextToast, 180);
  }, ms);
}

// ms defaults by kind: an error the user must act on gets twice as long as a
// routine "Saved".
App.toast = (msg, kind = 'info', ms = null) => {
  const dur = ms != null ? ms : (kind === 'error' ? 7000 : 3200);
  toastQueue.push({ msg, kind, ms: dur });
  if (!toastShowing) nextToast();
};

// Dismiss whatever is showing and drop anything queued behind it. Used when the
// context that produced the messages goes away (document closed, modal cancelled).
App.clearToasts = () => {
  toastQueue.length = 0;
  clearTimeout(toastTimer);
  toastShowing = false;
  const el = App.$('#toast');
  if (el) el.classList.add('hidden');
};

// -------- Focus management --------
// Before this the app had no focus trap anywhere and exactly one focus restore
// in the whole codebase. Tab from the last field of any of the eleven dialogs
// walked straight into the toolbar behind the scrim, and closing one dropped
// focus on <body>, so a keyboard user lost their place every time.
//
// One helper, called from every open and close path, because a trap that works
// in some dialogs and not others is worse than none — keyboard users learn to
// distrust it.
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

// Visible focusable descendants, in DOM order.
App.focusablesIn = (root) => Array.from(root.querySelectorAll(FOCUSABLE))
  .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);

const traps = new Map();

// Trap Tab inside `root` until App.releaseFocus(root). `returnTo` defaults to
// whatever had focus when the trap was installed, which is almost always the
// control that opened the surface.
App.trapFocus = (root, returnTo) => {
  if (!root || traps.has(root)) return;
  const previous = returnTo || document.activeElement;
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = App.focusablesIn(root);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    // Focus may sit outside the trap (e.g. on <body> right after opening).
    if (!root.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener('keydown', onKey);
  traps.set(root, { onKey, previous });

  // Move focus in only if it is not already inside — several dialogs focus a
  // specific field themselves (the signature name, the find input, a password).
  if (!root.contains(document.activeElement)) {
    const items = App.focusablesIn(root);
    if (items.length) items[0].focus();
  }
};

// Remove the trap and hand focus back to whatever opened the surface.
App.releaseFocus = (root) => {
  const t = traps.get(root);
  if (!t) return;
  root.removeEventListener('keydown', t.onKey);
  traps.delete(root);
  const back = t.previous;
  if (back && document.contains(back) && typeof back.focus === 'function') {
    // Only restore if focus is still inside the surface being closed; if the
    // user has since clicked elsewhere, respect that.
    if (!document.activeElement || root.contains(document.activeElement) ||
        document.activeElement === document.body) {
      back.focus();
    }
  }
};

// Watch every .modal-backdrop and every side panel: when `hidden` goes away the
// surface is open, when it comes back it is closed. Wiring this to the class
// rather than to ~30 call sites means a dialog opened from anywhere — including
// code added later — gets the trap for free.
App.initFocusTraps = () => {
  const surfaces = Array.from(document.querySelectorAll('.modal-backdrop'));
  const sync = (el) => {
    const open = !el.classList.contains('hidden');
    if (open) App.trapFocus(el.querySelector('.modal') || el);
    else App.releaseFocus(el.querySelector('.modal') || el);
  };
  surfaces.forEach((el) => {
    new MutationObserver(() => sync(el))
      .observe(el, { attributes: true, attributeFilter: ['class'] });
    sync(el);
  });
};

// -------- Confirm dialog (Promise<boolean>) --------
// Themed replacement for window.confirm(); resolves false on Cancel/Esc.
App.confirm = (message, opts = {}) => {
  const { title = 'Confirm', okLabel = 'OK', danger = false } = opts;
  return new Promise((resolve) => {
    const modal = App.$('#confirm-modal');
    App.$('#confirm-title').textContent = title;
    App.$('#confirm-msg').textContent = message;
    const ok = App.$('#confirm-yes');
    const no = App.$('#confirm-no');
    ok.textContent = okLabel;
    ok.classList.toggle('danger', !!danger);
    modal.classList.remove('hidden');
    ok.focus();
    const cleanup = (result) => {
      modal.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      no.removeEventListener('click', onNo);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onNo = () => cleanup(false);
    ok.addEventListener('click', onOk);
    no.addEventListener('click', onNo);
  });
};

// -------- Lazy vendor libraries --------
// Heavy dependencies that aren't needed just to open and view a PDF are loaded
// on first use instead of at startup, to cut cold-start download + parse (most
// noticeable on the Android WebView). The vendor files are still bundled locally
// (offline-safe) — we only defer *when* the <script> runs. Electron resolves
// them from node_modules; the web/APK build copies them under vendor/ and sets
// window.PDFJS_VENDOR, which we use to pick the right path.
const VENDOR_LIBS = {
  // key: [ global the script defines, electron path, web/vendor path ]
  forge: ['forge', '../../node_modules/node-forge/dist/forge.min.js', 'vendor/node-forge/forge.min.js'],
  // OCR. Only the small UMD entry is deferred here; the WASM cores and the
  // language data (the ~13 MB that makes recognition work offline) are fetched
  // by tesseract's own worker from App.OCR_PATHS below, and only once the user
  // actually runs recognition.
  tesseract: ['Tesseract', '../../node_modules/tesseract.js/dist/tesseract.min.js', 'vendor/tesseract/tesseract.min.js']
};
const _libPromises = {};
App.ensureLib = function (key) {
  const spec = VENDOR_LIBS[key];
  if (!spec) return Promise.reject(new Error('unknown vendor lib: ' + key));
  const [globalName, electronPath, webPath] = spec;
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!_libPromises[key]) {
    _libPromises[key] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = window.PDFJS_VENDOR ? webPath : electronPath;
      s.onload = () => (window[globalName]
        ? resolve(window[globalName])
        : reject(new Error(key + ' loaded but window.' + globalName + ' is missing')));
      s.onerror = () => { _libPromises[key] = null; reject(new Error('failed to load ' + key)); };
      document.head.appendChild(s);
    });
  }
  return _libPromises[key];
};

// -------- Misc --------
App.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
