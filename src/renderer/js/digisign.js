'use strict';

/*
 * Digital Signature tool — applies a real PKI / PAdES signature to the document
 * using the user's PKCS#12 (.p12/.pfx) digital ID, via the offline signing
 * engine in src/shared/pdf-sign.js. Distinct from the app's cosmetic
 * signatures: this cryptographically binds the signer's identity to the
 * document and makes tampering detectable (Adobe shows the signature panel;
 * a trusted CA cert shows the green "valid" state).
 *
 * Security: the .p12 bytes and passphrase live only in this module's memory
 * while the dialog is open and are wiped on close/cancel/success. Nothing is
 * written to disk or sent anywhere — signing is entirely local (offline).
 *
 * Renderer-only, so it ships to Windows, macOS and Android from one file.
 */
(function () {
  const D = {};
  let p12Bytes = null;   // held only while the dialog is open
  const $ = (s) => App.$(s);

  function setStatus(msg, kind) {
    const s = $('#dsig-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'dsig-status' + (kind ? ' ' + kind : '');
  }

  function updateReady() {
    const go = $('#dsig-go');
    if (go) go.disabled = !(p12Bytes && $('#dsig-pass').value);
  }

  function syncVisible() {
    const on = $('#dsig-visible').checked;
    $('#dsig-visible-opts').classList.toggle('hidden', !on);
  }

  // Wipe sensitive material from memory.
  function wipe() {
    p12Bytes = null;
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
      p12Bytes = null;
      const f = fileInput.files && fileInput.files[0];
      if (f) {
        try { p12Bytes = new Uint8Array(await f.arrayBuffer()); }
        catch (_) { setStatus('Could not read that file.', 'err'); }
      }
      updateReady();
    });
    $('#dsig-pass').addEventListener('input', updateReady);
    $('#dsig-visible').addEventListener('change', syncVisible);
    $('#dsig-cancel').addEventListener('click', close);
    $('#dsig-close').addEventListener('click', close);
    $('#dsig-go').addEventListener('click', sign);
  };

  D.open = function () {
    if (!App.state.pdfDoc) { App.toast('Open a PDF first.', 'error'); return; }
    ['#dsig-p12', '#dsig-pass', '#dsig-name', '#dsig-reason', '#dsig-loc'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    $('#dsig-visible').checked = false;
    syncVisible();
    const pageEl = $('#dsig-page');
    pageEl.value = String(App.state.currentPage || 1);
    pageEl.max = String(App.state.numPages || 1);
    p12Bytes = null;
    setStatus('');
    updateReady();
    $('#digisign-modal').classList.remove('hidden');
  };

  // Gather the passphrase + identity fields from the dialog.
  function gatherOpts() {
    return {
      passphrase: $('#dsig-pass').value,
      name: $('#dsig-name').value.trim(),
      reason: $('#dsig-reason').value.trim(),
      location: $('#dsig-loc').value.trim()
    };
  }

  function reopenForRetry() { $('#digisign-modal').classList.remove('hidden'); }

  function sign() {
    if (!p12Bytes || !$('#dsig-pass').value) return;
    const opts = gatherOpts();
    if ($('#dsig-visible').checked && ($('#dsig-corner').value || 'click') === 'click') {
      // Free placement: leave the dialog, let the user click a spot on the page.
      armPlaceOnPage(opts);
      return;
    }
    if ($('#dsig-visible').checked) {
      const pageIndex = Math.max(0, Math.min((App.state.numPages || 1) - 1, (parseInt($('#dsig-page').value, 10) || 1) - 1));
      opts.visible = {
        pageIndex, corner: $('#dsig-corner').value || 'bl',
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
      const bytes = await App.Save.buildBytes();
      setStatus('Signing…');
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
        App.toast(`Document digitally signed & saved${res.path ? ': ' + res.path : ''}.`, 'success', 4000);
        close();
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
