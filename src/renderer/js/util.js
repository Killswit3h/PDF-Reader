'use strict';

/*
 * Shared state + small helpers. Everything hangs off window.App so the
 * separate <script> modules can talk to each other without a bundler.
 */
window.App = window.App || {};

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
  lastInitials: null // { dataUrl, aspect }
};

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

// -------- Misc --------
App.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Two-decimal date in MM/DD/YYYY
App.todayFormatted = () => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
};
