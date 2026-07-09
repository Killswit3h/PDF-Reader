'use strict';

/*
 * Select-to-copy for the PDF text layer.
 *
 * PDF.js renders a transparent, selectable text layer over each page; the app
 * chrome otherwise sets user-select:none. This module surfaces a small floating
 * "Copy" button whenever the user selects page text, and wires Ctrl/Cmd+C — so
 * text can be lifted out of a PDF the way you'd expect in any reader.
 *
 * Renderer-only (Selection API + clipboard), so it ships to all three platforms.
 */
(function () {
  const T = {};
  const $ = (s) => App.$(s);

  // The current selection as trimmed text, but only when it lives inside the
  // PDF text layer (ignore stray selections elsewhere in the chrome).
  function pdfSelectionText() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    const node = sel.anchorNode;
    const host = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!host || !host.closest || !host.closest('.textLayer')) return '';
    return String(sel).replace(/\s+\n/g, '\n').trim();
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through to execCommand */ }
    try { return document.execCommand('copy'); } catch (_) { return false; }
  }

  function hideFab() { const f = $('#copy-fab'); if (f) f.classList.add('hidden'); }

  function positionFab() {
    const fab = $('#copy-fab');
    if (!fab) return;
    const text = pdfSelectionText();
    if (!text) { hideFab(); return; }
    const sel = window.getSelection();
    const rects = sel.getRangeAt(0).getClientRects();
    const r = rects[rects.length - 1] || sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { hideFab(); return; }
    fab.style.left = Math.round(r.right) + 'px';
    fab.style.top = Math.round(r.top - 6) + 'px';
    fab.classList.remove('hidden');
  }

  async function doCopy(fromButton) {
    const text = pdfSelectionText();
    if (!text) return false;
    const ok = await copyText(text);
    App.toast(ok ? 'Copied text to clipboard' : 'Could not access the clipboard',
      ok ? 'success' : 'error');
    if (fromButton && window.getSelection) {
      try { window.getSelection().removeAllRanges(); } catch (_) { /* ignore */ }
    }
    hideFab();
    return ok;
  }

  T.init = function () {
    const fab = $('#copy-fab');
    if (!fab) return;

    // Show/replace the button as the selection changes; a short debounce keeps
    // it from flickering mid-drag.
    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; positionFab(); });
    };
    document.addEventListener('selectionchange', schedule);
    // Scrolling the viewer moves the selection under the button — keep it glued.
    const vc = $('#viewerContainer');
    if (vc) vc.addEventListener('scroll', () => { if (!fab.classList.contains('hidden')) positionFab(); }, { passive: true });

    fab.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection alive
    fab.addEventListener('click', () => doCopy(true));

    // Ctrl/Cmd+C copies the page-text selection with feedback (and stops the
    // event before the app's other shortcut handling sees it).
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'c') {
        if (pdfSelectionText()) { e.preventDefault(); e.stopPropagation(); doCopy(false); }
      }
    }, true);

    // A click that clears the selection also dismisses the button.
    document.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('#copy-fab')) return;
      setTimeout(() => { if (!pdfSelectionText()) hideFab(); }, 0);
    });
  };

  App.TextCopy = T;
})();
