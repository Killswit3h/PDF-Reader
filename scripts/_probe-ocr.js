'use strict';
/*
 * TEMPORARY probe — deleted before the PR.
 *
 * Answers the one question that decides how ocr.js must be written: under the
 * real renderer (file:// origin + the app's real CSP), can tesseract.js
 *   (a) fetch() the bundled traineddata,
 *   (b) spawn its worker from a file:// URL,
 *   (c) importScripts() the WASM core,
 *   (d) actually recognize?
 * Chromium blocks fetch() to file:// from many contexts, so none of this is
 * safe to assume.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const R = (p) => path.join(__dirname, '..', p);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: R('src/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await win.loadFile(R('src/renderer/index.html'));

  const toUrl = (rel) => 'file://' + R(rel).split(path.sep).join('/');

  const script = `(async () => {
    const out = { steps: [] };
    const step = (name, ok, detail) => out.steps.push({ name, ok, detail: String(detail || '') });

    const LANG = ${JSON.stringify(toUrl('src/assets/tessdata/'))};
    const TESS = ${JSON.stringify(toUrl('node_modules/tesseract.js/dist/'))};
    const CORE = ${JSON.stringify(toUrl('node_modules/tesseract.js-core/'))};

    // (a) can the RENDERER fetch a bundled file:// asset?
    try {
      const r = await fetch(LANG + 'eng.traineddata.gz');
      step('renderer fetch file://', r.ok, 'status=' + r.status);
    } catch (e) { step('renderer fetch file://', false, e.message); }

    // (b) can we spawn a worker from a file:// URL under this CSP?
    try {
      const w = new Worker(TESS + 'worker.min.js');
      w.terminate();
      step('new Worker(file://)', true, '');
    } catch (e) { step('new Worker(file://)', false, e.message); }

    // (c) does the lazy vendor loader bring tesseract in?
    try {
      await App.ensureLib('tesseract');
      step('ensureLib(tesseract)', typeof window.Tesseract !== 'undefined', typeof window.Tesseract);
    } catch (e) { step('ensureLib(tesseract)', false, e.message); }

    // (d) end-to-end recognition on a canvas we draw ourselves
    if (typeof window.Tesseract !== 'undefined') {
      try {
        const cv = document.createElement('canvas');
        cv.width = 640; cv.height = 160;
        const c = cv.getContext('2d');
        c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
        c.fillStyle = '#000'; c.font = 'bold 90px Helvetica, Arial, sans-serif';
        c.fillText('DRAWING', 30, 110);

        const t0 = Date.now();
        const worker = await window.Tesseract.createWorker('eng', 1, {
          workerPath: TESS + 'worker.min.js',
          corePath: CORE,
          langPath: LANG,
          cacheMethod: 'none',
          legacyCore: false,
          legacyLang: false
        });
        const res = await worker.recognize(cv);
        await worker.terminate();
        const text = (res.data.text || '').trim();
        step('recognize', /DRAWING/i.test(text),
          JSON.stringify(text) + ' in ' + (Date.now() - t0) + 'ms');
        out.words = (res.data.words || []).map((w) => ({
          text: w.text, conf: Math.round(w.confidence), bbox: w.bbox
        }));
      } catch (e) { step('recognize', false, e.message); }
    }
    return out;
  })()`;

  let result;
  try {
    result = await win.webContents.executeJavaScript(script, true);
  } catch (e) {
    result = { fatal: e.message };
  }
  console.log('PROBE_RESULT ' + JSON.stringify(result, null, 2));
  app.exit(0);
});
