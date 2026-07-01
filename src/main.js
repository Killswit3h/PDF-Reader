'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;

// A file path passed on the command line (e.g. "Open with" on Windows).
function fileFromArgv(argv) {
  const candidate = argv.find(
    (a) => a && a.toLowerCase().endsWith('.pdf') && fs.existsSync(a)
  );
  return candidate || null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#2b2b2b',
    show: false,
    title: 'PDF Signer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // No default OS menu bar – keep it a clean single-window app.
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Optional smoke test: forward renderer console + auto-open a file + quit.
  if (process.env.SMOKE_TEST) {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, d) =>
      console.log('[render-process-gone]', JSON.stringify(d)));
    mainWindow.webContents.once('did-finish-load', () => {
      if (process.env.SMOKE_PDF) {
        setTimeout(() => mainWindow.webContents.send('open-file-path', process.env.SMOKE_PDF), 500);
      }
      if (process.env.SMOKE_MEASURE) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 40 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              const A = App.state;
              A.scales[2] = { factor: 0.5, unit: 'ft', ratioLabel: '1pt=0.5ft' };
              A.measurements.push({ id: 1, page: 2, type: 'length', pts: [{vx:100,vy:100},{vx:300,vy:100}] });
              A.measurements.push({ id: 2, page: 2, type: 'area', pts: [{vx:100,vy:100},{vx:300,vy:100},{vx:300,vy:300},{vx:100,vy:300}] });
              A.measurements.push({ id: 3, page: 2, type: 'angle', pts: [{vx:100,vy:100},{vx:200,vy:100},{vx:200,vy:200}] });
              A.measurements.push({ id: 4, page: 2, type: 'count', pts: [{vx:50,vy:50},{vx:60,vy:60},{vx:70,vy:70}] });
              // viewport with a different scale, plus a length inside it
              A.viewports[2] = [{ id: 1, vx: 400, vy: 400, vw: 150, vh: 150, factor: 2, unit: 'm', ratioLabel: 'vp' }];
              A.measurements.push({ id: 5, page: 2, type: 'length', pts: [{vx:420,vy:450},{vx:520,vy:450}] });
              App.Measure.recomputeAll();
              const out = A.measurements.map(m => m.type + '=' + m.label);
              let bytesLen = 0, err = '', b64 = '';
              try {
                const b = await App.Save.buildBytes(); bytesLen = b.length;
                let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
                b64 = btoa(s);
              } catch (e) { err = e.message; }
              return JSON.stringify({ out, bytesLen, err, b64 });
            })()`, true);
            const parsed = JSON.parse(r);
            console.log('[measure]', JSON.stringify({ out: parsed.out, bytesLen: parsed.bytesLen, err: parsed.err }));
            if (process.env.SMOKE_MEASURE !== '1' && parsed.b64) {
              fs.writeFileSync(process.env.SMOKE_MEASURE, Buffer.from(parsed.b64, 'base64'));
              console.log('[measure] wrote', process.env.SMOKE_MEASURE);
            }
          } catch (e) { console.log('[measure] error', e && e.message); }
          app.quit();
        }, 1500);
        return;
      }
      if (process.env.SMOKE_DRIVE) {
        setTimeout(async () => {
          try {
            const b64 = await mainWindow.webContents.executeJavaScript(`(async () => {
              // Wait for the document to finish loading.
              for (let i = 0; i < 40 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              const c0 = App.state.pageEls[0] && App.state.pageEls[0].canvas;
              console.log('[render] numPages=' + App.state.numPages
                + ' pageEls=' + App.state.pageEls.length
                + ' canvas0=' + (c0 ? c0.width + 'x' + c0.height : 'none')
                + ' emptyHidden=' + App.$('#empty-state').classList.contains('hidden'));
              // A tiny opaque red PNG (2x1) as a stand-in signature.
              const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAvyQP9vYaMtwAAAABJRU5ErkJggg==';
              // Place a signature on page 2 and a date on page 3.
              App.state.placements.push({ id: 1, type: 'image', page: 2, vx: 100, vy: 620, vw: 200, vh: 60, dataUrl: png, aspect: 2 });
              App.state.placements.push({ id: 2, type: 'date', page: 3, vx: 120, vy: 100, vw: 90, vh: 19, text: '07/01/2026', fontPt: 14 });
              const bytes = await App.Save.buildBytes();
              let s = ''; const arr = new Uint8Array(bytes);
              for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
              return btoa(s);
            })()`, true);
            fs.writeFileSync(process.env.SMOKE_DRIVE, Buffer.from(b64, 'base64'));
            console.log('[smoke] wrote signed pdf ->', process.env.SMOKE_DRIVE);
          } catch (e) {
            console.log('[smoke] drive error:', e && e.message);
          }
          app.quit();
        }, 1500);
        return;
      }
      setTimeout(() => { console.log('[smoke] done'); app.quit(); },
        parseInt(process.env.SMOKE_MS || '4000', 10));
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // If launched with a PDF argument, open it once the UI is ready.
    const initialFile = fileFromArgv(process.argv);
    if (initialFile) {
      mainWindow.webContents.send('open-file-path', initialFile);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Enforce a single instance so "Open with" reuses the running window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const f = fileFromArgv(argv);
      if (f) mainWindow.webContents.send('open-file-path', f);
    }
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/* ------------------------------------------------------------------ */
/*  IPC: file system bridge (renderer has no direct node access)       */
/* ------------------------------------------------------------------ */

// Show the native open dialog and return the selected PDF's bytes.
ipcMain.handle('dialog:openPdf', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  return readPdf(filePaths[0]);
});

// Read a PDF from an absolute path (drag-drop / command-line open).
ipcMain.handle('file:readPdf', async (_e, filePath) => readPdf(filePath));

function readPdf(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return {
      ok: true,
      path: filePath,
      name: path.basename(filePath),
      // Transfer as a plain ArrayBuffer to the renderer.
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    };
  } catch (err) {
    return { ok: false, error: err.message, path: filePath };
  }
}

// Show the native save dialog and write a text file (CSV export).
ipcMain.handle('dialog:saveText', async (_e, { defaultName, text }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export CSV',
    defaultPath: defaultName,
    filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'All Files', extensions: ['*'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, text, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Show the native save dialog and write the signed PDF bytes.
ipcMain.handle('dialog:savePdf', async (_e, { defaultName, bytes }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Signed PDF',
    defaultPath: defaultName,
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, Buffer.from(bytes));
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
