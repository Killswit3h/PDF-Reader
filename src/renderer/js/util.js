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

  // ---- Markup / annotation feature ----
  annotations: [],
  annoSeq: 0,
  annoSelectedId: null,
  annoStyle: null, // { stroke, fill, width, opacity, fontSize }
  annoUndo: [],
  annoRedo: [],
  saveAnnots: false, // true = write real PDF annotations; false = flatten

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

// -------- Loading overlay --------
App.showLoading = (text) => {
  App.$('#loading-text').textContent = text || 'Loading…';
  App.$('#loading').classList.remove('hidden');
};
App.hideLoading = () => App.$('#loading').classList.add('hidden');

// -------- Toast --------
let toastTimer = null;
App.toast = (msg, kind = 'info', ms = 3200) => {
  const el = App.$('#toast');
  el.textContent = msg;
  el.className = kind === 'info' ? '' : kind;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
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
  forge: ['forge', '../../node_modules/node-forge/dist/forge.min.js', 'vendor/node-forge/forge.min.js']
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
