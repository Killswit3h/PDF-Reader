'use strict';

/*
 * Platform adapter for the browser / Capacitor (Android) WebView.
 *
 * The desktop build gets `window.api` from Electron's preload (IPC to the main
 * process). When the same renderer runs inside a mobile WebView or a plain
 * browser there is no preload, so this shim provides the identical surface
 * using web APIs — a file input to open, and the Capacitor Filesystem/Share
 * plugins (or a plain download) to save. Because it implements the exact same
 * contract, none of the app modules (viewer/save/markup/measure/app) change.
 *
 * Loaded by scripts/build-web.js only into the bundled www/ — never by Electron,
 * so the desktop path is untouched. It also points PDF.js at the bundled worker.
 */
(function () {
  // Tell viewer.js where the vendored PDF.js worker lives in the www/ bundle.
  // Must be set before viewer.js runs (this script is injected just before the
  // app modules by the web build).
  window.PDFJS_VENDOR = 'vendor/pdfjs/';

  // Electron already provided a richer, native-backed api — defer to it.
  if (window.api) return;

  const Cap = window.Capacitor || null;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const plugins = (Cap && Cap.Plugins) || {};

  // ---- helpers -----------------------------------------------------------

  // Compare dotted numeric versions; >0 iff a is newer than b.
  function semverCmp(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  }

  function bytesToBase64(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    const CHUNK = 0x8000; // avoid arg-count limits on String.fromCharCode
    for (let i = 0; i < arr.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  // Browser fallback: hand the bytes to the user as a normal download.
  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // Write a file to the device and offer to share it. On native we persist to
  // the app's Documents dir (visible, re-openable) then open the share sheet so
  // the user can hand it to Drive/Email/Files. In a plain browser we download.
  async function saveBinary(name, bytes, mime) {
    if (isNative && plugins.Filesystem) {
      const data = bytesToBase64(bytes);
      const res = await plugins.Filesystem.writeFile({
        path: name,
        data,
        directory: 'DOCUMENTS',
        recursive: true
      });
      const uri = res && res.uri;
      if (plugins.Share && uri) {
        try { await plugins.Share.share({ title: name, url: uri }); } catch (_) { /* user dismissed */ }
      }
      return { ok: true, path: uri || name };
    }
    downloadBlob(name, new Blob([bytes], { type: mime || 'application/octet-stream' }));
    return { ok: true, path: name };
  }

  async function saveText(name, text, mime) {
    if (isNative && plugins.Filesystem) {
      const res = await plugins.Filesystem.writeFile({
        path: name,
        data: text,
        directory: 'DOCUMENTS',
        encoding: 'utf8',
        recursive: true
      });
      const uri = res && res.uri;
      if (plugins.Share && uri) {
        try { await plugins.Share.share({ title: name, url: uri }); } catch (_) { /* dismissed */ }
      }
      return { ok: true, path: uri || name };
    }
    downloadBlob(name, new Blob([text], { type: mime || 'text/plain' }));
    return { ok: true, path: name };
  }

  // Open the system file picker and read the chosen PDF as an ArrayBuffer.
  // Returns null if the user cancels — matching the Electron dialog contract.
  function pickPdf() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,.pdf';
      input.style.display = 'none';
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; input.remove(); resolve(v); } };

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return finish(null);
        const reader = new FileReader();
        reader.onload = () => finish({ ok: true, path: null, name: file.name, data: reader.result });
        reader.onerror = () => finish({ ok: false, error: (reader.error && reader.error.message) || 'read failed' });
        reader.readAsArrayBuffer(file);
      });

      // Detect cancel: the picker returns focus to the window with no file.
      window.addEventListener('focus', function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(() => { if (!input.files || !input.files.length) finish(null); }, 400);
      }, { once: true });

      document.body.appendChild(input);
      input.click();
    });
  }

  // ---- the api surface (mirrors src/preload.js) --------------------------

  const version = window.APP_VERSION || '0.0.0';

  window.api = {
    // Web/Android has no native application menu; the in-page keyboard handler
    // owns the shortcuts here (see the isDesktop guard in app.js).
    isDesktop: false,

    // No native menu to drive commands from — a harmless no-op for parity.
    onMenuCommand: () => { /* desktop-only */ },

    // Print the finished document. Open the exported PDF so the WebView/browser
    // print (Android's system print → save-as-PDF or a networked printer) acts
    // on the complete document rather than the app chrome.
    print: (bytes) => {
      try {
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        window.open(url, isNative ? '_system' : '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (_) { /* ignore */ }
      return Promise.resolve({ ok: true });
    },

    openPdfDialog: () => pickPdf(),

    // A native "open with" intent may hand us a file:// or content:// URI.
    readPdf: async (filePath) => {
      try {
        if (isNative && plugins.Filesystem && filePath) {
          const res = await plugins.Filesystem.readFile({ path: filePath });
          const bin = atob(res.data);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          const name = String(filePath).replace(/^.*[\\/]/, '') || 'document.pdf';
          return { ok: true, path: filePath, name, data: out.buffer };
        }
      } catch (err) {
        return { ok: false, error: err.message, path: filePath };
      }
      return { ok: false, error: 'Not supported on this platform', path: filePath };
    },

    // No silent in-place overwrite on mobile — a picked file has no writable
    // path (App.state.filePath stays null), so Save routes to savePdfDialog.
    // This exists only for completeness / a future known-path case.
    writePdf: (filePath, bytes) => saveBinary(
      String(filePath || 'document.pdf').replace(/^.*[\\/]/, ''), bytes, 'application/pdf'),

    savePdfDialog: (defaultName, bytes) => saveBinary(defaultName || 'document-signed.pdf', bytes, 'application/pdf'),

    saveTextDialog: (defaultName, text) => saveText(defaultName || 'export.csv', text, 'text/csv'),

    // File-open intents (Android "Open with"). Best-effort; no-op in a browser.
    onOpenFilePath: (cb) => {
      if (isNative && plugins.App && plugins.App.addListener) {
        plugins.App.addListener('appUrlOpen', (data) => { if (data && data.url) cb(data.url); });
      }
    },

    notifyReady: () => { /* no buffered launch file on this platform */ },

    getVersion: () => Promise.resolve(version),

    // In-app update check: ask GitHub for the latest release, compare versions,
    // and hand back the APK's direct download URL so the shared update modal's
    // "Download" opens it (Android then prompts to install the sideloaded APK).
    // GitHub's REST API sends permissive CORS headers, so a plain fetch works in
    // the WebView (CapacitorHttp is disabled; connect-src allows https:).
    checkUpdates: async () => {
      const repo = window.APP_REPO;
      if (!repo) return { ok: true, current: version, latest: version, hasUpdate: false };
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' }
        });
        if (!r.ok) return { ok: false, current: version, error: 'HTTP ' + r.status };
        const rel = await r.json();
        const latest = String(rel.tag_name || '').replace(/^v/, '');
        // Prefer the APK asset so Download fetches the app directly; else the page.
        const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name || ''));
        const url = (apk && apk.browser_download_url) || rel.html_url ||
          `https://github.com/${repo}/releases/latest`;
        return {
          ok: true, current: version, latest,
          hasUpdate: !!latest && semverCmp(latest, version) > 0,
          url, notes: rel.body || ''
        };
      } catch (err) {
        return { ok: false, current: version, error: err.message };
      }
    },

    openExternal: async (url) => {
      if (isNative && plugins.Browser && plugins.Browser.open) {
        try { await plugins.Browser.open({ url }); return true; } catch (_) { /* fall through */ }
      }
      window.open(url, isNative ? '_system' : '_blank');
      return true;
    },

    // No in-app installer on web/Android — the update UI opens the download page
    // (APK / release) instead. These keep the contract identical to the desktop
    // preload so app modules never branch on platform.
    startUpdateDownload: () => Promise.resolve({ started: false }),
    installUpdate: () => Promise.resolve({ ok: false }),
    onUpdateProgress: () => { /* desktop-only */ },
    onUpdateDownloaded: () => { /* desktop-only */ },
    onUpdateError: () => { /* desktop-only */ }
  };
})();
