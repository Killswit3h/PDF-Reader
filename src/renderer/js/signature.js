'use strict';

/*
 * Signature-creation modal. Three input modes:
 *   - Type   : full name rendered in a handwriting font
 *   - Initials: same, but tuned for a short initial block
 *   - Draw   : freehand via signature_pad
 * Output is always a trimmed, transparent PNG: { dataUrl, aspect } where
 * aspect = width / height. Callers use aspect to size the placement box.
 */
(function () {
  const FONTS = [
    { family: 'Dancing Script', label: 'Dancing Script' },
    { family: 'Great Vibes', label: 'Great Vibes' }
  ];

  const Sig = {
    purpose: 'signature', // or 'initials'
    font: FONTS[0].family,
    pad: null, // signature_pad instance
    resolve: null
  };

  // ---------- Public: open the modal ----------
  Sig.open = function (purpose) {
    Sig.purpose = purpose;
    const isInit = purpose === 'initials';

    App.$('#sig-modal-title').textContent = isInit ? 'Add Initials' : 'Add Signature';
    App.$('#type-input-label').textContent = isInit ? 'Your initials' : 'Your name';
    const input = App.$('#sig-type-input');
    input.placeholder = isInit ? 'e.g. JAD' : 'Type your name';
    input.maxLength = isInit ? 6 : 40;

    // Prefill from the last-used creation of this kind, if any.
    const last = isInit ? App.state._lastInitialsText : App.state._lastSignatureText;
    input.value = last || '';

    Sig._buildFontChoices();
    Sig._switchTab('type');
    Sig._updateTypePreview();

    App.$('#sig-modal').classList.remove('hidden');
    setTimeout(() => input.focus(), 30);

    return new Promise((res) => { Sig.resolve = res; });
  };

  Sig._close = function (result) {
    App.$('#sig-modal').classList.add('hidden');
    if (Sig.pad) { Sig.pad.off(); Sig.pad = null; }
    const r = Sig.resolve;
    Sig.resolve = null;
    if (r) r(result || null);
  };

  // ---------- Tabs ----------
  Sig._switchTab = function (tab) {
    App.$$('.sig-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    App.$$('.sig-panel').forEach((p) =>
      p.classList.toggle('hidden', p.dataset.panel !== tab));
    if (tab === 'draw') Sig._initDrawPad();
  };

  // ---------- Font picker ----------
  Sig._buildFontChoices = function () {
    const wrap = App.$('#font-choices');
    wrap.innerHTML = '';
    FONTS.forEach((f, i) => {
      const el = document.createElement('div');
      el.className = 'font-choice' + (f.family === Sig.font ? ' active' : '');
      el.style.fontFamily = `'${f.family}'`;
      el.textContent = App.$('#sig-type-input').value || 'Signature';
      const tag = document.createElement('small');
      tag.textContent = f.label;
      el.appendChild(tag);
      el.addEventListener('click', () => {
        Sig.font = f.family;
        Sig._buildFontChoices();
        Sig._updateTypePreview();
      });
      wrap.appendChild(el);
    });
  };

  // ---------- Live typed preview (CSS; rasterized on "done") ----------
  Sig._updateTypePreview = function () {
    const text = App.$('#sig-type-input').value.trim();
    const prev = App.$('#sig-type-preview');
    // keep the font-choice tiles in sync with the current text
    App.$$('#font-choices .font-choice').forEach((el) => {
      const tag = el.querySelector('small');
      el.textContent = text || 'Signature';
      if (tag) el.appendChild(tag);
    });
    if (!text) {
      prev.classList.add('empty');
      prev.textContent = '';
      return;
    }
    prev.classList.remove('empty');
    prev.style.fontFamily = `'${Sig.font}'`;
    prev.style.fontSize = Sig.purpose === 'initials' ? '72px' : '54px';
    prev.textContent = text;
  };

  // ---------- Draw pad ----------
  Sig._initDrawPad = function () {
    const canvas = App.$('#sig-draw-canvas');
    // Size backing store to the CSS box for crisp strokes.
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);

    if (Sig.pad) Sig.pad.off();
    Sig.pad = new window.SignaturePad(canvas, {
      backgroundColor: 'rgba(0,0,0,0)', // transparent
      penColor: App.$('#sig-ink-color').value,
      minWidth: 1.1,
      maxWidth: 3.0
    });
  };

  // ---------- Rasterize helpers ----------
  // Crop a canvas to the bounding box of non-transparent pixels.
  function trimCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const data = ctx.getImageData(0, 0, w, h).data;
    let top = h, left = w, right = 0, bottom = 0, found = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] !== 0) {
          found = true;
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    if (!found) return null;
    const pad = 6;
    left = Math.max(0, left - pad); top = Math.max(0, top - pad);
    right = Math.min(w - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);
    const cw = right - left + 1, ch = bottom - top + 1;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
    return out;
  }

  // Render typed text to a trimmed transparent PNG.
  async function renderTyped(text, family) {
    // Ensure the font is actually loaded before measuring/drawing.
    try { await document.fonts.load(`160px "${family}"`, text); } catch (_) {}
    await document.fonts.ready;

    const size = 200;
    const scratch = document.createElement('canvas');
    let ctx = scratch.getContext('2d');
    ctx.font = `${size}px "${family}"`;
    const m = ctx.measureText(text);
    const ascent = m.actualBoundingBoxAscent || size * 0.8;
    const descent = m.actualBoundingBoxDescent || size * 0.35;
    const pad = 40;
    scratch.width = Math.ceil(m.width) + pad * 2;
    scratch.height = Math.ceil(ascent + descent) + pad * 2;

    ctx = scratch.getContext('2d');
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.font = `${size}px "${family}"`;
    ctx.fillStyle = '#0d1b3e';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, pad, pad + ascent);

    const trimmed = trimCanvas(scratch) || scratch;
    return {
      dataUrl: trimmed.toDataURL('image/png'),
      aspect: trimmed.width / trimmed.height
    };
  }

  function renderDrawn() {
    const canvas = App.$('#sig-draw-canvas');
    if (Sig.pad && Sig.pad.isEmpty()) return null;
    const trimmed = trimCanvas(canvas);
    if (!trimmed) return null;
    return { dataUrl: trimmed.toDataURL('image/png'), aspect: trimmed.width / trimmed.height };
  }

  // ---------- Wire up controls once ----------
  Sig.init = function () {
    App.$('#sig-close').addEventListener('click', () => Sig._close(null));
    App.$('#sig-cancel').addEventListener('click', () => Sig._close(null));
    App.$('#sig-modal').addEventListener('mousedown', (e) => {
      if (e.target.id === 'sig-modal') Sig._close(null);
    });

    App.$$('.sig-tab').forEach((b) =>
      b.addEventListener('click', () => Sig._switchTab(b.dataset.tab)));

    App.$('#sig-type-input').addEventListener('input', Sig._updateTypePreview);

    App.$('#sig-clear').addEventListener('click', () => Sig.pad && Sig.pad.clear());
    App.$('#sig-ink-color').addEventListener('input', (e) => {
      if (Sig.pad) Sig.pad.penColor = e.target.value;
    });

    App.$('#sig-done').addEventListener('click', async () => {
      const activeTab = App.$('.sig-tab.active').dataset.tab;
      let result = null;

      if (activeTab === 'type') {
        const text = App.$('#sig-type-input').value.trim();
        if (!text) { App.toast('Type something first.', 'error'); return; }
        if (Sig.purpose === 'initials') App.state._lastInitialsText = text;
        else App.state._lastSignatureText = text;
        result = await renderTyped(text, Sig.font);
      } else {
        result = renderDrawn();
        if (!result) { App.toast('Draw a signature first.', 'error'); return; }
      }
      Sig._close(result);
    });
  };

  App.Signature = Sig;
})();
