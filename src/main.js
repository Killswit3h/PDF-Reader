'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const pkg = require('../package.json');
const { repoSlug, semverCmp, fileFromArgv } = require('./shared/update-utils');

// Disable Chromium's native pinch-zoom at the browser level. On macOS a trackpad
// pinch is otherwise consumed as native page zoom and never reaches the DOM, so
// viewer.js can't turn it into PDF zoom. This is a second, independent guard
// alongside webFrame.setVisualZoomLevelLimits(1,1) in preload.js — the switch
// stops the gesture at the Chromium layer, the webFrame limit releases whatever
// remains to the DOM as ctrl/⌘+wheel events. Must be set before app is ready.
app.commandLine.appendSwitch('disable-pinch');

let mainWindow = null;

// Opening a PDF via "Open with" / a file association launches the app and needs
// the renderer to load it. The renderer only starts listening for the
// 'open-file-path' message once its scripts (incl. the large PDF.js bundles)
// have parsed and boot() has run. If the main process sends the path before
// then, the message is dropped and the user is left staring at an empty viewer
// (a "black screen"). To avoid that race we buffer the initial file and only
// deliver it after the renderer signals it is ready.
let rendererReady = false;
let pendingFile = null;

// Hand a file path to the renderer, or buffer it until the renderer is ready.
function openInRenderer(filePath) {
  if (!filePath) return;
  if (rendererReady && mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('open-file-path', filePath);
  } else {
    pendingFile = filePath;
  }
}

// macOS "Open with" delivers files via the 'open-file' event (not argv), and it
// can fire before the window (or the renderer) exists — buffer it.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openInRenderer(filePath);
});

// (fileFromArgv, repoSlug, semverCmp live in ./shared/update-utils — pure +
//  unit-tested; imported at the top of this file.)

