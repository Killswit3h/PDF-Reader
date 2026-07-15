'use strict';

/*
 * Digital Signature tool — applies a real PKI / PAdES signature to the document
 * using the user's PKCS#12 (.p12/.pfx) digital ID, via the offline signing
 * engine in src/shared/pdf-sign.js. Distinct from the app's cosmetic
 * signatures: this cryptographically binds the signer's identity to the
 * document and makes tampering detectable (Adobe shows the signature panel;
 * a trusted CA cert shows the green "valid" state).
 *
 * UX: the dialog is built around *saved identities* (src/shared/digital-ids.js).
 * Attach a .p12 once, opt to remember it, and next time it's a click — the key,
 * password (if you chose to save it) and signer details are already filled in.
 * You can keep several IDs and switch between them, or attach a one-off ID
 * without saving anything. The visible-signature choice is a placement picker
 * (Invisible / Click to place / Pin to a corner) with a live preview, rather
 * than a bare toggle plus a position dropdown.
 *
 * Security: the .p12 bytes live in this module's memory while the dialog is
 * open and are wiped on close. A saved ID persists on this device only (via
 * App.Prefs / localStorage) — the passphrase is stored only when the user ticks
 * "Also save the password". Nothing is written elsewhere or transmitted;
 * signing is entirely local (offline).
 *
 * Renderer-only, so it ships to Windows, macOS and Android from one file.
 */
