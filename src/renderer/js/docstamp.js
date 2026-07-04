'use strict';

/*
 * Document stamps — Bates/page numbering, header & footer text, watermark.
 *
 * Renderer-only (Tier A): a config object drives a live preview overlay (DOM in
 * each page's markup-layer) and the pdf-lib drawing at save time (applyToPdf,
 * called from save.js). Same code path on desktop and the Android WebView.
 *
 * Config (App.state.docStamp), persisted in Prefs so the last setup is remembered:
 *   number:    { on, prefix, start, digits, pos, size }   pos: tl|tr|bl|br
 *   header:    { on, text, size }                          (top-centre)
 *   footer:    { on, text, size }                          (bottom-centre)
 *   watermark: { on, text, size, opacity, angle, color }   (centre, rotated)
 *   range:     { mode:'all'|'range', from, to }
 */
(function () {
  const D = {};
  const MARGIN = 24; // points from the page edge

  function def() {
    return {
      number: { on: false, prefix: '', start: 1, digits: 0, pos: 'br', size: 10 },
      header: { on: false, text: '', size: 10 },
      footer: { on: false, text: '', size: 10 },
      watermark: { on: false, text: 'DRAFT', size: 60, opacity: 0.15, angle: 45, color: '#e5484d' },
      range: { mode: 'all', from: 1, to: 0 }
    };
  }

  function cfg() {
    if (App.state.docStamp) return App.state.docStamp;
    const saved = App.Prefs ? App.Prefs.get('docStamp', null) : null;
    return (App.state.docStamp = saved ? Object.assign(def(), saved) : def());
  }
  D.config = cfg;
  D.hasAny = function () { const c = cfg(); return !!(c.number.on || c.header.on || c.footer.on || c.watermark.on); };

  // Is a 1-based page number inside the configured range?
  function inRange(pageNo, numPages) {
    const r = cfg().range;
    if (r.mode !== 'range') return true;
    const to = r.to && r.to > 0 ? r.to : numPages;
    return pageNo >= (r.from || 1) && pageNo <= to;
  }
  // Sequence index (0-based) of a page within the active range — drives numbering.
  function seqIndex(pageNo) {
    const r = cfg().range;
    const from = r.mode === 'range' ? (r.from || 1) : 1;
    return pageNo - from;
  }
  function numberText(pageNo) {
    const n = cfg().number;
    let s = String(n.start + seqIndex(pageNo));
    if (n.digits > 0) while (s.length < n.digits) s = '0' + s;
    return (n.prefix || '') + s;
  }

  function hexTriplet(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const v = m ? parseInt(m[1], 16) : 0xe5484d;
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  /* ---------------- live preview overlay ---------------- */
  D.repositionAll = function () {
    const z = App.state.zoom || 1;
    const c = cfg();
    (App.state.pageEls || []).forEach((pe, i) => {
      if (!pe || !pe.holder) return;
      pe.holder.querySelectorAll('.stamp-preview').forEach((el) => el.remove());
      if (!D.hasAny()) return;
      const pageNo = i + 1;
      const inR = inRange(pageNo, App.state.numPages);
      const add = (text, css, extra) => {
        const el = document.createElement('div');
        el.className = 'stamp-preview';
        el.textContent = text;
        Object.assign(el.style, css);
        if (extra) Object.assign(el.style, extra);
        pe.holder.appendChild(el);
      };
      const m = MARGIN * z + 'px';
      if (inR && c.number.on) add(numberText(pageNo), cornerCss(c.number.pos, m), { fontSize: c.number.size * z + 'px' });
      if (inR && c.header.on && c.header.text) add(c.header.text, cornerCss('tc', m), { fontSize: c.header.size * z + 'px' });
      if (inR && c.footer.on && c.footer.text) add(c.footer.text, cornerCss('bc', m), { fontSize: c.footer.size * z + 'px' });
      if (inR && c.watermark.on && c.watermark.text) {
        add(c.watermark.text, {
          left: '50%', top: '50%',
          transform: `translate(-50%,-50%) rotate(${-c.watermark.angle}deg)`,
          color: c.watermark.color, opacity: String(c.watermark.opacity),
          fontSize: c.watermark.size * z + 'px', fontWeight: '700', whiteSpace: 'nowrap'
        });
      }
    });
  };

  function cornerCss(pos, m) {
    switch (pos) {
      case 'tl': return { left: m, top: m };
      case 'tr': return { right: m, top: m };
      case 'bl': return { left: m, bottom: m };
      case 'br': return { right: m, bottom: m };
      case 'tc': return { left: '50%', top: m, transform: 'translateX(-50%)' };
      case 'bc': return { left: '50%', bottom: m, transform: 'translateX(-50%)' };
      default: return { left: m, top: m };
    }
  }

  /* ---------------- pdf-lib drawing (save time) ---------------- */
  // Draw the configured stamps onto every page of `pdfDoc`. Called by save.js.
  D.applyToPdf = function (pdfDoc, font) {
    if (!D.hasAny()) return;
    const { rgb, degrees } = window.PDFLib;
    const c = cfg();
    const pages = pdfDoc.getPages();
    const total = pages.length;
    pages.forEach((page, idx) => {
      const pageNo = idx + 1;
      if (!inRange(pageNo, total)) return;
      const { width: W, height: H } = page.getSize();
      const black = rgb(0.1, 0.1, 0.1);

      const drawAt = (text, size, pos) => {
        const tw = font.widthOfTextAtSize(text, size);
        let x, y;
        const top = H - MARGIN - size, bot = MARGIN;
        if (pos === 'tl') { x = MARGIN; y = top; }
        else if (pos === 'tr') { x = W - MARGIN - tw; y = top; }
        else if (pos === 'bl') { x = MARGIN; y = bot; }
        else if (pos === 'br') { x = W - MARGIN - tw; y = bot; }
        else if (pos === 'tc') { x = (W - tw) / 2; y = top; }
        else { x = (W - tw) / 2; y = bot; } // bc
        page.drawText(text, { x, y, size, font, color: black });
      };

      if (c.number.on) drawAt(numberText(pageNo), c.number.size, c.number.pos);
      if (c.header.on && c.header.text) drawAt(c.header.text, c.header.size, 'tc');
      if (c.footer.on && c.footer.text) drawAt(c.footer.text, c.footer.size, 'bc');

      if (c.watermark.on && c.watermark.text) {
        const size = c.watermark.size;
        const tw = font.widthOfTextAtSize(c.watermark.text, size);
        const rad = (c.watermark.angle * Math.PI) / 180;
        const originX = W / 2 - (tw / 2) * Math.cos(rad);
        const originY = H / 2 - (tw / 2) * Math.sin(rad) - size * 0.35;
        const [r, g, b] = hexTriplet(c.watermark.color);
        page.drawText(c.watermark.text, {
          x: originX, y: originY, size, font,
          color: rgb(r, g, b), rotate: degrees(c.watermark.angle), opacity: c.watermark.opacity
        });
      }
    });
  };

  /* ---------------- modal ---------------- */
  function readForm() {
    const c = cfg();
    const val = (id) => App.$(id) ? App.$(id).value : '';
    const chk = (id) => App.$(id) ? App.$(id).checked : false;
    const num = (id, d) => { const v = parseFloat(val(id)); return isNaN(v) ? d : v; };
    c.number = { on: chk('#ds-num-on'), prefix: val('#ds-num-prefix'), start: Math.round(num('#ds-num-start', 1)), digits: Math.round(num('#ds-num-digits', 0)), pos: val('#ds-num-pos') || 'br', size: num('#ds-num-size', 10) };
    c.header = { on: chk('#ds-hdr-on'), text: val('#ds-hdr-text'), size: num('#ds-hdr-size', 10) };
    c.footer = { on: chk('#ds-ftr-on'), text: val('#ds-ftr-text'), size: num('#ds-ftr-size', 10) };
    c.watermark = { on: chk('#ds-wm-on'), text: val('#ds-wm-text'), size: num('#ds-wm-size', 60), opacity: App.clamp(num('#ds-wm-opacity', 15) / 100, 0.02, 1), angle: num('#ds-wm-angle', 45), color: val('#ds-wm-color') || '#e5484d' };
    c.range = { mode: val('#ds-range-mode') || 'all', from: Math.round(num('#ds-range-from', 1)), to: Math.round(num('#ds-range-to', 0)) };
    if (App.Prefs) App.Prefs.set('docStamp', c);
  }

  function fillForm() {
    const c = cfg();
    const set = (id, v) => { const el = App.$(id); if (el) el.value = v; };
    const setc = (id, v) => { const el = App.$(id); if (el) el.checked = !!v; };
    setc('#ds-num-on', c.number.on); set('#ds-num-prefix', c.number.prefix); set('#ds-num-start', c.number.start); set('#ds-num-digits', c.number.digits); set('#ds-num-pos', c.number.pos); set('#ds-num-size', c.number.size);
    setc('#ds-hdr-on', c.header.on); set('#ds-hdr-text', c.header.text); set('#ds-hdr-size', c.header.size);
    setc('#ds-ftr-on', c.footer.on); set('#ds-ftr-text', c.footer.text); set('#ds-ftr-size', c.footer.size);
    setc('#ds-wm-on', c.watermark.on); set('#ds-wm-text', c.watermark.text); set('#ds-wm-size', c.watermark.size); set('#ds-wm-opacity', Math.round(c.watermark.opacity * 100)); set('#ds-wm-angle', c.watermark.angle); set('#ds-wm-color', c.watermark.color);
    set('#ds-range-mode', c.range.mode); set('#ds-range-from', c.range.from); set('#ds-range-to', c.range.to);
    setc('#ds-flatten', App.state.flattenForms);
  }

  D.open = function () {
    if (!App.state.pdfDoc) return;
    fillForm();
    App.$('#docstamp-modal').classList.remove('hidden');
  };
  function closeModal() { App.$('#docstamp-modal').classList.add('hidden'); }

  D.init = function () {
    const b = (id, fn) => { const el = App.$(id); if (el) el.addEventListener('click', fn); };
    b('#ds-close', closeModal);
    b('#ds-cancel', closeModal);
    b('#ds-apply', () => {
      readForm();
      App.state.flattenForms = App.$('#ds-flatten') ? App.$('#ds-flatten').checked : false;
      closeModal();
      D.repositionAll();
      if (App.state.pdfDoc) App.$('#btn-save').disabled = false;
      App.toast(D.hasAny() ? 'Stamps set — applied when you Save.' : 'Stamps cleared.', 'success', 3500);
    });
    b('#ds-clear', () => {
      App.state.docStamp = def();
      if (App.Prefs) App.Prefs.set('docStamp', App.state.docStamp);
      fillForm();
      D.repositionAll();
    });
  };

  App.DocStamp = D;
})();