function createWindow() {
  // A fresh renderer hasn't reported readiness yet; wait for its signal before
  // pushing any file path so we don't send to a window that isn't listening.
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#16171a',
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
      console.log('[env] disable-pinch=' + app.commandLine.hasSwitch('disable-pinch'));
      // SMOKE_LAUNCH: verify the REAL launch path (file passed via argv/open-file
      // → buffered → flushed on 'renderer-ready'). Deliberately does NOT push the
      // path itself, so it exercises the actual "Open with" cold-start fix.
      if (process.env.SMOKE_LAUNCH) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 80 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 600));
              return JSON.stringify({
                numPages: App.state.numPages || 0,
                fileName: App.state.fileName || null,
                emptyHidden: App.$('#empty-state').classList.contains('hidden'),
                canvases: document.querySelectorAll('#viewer .page canvas').length
              });
            })()`, true);
            console.log('[launch] ' + r);
          } catch (e) { console.log('[launch] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_WARM: open one file via argv (cold), then deliver a SECOND file the
      // way second-instance / macOS re-open does (immediate send while running) —
      // verifies the warm delivery path and that the doc switches.
      if (process.env.SMOKE_WARM) {
        setTimeout(async () => {
          try {
            await mainWindow.webContents.executeJavaScript(
              `(async()=>{for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));})()`, true);
            const first = await mainWindow.webContents.executeJavaScript('JSON.stringify({numPages:App.state.numPages,name:App.state.fileName})', true);
            // second file arrives while running (same mechanism as second-instance/open-file)
            mainWindow.webContents.send('open-file-path', process.env.SMOKE_WARM);
            await mainWindow.webContents.executeJavaScript(
              `(async()=>{for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));if(App.state.fileName==='big.pdf')break;}})()`, true);
            const second = await mainWindow.webContents.executeJavaScript('JSON.stringify({numPages:App.state.numPages,name:App.state.fileName})', true);
            console.log('[warm] first=' + first + ' second=' + second);
          } catch (e) { console.log('[warm] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_ZOOM: verify trackpad/ctrl-wheel zoom changes the scale.
      if (process.env.SMOKE_ZOOM) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              const V=App.Viewer._pdfViewer;
              const before=V.currentScale;
              App.Viewer.zoomByAt(1.5, 400, 400);
              const afterIn=V.currentScale;
              App.Viewer.zoomByAt(0.5, 400, 400);
              const afterOut=V.currentScale;
              // real synthetic wheel gesture (ctrlKey) over a page element — exercises
              // the window/capture handler + container.contains guard (the PR #3 fix)
              const target = document.querySelector('#viewer .page canvas') || document.querySelector('#viewer .page');
              const wheelBefore=V.currentScale;
              target.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,ctrlKey:true,clientX:400,clientY:400,bubbles:true,cancelable:true}));
              await new Promise(r=>setTimeout(r,50));
              const wheelAfter=V.currentScale;
              // a plain wheel (no ctrl) must NOT zoom
              const plainBefore=V.currentScale;
              target.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,ctrlKey:false,clientX:400,clientY:400,bubbles:true,cancelable:true}));
              await new Promise(r=>setTimeout(r,50));
              const plainAfter=V.currentScale;
              return JSON.stringify({before:+before.toFixed(3), afterIn:+afterIn.toFixed(3), afterOut:+afterOut.toFixed(3), zoomedIn: afterIn>before, zoomedOut: afterOut<afterIn, wheelZoomed: wheelAfter>wheelBefore, plainIgnored: plainAfter===plainBefore});
            })()`, true);
            console.log('[zoom] ' + r);
          } catch (e) { console.log('[zoom] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      if (process.env.SMOKE_PDF) {
        setTimeout(() => mainWindow.webContents.send('open-file-path', process.env.SMOKE_PDF), 500);
      }
      if (process.env.SMOKE_ANNOT) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 60 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 1000));
              const A = App.state, pg = 1;
              const st = () => ({ stroke:'#e5484d', fill:'none', width:2, opacity:1, fontSize:14 });
              const add = (o) => { A.annoSeq=(A.annoSeq||0)+1; A.annotations.push(Object.assign({id:A.annoSeq,page:pg,style:st()},o)); };
              add({type:'rect', pts:[{vx:60,vy:60},{vx:200,vy:140}]});
              add({type:'ellipse', pts:[{vx:230,vy:60},{vx:340,vy:140}]});
              add({type:'arrow', pts:[{vx:60,vy:180},{vx:200,vy:230}]});
              add({type:'polyline', pts:[{vx:230,vy:180},{vx:280,vy:230},{vx:340,vy:180}]});
              add({type:'polygon', pts:[{vx:60,vy:270},{vx:160,vy:280},{vx:110,vy:350}]});
              add({type:'ink', pts:[{vx:230,vy:270},{vx:250,vy:300},{vx:290,vy:270},{vx:320,vy:310}]});
              add({type:'text', pts:[{vx:60,vy:400},{vx:220,vy:444}], text:'Editable note'});
              A.saveAnnots = true;
              let bytesLen=0, err='', b64='';
              try { const b = await App.Save.buildBytes(); bytesLen=b.length; let s=''; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); b64=btoa(s); } catch(e){ err=e.message+' | '+(e.stack||'').split('\\n')[1]; }
              return JSON.stringify({ annCount:A.annotations.length, bytesLen, err, b64 });
            })()`, true);
            const parsed = JSON.parse(r);
            console.log('[annot] ' + JSON.stringify({ annCount: parsed.annCount, bytesLen: parsed.bytesLen, err: parsed.err }));
            if (process.env.SMOKE_ANNOT !== '1' && parsed.b64) { fs.writeFileSync(process.env.SMOKE_ANNOT, Buffer.from(parsed.b64, 'base64')); console.log('[annot] wrote ' + process.env.SMOKE_ANNOT); }
          } catch (e) { console.log('[annot] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      if (process.env.SMOKE_MARKUP) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 60 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 1200));
              const A = App.state, pg = 1;
              const st = () => ({ stroke:'#e5484d', fill:'none', width:2, opacity:1, fontSize:14 });
              const add = (o) => { A.annoSeq=(A.annoSeq||0)+1; A.annotations.push(Object.assign({id:A.annoSeq,page:pg,style:st()},o)); };
              add({type:'arrow', pts:[{vx:60,vy:60},{vx:200,vy:120}]});
              add({type:'line', pts:[{vx:60,vy:150},{vx:200,vy:150}]});
              add({type:'rect', pts:[{vx:250,vy:60},{vx:360,vy:140}], style:{stroke:'#2f6fed',fill:'#ffcc00',width:2,opacity:1}});
              add({type:'ellipse', pts:[{vx:400,vy:60},{vx:500,vy:140}]});
              add({type:'polyline', pts:[{vx:60,vy:200},{vx:120,vy:240},{vx:200,vy:200}]});
              add({type:'polygon', pts:[{vx:250,vy:200},{vx:340,vy:210},{vx:300,vy:280}]});
              add({type:'cloud', pts:[{vx:380,vy:200},{vx:500,vy:210},{vx:460,vy:300}]});
              add({type:'ink', pts:[{vx:60,vy:320},{vx:80,vy:340},{vx:110,vy:320},{vx:140,vy:350}]});
              add({type:'text', pts:[{vx:250,vy:320},{vx:400,vy:364}], text:'Note'});
              add({type:'callout', pts:[{vx:250,vy:400},{vx:400,vy:444},{vx:200,vy:380}], text:'Callout'});
              add({type:'highlight', pts:[{vx:60,vy:420},{vx:200,vy:445}], style:{stroke:'#ffd400',fill:'none',width:2,opacity:1}});
              try { App.Markup.repositionAll(); } catch(e) { return JSON.stringify({ fatal: 'repositionAll: ' + e.message, stack: (e.stack||'').split('\\n').slice(0,4).join(' | ') }); }
              App.MarkupPanel.toggle(); const mkpRows = document.querySelectorAll('#mkp-list .mp-row').length;
              const q = (s) => document.querySelectorAll('#viewer .markup-svg ' + s).length;
              let bytesLen=0, err='', b64='';
              try { const b = await App.Save.buildBytes(); bytesLen=b.length; let s=''; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); b64=btoa(s); } catch(e){ err=e.message; }
              return JSON.stringify({ annCount:A.annotations.length, mkpRows, lines:q('line'), polylines:q('polyline'), polygons:q('polygon'), rects:q('rect'), ellipses:q('ellipse'), paths:q('path'), texts:q('foreignObject'), bytesLen, err, b64 });
            })()`, true);
            const parsed = JSON.parse(r);
            console.log('[markup] ' + JSON.stringify(Object.assign({}, parsed, { b64: undefined })));
            if (process.env.SMOKE_MARKUP !== '1' && parsed.b64) { fs.writeFileSync(process.env.SMOKE_MARKUP, Buffer.from(parsed.b64, 'base64')); console.log('[markup] wrote ' + process.env.SMOKE_MARKUP); }
          } catch (e) { console.log('[markup] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      if (process.env.SMOKE_OVERLAY) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 60 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 1200));
              const pg = App.state.currentPage || 1;
              const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAvyQP9vYaMtwAAAABJRU5ErkJggg==';
              App.state.placements.push({ id: 1, type: 'image', page: pg, vx: 80, vy: 120, vw: 180, vh: 60, dataUrl: png, aspect: 3 });
              App.Placement.repositionAll();
              App.state.scales[pg] = { factor: 0.5, unit: 'ft', ratioLabel: 't' };
              App.state.measurements.push({ id: 1, page: pg, type: 'length', pts: [{vx:100,vy:300},{vx:300,vy:300}], value: 100, unit: 'ft', label: '100.00 ft' });
              App.Measure.repositionAll();
              return JSON.stringify({
                page: pg,
                placedInLayer: document.querySelectorAll('#viewer .markup-layer .placed').length,
                measurePolylines: document.querySelectorAll('#viewer .markup-layer .measure-layer polyline').length,
                measureLabels: document.querySelectorAll('#viewer .markup-layer .measure-layer text').length
              });
            })()`, true);
            console.log('[overlay] ' + r);
          } catch (e) { console.log('[overlay] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      if (process.env.SMOKE_VIEWER) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 60 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              // give the viewer time to render visible pages
              await new Promise(r => setTimeout(r, 1500));
              const q = (s) => document.querySelectorAll(s).length;
              // test find
              let findOk = false;
              try { App.Viewer.openFind(); App.Viewer.find('page-77-unique', false); findOk = true; } catch (e) {}
              return JSON.stringify({
                numPages: App.state.numPages,
                pageDivs: q('#viewer .page'),
                renderedCanvases: q('#viewer .page canvas'),
                textLayers: q('#viewer .textLayer'),
                markupLayers: q('#viewer .markup-layer'),
                zoom: Math.round(App.state.zoom * 100) / 100,
                baseVpSet: App.state.baseViewports.filter(Boolean).length,
                findOk
              });
            })()`, true);
            console.log('[viewer] ' + r);
          } catch (e) { console.log('[viewer] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      if (process.env.SMOKE_UPDATE) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              const v = await window.api.getVersion();
              const res = await window.api.checkUpdates();
              return JSON.stringify({ version: v, res });
            })()`, true);
            console.log('[update] ' + r);
          } catch (e) { console.log('[update] error', e && e.message); }
          app.quit();
        }, 800);
        return;
      }
      if (process.env.SMOKE_SAVE) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 40 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAvyQP9vYaMtwAAAABJRU5ErkJggg==';
              App.state.placements.push({ id: 1, type: 'image', page: 1, vx: 80, vy: 700, vw: 200, vh: 60, dataUrl: png, aspect: 2 });
              await App.Save.save();
              return App.state.filePath || '(none)';
            })()`, true);
            console.log('[save] filePath=' + r);
          } catch (e) { console.log('[save] error', e && e.message); }
          setTimeout(() => app.quit(), 400);
        }, 1500);
        return;
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
      // Capture a screenshot of the loaded window (for visual QA of the UI).
      // SMOKE_SHOT=<out.png>, optional SMOKE_SHOT_THEME=light|dark.
      if (process.env.SMOKE_SHOT) {
        setTimeout(async () => {
          try {
            await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 60 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 1200));
              const t = ${JSON.stringify(process.env.SMOKE_SHOT_THEME || '')};
              if (t) document.documentElement.setAttribute('data-theme', t);
              // only enter markup mode when a doc is open (else show empty state)
              if (App.state.numPages) { try { App.Markup.startTool('rect'); } catch (e) {} }
            })()`, true);
            await new Promise((r) => setTimeout(r, 500));
            const img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(process.env.SMOKE_SHOT, img.toPNG());
            console.log('[shot] wrote ' + process.env.SMOKE_SHOT);
          } catch (e) { console.log('[shot] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      setTimeout(() => { console.log('[smoke] done'); app.quit(); },
        parseInt(process.env.SMOKE_MS || '4000', 10));
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // If launched with a PDF argument (Windows/Linux), queue it. It is delivered
    // once the renderer reports it is ready (see the 'renderer-ready' handler),
    // which guarantees the renderer is already listening for the file path.
    const initialFile = fileFromArgv(process.argv);
    if (initialFile) openInRenderer(initialFile);
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
      openInRenderer(fileFromArgv(argv));
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

// The renderer has finished booting and is now listening for 'open-file-path'.
// Flush any file that arrived before the renderer was ready.
ipcMain.on('renderer-ready', (e) => {
  rendererReady = true;
  if (pendingFile) {
    const f = pendingFile;
    pendingFile = null;
    e.sender.send('open-file-path', f);
  }
});

// Read a PDF from an absolute path (drag-drop / command-line open).
ipcMain.handle('file:readPdf', async (_e, filePath) => readPdf(filePath));

// Overwrite a PDF at a known path (Save — no dialog).
ipcMain.handle('file:writePdf', async (_e, { filePath, bytes }) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(bytes));
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ------------------------------------------------------------------ */
/*  IPC: update check (compare app version to latest GitHub release)   */
/* ------------------------------------------------------------------ */

function fetchLatestRelease(owner, repo) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases/latest`,
      method: 'GET',
      headers: { 'User-Agent': 'PDF-Signer', Accept: 'application/vnd.github+json' }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error('HTTP ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Request timed out')));
    req.end();
  });
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:checkUpdates', async () => {
  const current = app.getVersion();
  const slug = repoSlug(pkg.repository && pkg.repository.url);
  if (!slug) return { ok: false, current, error: 'No repository configured' };
  try {
    const rel = await fetchLatestRelease(slug.owner, slug.repo);
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    return {
      ok: true,
      current,
      latest,
      hasUpdate: semverCmp(latest, current) > 0,
      url: rel.html_url || `https://github.com/${slug.owner}/${slug.repo}/releases/latest`,
      notes: rel.body || ''
    };
  } catch (err) {
    return { ok: false, current, error: err.message };
  }
});

ipcMain.handle('app:openExternal', async (_e, url) => {
  await shell.openExternal(url);
  return true;
});

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