(function () {
  const D = {};
  const $ = (s) => App.$(s);
  const store = () => App.DigitalIds;   // shared saved-ID store (bound to Prefs)

  // Working state for the open dialog.
  let p12Bytes = null;      // active key bytes (from a saved ID or a picked file)
  let activeId = null;      // id of the selected saved identity, or null (fresh)
  let presetName = null;    // display file name of the active identity
  let savedPass = null;     // remembered passphrase for the active saved ID
  let selectedCorner = 'br';

  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const fromB64 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

  // Effective passphrase: what's typed, else the remembered one for a saved ID.
  const getPass = () => ($('#dsig-pass').value || savedPass || '');

  // Adobe-style date for the preview, e.g. "2026.07.15 14:22:00 -04'00'".
  function previewDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' +
      sign + p(Math.floor(Math.abs(off) / 60)) + "'" + p(Math.abs(off) % 60) + "'";
  }

  function setStatus(msg, kind) {
    const s = $('#dsig-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'dsig-status' + (kind ? ' ' + kind : '');
  }

  function updateReady() {
    const go = $('#dsig-go');
    if (go) go.disabled = !(p12Bytes && getPass());
  }

  function modeVal() {
    const el = document.querySelector('input[name="dsig-mode"]:checked');
    return (el && el.value) || 'none';
  }

  /* ---------- visible-signature placement ---------- */
  function syncMode() {
    const mode = modeVal();
    $('#dsig-corner-opts').classList.toggle('hidden', mode !== 'corner');
    $('#dsig-preview').classList.toggle('hidden', mode === 'none');
    updatePreview();
  }

  function updatePreview() {
    const name = ($('#dsig-name').value.trim()) || 'Signer';
    const nameEl = document.querySelector('#dsig-preview .dsig-preview-name');
    const inlineEl = document.querySelector('#dsig-preview .dsig-preview-name-inline');
    const dateEl = document.querySelector('#dsig-preview .dsig-preview-date');
    if (nameEl) nameEl.textContent = name;
    if (inlineEl) inlineEl.textContent = name;
    if (dateEl) dateEl.textContent = 'Date: ' + previewDate(new Date());
  }

  function selectCorner(corner) {
    selectedCorner = corner;
    document.querySelectorAll('.dsig-corner-btn').forEach((b) => {
      b.classList.toggle('selected', b.dataset.corner === corner);
    });
  }

  /* ---------- saved identities ---------- */
  // Populate the saved-ID chip list. Returns the number of saved IDs.
  function renderIdList() {
    const list = $('#dsig-id-list');
    const items = (store() && store().list()) || [];
    if (!list) return items.length;
    list.textContent = '';
    items.forEach((it) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dsig-id' + (it.id === activeId ? ' selected' : '');
      row.dataset.id = it.id;
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', it.id === activeId ? 'true' : 'false');

      const dot = document.createElement('span');
      dot.className = 'dsig-id-radio';
      const text = document.createElement('span');
      text.className = 'dsig-id-text';
      const label = document.createElement('span');
      label.className = 'dsig-id-label';
      label.textContent = it.label || 'Digital ID';
      const sub = document.createElement('span');
      sub.className = 'dsig-id-sub';
      const bits = [];
      if (it.fileName) bits.push(it.fileName);
      bits.push(it.savePass ? 'password saved' : 'password each time');
      sub.textContent = bits.join(' · ');
      text.appendChild(label); text.appendChild(sub);

      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'dsig-id-forget';
      forget.title = 'Forget this digital ID';
      forget.setAttribute('aria-label', 'Forget ' + (it.label || 'digital ID'));
      forget.textContent = 'Forget';
      forget.addEventListener('click', (e) => { e.stopPropagation(); forgetId(it.id); });

      row.appendChild(dot); row.appendChild(text); row.appendChild(forget);
      row.addEventListener('click', () => selectId(it.id));
      list.appendChild(row);
    });
    return items.length;
  }

  // Load a saved identity into the form and switch to "saved" mode.
  function selectId(id) {
    const it = store() && store().get(id);
    if (!it) return;
    activeId = id;
    try { p12Bytes = fromB64(it.p12); } catch (_) { p12Bytes = null; }
    presetName = it.fileName || it.label || 'saved digital ID';
    $('#dsig-name').value = it.name || '';
    $('#dsig-reason').value = it.reason || '';
    $('#dsig-loc').value = it.location || '';
    const pass = $('#dsig-pass');
    pass.value = '';
    if (it.savePass && it.pass) {
      savedPass = it.pass;
      pass.placeholder = 'Saved on this device — leave blank to reuse';
    } else {
      savedPass = null;
      pass.placeholder = 'Password for your digital ID';
    }
    // Mark the chosen chip, hide the attach form.
    document.querySelectorAll('.dsig-id').forEach((r) => {
      const on = r.dataset.id === id;
      r.classList.toggle('selected', on);
      r.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    $('#dsig-new').classList.add('hidden');
    if (!savedPass) { try { pass.focus(); } catch (_) { /* focus best-effort */ } }
    updatePreview();
    updateReady();
  }

  function forgetId(id) {
    if (!store()) return;
    store().remove(id);
    if (activeId === id) { activeId = null; p12Bytes = null; savedPass = null; }
    const remaining = renderIdList();
    if (remaining) {
      if (!activeId) selectId(store().active().id);
      $('#dsig-saved-wrap').classList.remove('hidden');
      $('#dsig-new').classList.add('hidden');
    } else {
      $('#dsig-saved-wrap').classList.add('hidden');
      enterAttachMode(false);
    }
    updateReady();
  }

  // Show the "attach a new digital ID" form (optionally keeping saved list up
  // top with a "back" link when other IDs exist).
  function enterAttachMode(hasSaved) {
    activeId = null; p12Bytes = null; presetName = null; savedPass = null;
    const p12 = $('#dsig-p12'); if (p12) p12.value = '';
    const pass = $('#dsig-pass'); pass.value = ''; pass.placeholder = 'Password for your digital ID';
    $('#dsig-name').value = ''; $('#dsig-reason').value = ''; $('#dsig-loc').value = '';
    $('#dsig-remember').checked = true;
    $('#dsig-label').value = '';
    $('#dsig-savepass').checked = true;
    syncRememberOpts();
    document.querySelectorAll('.dsig-id').forEach((r) => { r.classList.remove('selected'); r.setAttribute('aria-checked', 'false'); });
    $('#dsig-new').classList.remove('hidden');
    $('#dsig-use-saved').classList.toggle('hidden', !hasSaved);
    updatePreview();
    updateReady();
  }

  function syncRememberOpts() {
    $('#dsig-remember-opts').classList.toggle('hidden', !$('#dsig-remember').checked);
  }

  // Wipe sensitive material from memory + the DOM.
  function wipe() {
    p12Bytes = null; savedPass = null;
    const pass = $('#dsig-pass');
    if (pass) pass.value = '';
  }

  function close() {
    $('#digisign-modal').classList.add('hidden');
    wipe();
  }

  D.init = function () {
    const fileInput = $('#dsig-p12');
    if (!fileInput) return;   // markup not present (shouldn't happen)
    fileInput.addEventListener('change', async () => {
      p12Bytes = null; activeId = null; savedPass = null;
      const f = fileInput.files && fileInput.files[0];
      if (f) {
        try { p12Bytes = new Uint8Array(await f.arrayBuffer()); presetName = f.name; }
        catch (_) { setStatus('Could not read that file.', 'err'); }
        if (!$('#dsig-label').value.trim() && f.name) $('#dsig-label').value = f.name.replace(/\.(p12|pfx)$/i, '');
      }
      updateReady();
    });
    $('#dsig-pass').addEventListener('input', updateReady);
    $('#dsig-name').addEventListener('input', updatePreview);
    $('#dsig-remember').addEventListener('change', syncRememberOpts);
    $('#dsig-add-new').addEventListener('click', () => enterAttachMode(true));
    $('#dsig-use-saved').addEventListener('click', () => {
      $('#dsig-new').classList.add('hidden');
      const a = store() && store().active();
      if (a) selectId(a.id);
      updateReady();
    });
    document.querySelectorAll('input[name="dsig-mode"]').forEach((r) => r.addEventListener('change', syncMode));
    document.querySelectorAll('.dsig-corner-btn').forEach((b) => b.addEventListener('click', () => selectCorner(b.dataset.corner)));
    $('#dsig-cancel').addEventListener('click', close);
    $('#dsig-close').addEventListener('click', close);
    $('#dsig-go').addEventListener('click', sign);
  };

  D.open = function () {
    if (!App.state.pdfDoc) { App.toast('Open a PDF first.', 'error'); return; }
    // Reset fields + placement.
    ['#dsig-p12', '#dsig-pass', '#dsig-name', '#dsig-reason', '#dsig-loc', '#dsig-label'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    $('#dsig-pass').placeholder = 'Password for your digital ID';
    const noneRadio = document.querySelector('input[name="dsig-mode"][value="none"]');
    if (noneRadio) noneRadio.checked = true;
    selectCorner('br');
    const pageEl = $('#dsig-page');
    pageEl.value = String(App.state.currentPage || 1);
    pageEl.max = String(App.state.numPages || 1);
    p12Bytes = null; activeId = null; presetName = null; savedPass = null;
    setStatus('');
    syncMode();

    // Show saved IDs if any; otherwise the attach form.
    const count = renderIdList();
    if (count) {
      $('#dsig-saved-wrap').classList.remove('hidden');
      $('#dsig-new').classList.add('hidden');
      const a = store().active();
      if (a) selectId(a.id);
    } else {
      $('#dsig-saved-wrap').classList.add('hidden');
      enterAttachMode(false);
    }

    updateReady();
    $('#digisign-modal').classList.remove('hidden');
  };

  // Persist (or refresh) the saved identity after a successful signing.
  D._onSigned = function () {
    if (!store() || !p12Bytes) return;
    const name = $('#dsig-name').value.trim();
    const reason = $('#dsig-reason').value.trim();
    const location = $('#dsig-loc').value.trim();
    if (activeId) {
      // Refresh the existing identity's details (keep its remember/pass policy).
      const it = store().get(activeId);
      if (!it) return;
      store().save({
        id: it.id, label: it.label, fileName: it.fileName || presetName,
        p12: toB64(p12Bytes), savePass: it.savePass, pass: getPass(),
        name, reason, location
      });
    } else if ($('#dsig-remember') && $('#dsig-remember').checked) {
      // Freshly attached ID the user chose to remember.
      const saved = store().save({
        label: $('#dsig-label').value.trim(), fileName: presetName || 'digital ID',
        p12: toB64(p12Bytes), savePass: !!($('#dsig-savepass') && $('#dsig-savepass').checked),
        pass: getPass(), name, reason, location
      });
      activeId = saved.id;
    }
  };

  // Gather the passphrase + identity fields from the dialog.
  function gatherOpts() {
    return {
      passphrase: getPass(),
      name: $('#dsig-name').value.trim(),
      reason: $('#dsig-reason').value.trim(),
      location: $('#dsig-loc').value.trim()
    };
  }

  function reopenForRetry() { $('#digisign-modal').classList.remove('hidden'); }

  function sign() {
    if (!p12Bytes || !getPass()) return;
    const opts = gatherOpts();
    const mode = modeVal();
    if (mode === 'click') {
      // Free placement: leave the dialog, let the user click a spot on the page.
      armPlaceOnPage(opts);
      return;
    }
    if (mode === 'corner') {
      const pageIndex = Math.max(0, Math.min((App.state.numPages || 1) - 1, (parseInt($('#dsig-page').value, 10) || 1) - 1));
      opts.visible = {
        pageIndex, corner: selectedCorner,
        name: opts.name || 'Signer', reason: opts.reason, location: opts.location
      };
    }
    doSign(opts);
  }

  // Build the document, apply the signature with `opts`, and save it into the
  // file being worked on (in place; falls back to Save As for raw-bytes docs).
  async function doSign(opts) {
    $('#dsig-go').disabled = true;
    setStatus('Building document…');
    try {
      // A signed document is final: build it flattened, with no editable sidecar
      // (an embedded editable copy would let a later edit break the signature).
      const bytes = await App.Save.buildBytes({ noSidecar: true });
      setStatus('Signing…');
      await App.ensureLib('forge'); // crypto lib is loaded on demand (see util.js)
      const signed = await App.PdfSign.signPdf(bytes, p12Bytes, opts);
      let res;
      if (App.state.filePath && window.api.writePdf) {
        setStatus('Saving…');
        res = await window.api.writePdf(App.state.filePath, signed);
      } else {
        const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
        res = await window.api.savePdfDialog(base + '.pdf', signed);
        if (res && res.ok && res.path) {
          App.state.filePath = res.path;
          App.state.fileName = res.path.replace(/^.*[\\/]/, '');
        }
      }
      if (res && res.ok) {
        App.state.dirty = false;
        if (D._onSigned) { try { D._onSigned(); } catch (_) { /* preset */ } }
        App.toast(`Document digitally signed & saved${res.path ? ': ' + res.path : ''}.`, 'success', 4000);
        close();
        // Show the signed result (with the visible block) in the viewer, so the
        // signature actually appears on the page instead of only on disk.
        try {
          const copy = new Uint8Array(signed.length); copy.set(signed);
          await App.Viewer._loadInto(copy.buffer, App.state.fileName, App.state.filePath);
        } catch (_) { /* view refresh is best-effort */ }
      } else if (res && res.canceled) {
        setStatus('Save cancelled.'); reopenForRetry();
      } else {
        setStatus('Save failed: ' + ((res && res.error) || 'unknown error'), 'err'); reopenForRetry();
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const friendly = /mac could not be verified|invalid password|integrity|unable to|bad decrypt/i.test(msg)
        ? 'Wrong password for this digital ID (or the file is not a valid .p12/.pfx).'
        : msg;
      setStatus('Could not sign: ' + friendly, 'err'); reopenForRetry();
    } finally {
      updateReady();
    }
  }

  // Free placement: hide the dialog, let the user click the page where the
  // visible block should go, convert that point to a PDF-space rect, and sign.
  function armPlaceOnPage(opts) {
    const W = 260, H = 74; // signature block size, PDF points
    $('#digisign-modal').classList.add('hidden');
    document.body.classList.add('dsig-placing');
    App.toast('Click on the page where the signature should go (Esc to cancel).', 'info', 6000);

    function cleanup() {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('dsig-placing');
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); reopenForRetry(); }
    }
    function onClick(e) {
      const pageDiv = e.target.closest && e.target.closest('.page');
      if (!pageDiv) return; // clicked outside a page — ignore, keep waiting
      e.preventDefault(); e.stopPropagation();
      const page = parseInt(pageDiv.dataset.pageNumber, 10);
      const layer = pageDiv.querySelector('.markup-layer') || pageDiv;
      const r = layer.getBoundingClientRect();
      const z = App.state.zoom || 1;
      const vx = (e.clientX - r.left) / z, vy = (e.clientY - r.top) / z;
      const vp = App.state.baseViewports[page - 1];
      if (!vp) { cleanup(); reopenForRetry(); return; }
      const tl = vp.convertToPdfPoint(vx, vy); // click point in PDF space (block top-left)
      let x = tl[0], y = tl[1] - H;             // pdf-lib rect origin is bottom-left
      x = Math.max(4, Math.min(vp.width - W - 4, x));
      y = Math.max(4, Math.min(vp.height - H - 4, y));
      cleanup();
      opts.visible = {
        pageIndex: page - 1, rect: [x, y, W, H],
        name: opts.name || 'Signer', reason: opts.reason, location: opts.location
      };
      doSign(opts);
    }
    // Capture phase so we intercept the click before the page's own handlers.
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  App.DigiSign = D;
})();
