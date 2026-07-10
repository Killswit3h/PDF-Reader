'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const pkg = require('../package.json');
const { repoSlug, semverCmp, fileFromArgv, canInstallInApp } = require('./shared/update-utils');

// electron-updater drives in-app download + install of a new release. Loaded
// defensively: if the module is ever missing/unloadable, the updater simply
// stays unavailable and the app falls back to opening the download page.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (_) { autoUpdater = null; }
const { buildMenuTemplate } = require('./shared/menu-template');
const { addRecent, pruneRecent } = require('./shared/recent-files');
const { sanitizeBounds } = require('./shared/window-state');
const { createStore } = require('./desktop-store');

// The app's display name changed to "FieldMark" (was "PDF Signer"), which would
// otherwise move Electron's userData to a new folder and orphan existing users'
// saved signature, preferences, recent files and window bounds. Pin userData to
// the original location so an in-place update keeps all of it. Must run before
// the app is ready (and before anything below reads userData).
try { app.setPath('userData', path.join(app.getPath('appData'), 'PDF Signer')); } catch (_) { /* fall back to default */ }

// Persisted desktop-only state (window bounds + recent files). Skipped under the
// e2e smoke harness so scenarios run against deterministic default bounds.
const store = process.env.SMOKE_TEST ? null : createStore(app.getPath('userData'));
const IS_MAC = process.platform === 'darwin';

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
    // macOS keeps the app running after its window is closed. If a file arrives
    // then (e.g. opening an Outlook attachment), there is no window to receive
    // it — create one now so it opens immediately instead of hanging until the
    // user clicks the Dock icon. On a cold start the app isn't ready yet;
    // whenReady() creates the first window and the 'renderer-ready' handler
    // flushes pendingFile, so don't double-create in that case.
    if (!mainWindow && app.isReady()) createWindow();
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

// GitHub project URL (for the Help menu), derived from package.json.
function githubUrl() {
  const slug = repoSlug(pkg.repository && pkg.repository.url);
  return slug ? `https://github.com/${slug.owner}/${slug.repo}` : 'https://github.com';
}

/* ------------------------------------------------------------------ */
/*  Native application menu                                             */
/* ------------------------------------------------------------------ */

// Menu items that map to renderer actions send a 'menu-command' the renderer
// dispatches (see src/renderer/js/app.js). A couple (external links) are handled
// here in the main process.
function handleMenuCommand(command) {
  if (command === 'open-github') { shell.openExternal(githubUrl()); return; }
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('menu-command', command);
  }
}

// Rebuild + install the application menu. Called at startup and whenever the
// recent-files list changes so the "Open Recent" submenu stays current.
function rebuildMenu() {
  const template = buildMenuTemplate({
    isMac: IS_MAC,
    isDev: !!process.env.PDF_SIGNER_DEV,
    appName: app.getName(),
    recent: store ? store.getRecent() : [],
    onCommand: handleMenuCommand,
    onOpenRecent: (entry) => { if (entry && entry.path) openInRenderer(entry.path); },
    onClearRecent: () => {
      if (!store) return;
      store.setRecent([]);
      app.clearRecentDocuments();
      rebuildMenu();
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Record a freshly opened/saved file at the top of the recent list, mirror it
// into the OS (Windows Jump List / macOS Dock "Open Recent"), and refresh the
// menu. No-op under the smoke harness (store is null).
function recordRecent(filePath, name) {
  if (!store || !filePath) return;
  const next = pruneRecent(addRecent(store.getRecent(), { path: filePath, name }), fs.existsSync);
  store.setRecent(next);
  try { app.addRecentDocument(filePath); } catch (_) { /* unsupported platform */ }
  rebuildMenu();
}

/* ------------------------------------------------------------------ */
/*  Window bounds persistence                                          */
/* ------------------------------------------------------------------ */

// Persist the window's restored (non-maximized) bounds + maximized flag.
function saveWindowState() {
  if (!store || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isFullScreen() || mainWindow.isMinimized()) return;
  store.setBounds(mainWindow.getNormalBounds(), mainWindow.isMaximized());
}

// Compute the bounds a new window should open at, honoring saved state but
// clamping it on-screen against the current display work area.
function startupBounds() {
  if (!store) return null;
  const saved = store.get().bounds;
  if (!saved) return null;
  const area = screen.getDisplayMatching(saved).workArea;
  return sanitizeBounds(saved, area);
}

function createWindow() {
  // A fresh renderer hasn't reported readiness yet; wait for its signal before
  // pushing any file path so we don't send to a window that isn't listening.
  rendererReady = false;
  const saved = startupBounds();
  mainWindow = new BrowserWindow(Object.assign({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#16171a',
    show: false,
    title: 'FieldMark',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }, saved || {}));

  // Native application menu (File / Edit / View / Window / Help) with
  // accelerators. The Edit-menu roles also restore Cmd+C/V/X/A in text fields on
  // macOS, which a null menu silently breaks.
  rebuildMenu();

  // Restore a maximized window; otherwise the sanitized bounds above apply.
  if (store && store.get().maximized) mainWindow.maximize();

  // Persist size/position/maximized as the user changes them (debounced in the
  // store). Never navigate away from the local app or spawn extra windows —
  // an offline viewer has no reason to, and a link inside a hostile PDF must
  // not be able to.
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // The app never navigates the main window after its initial load (that's a
    // 'load', not a navigation). Block everything — including a file:// URL from
    // a mis-dropped PDF that would otherwise replace the app — and send real
    // web links to the user's browser instead.
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

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
      // SMOKE_REOPEN: cold-open a file, CLOSE the window (app stays alive, macOS-
      // style — see the window-all-closed guard), then deliver a second file the
      // way an Outlook attachment arrives while windowless. Verifies a new window
      // is created and the file opens without a Dock click.
      if (process.env.SMOKE_REOPEN) {
        if (global.__reopened) return;   // the recreated window: just let it load
        setTimeout(async () => {
          try {
            await mainWindow.webContents.executeJavaScript(
              `(async()=>{for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));})()`, true);
            const first = await mainWindow.webContents.executeJavaScript(
              'JSON.stringify({name:App.state.fileName,pages:App.state.numPages})', true);
            global.__reopened = true;
            mainWindow._forceClose = true;
            mainWindow.close();                                  // → app goes windowless
            await new Promise((r) => setTimeout(r, 400));
            openInRenderer(process.env.SMOKE_REOPEN);            // file arrives while windowless
            for (let i = 0; i < 100 && (!mainWindow || !mainWindow.webContents); i++) await new Promise((r) => setTimeout(r, 100));
            let second = '{}';
            if (mainWindow && mainWindow.webContents) {
              await mainWindow.webContents.executeJavaScript(
                `(async()=>{for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));})()`, true);
              second = await mainWindow.webContents.executeJavaScript(
                'JSON.stringify({name:App.state.fileName,pages:App.state.numPages})', true);
            }
            console.log('[reopen] ' + JSON.stringify({ first: JSON.parse(first), createdWindow: !!(mainWindow && mainWindow.webContents), second: JSON.parse(second) }));
          } catch (e) { console.log('[reopen] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
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
      // SMOKE_TABS: open a second file (as a tab), edit it, switch tabs, and
      // verify each document keeps its own isolated state.
      if (process.env.SMOKE_TABS) {
        setTimeout(async () => {
          try {
            await mainWindow.webContents.executeJavaScript(
              `(async()=>{for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));})()`, true);
            mainWindow.webContents.send('open-file-path', process.env.SMOKE_TABS);
            await mainWindow.webContents.executeJavaScript(
              `(async()=>{for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));if(App.state.fileName==='big.pdf'&&App.state.numPages)break;}})()`, true);
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              const count = App.Tabs.count();
              const tabEls = document.querySelectorAll('#tab-bar .tab').length;
              App.state.placements.push({id:99,type:'date',page:1,vx:10,vy:10,vw:80,vh:18,text:'x',fontPt:12});
              App.state.dirty = true;
              App.Tabs.switchTo(1);
              for(let i=0;i<60&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,300));
              const one = { name:App.state.fileName, pages:App.state.numPages, placements:App.state.placements.length, dirty:App.state.dirty };
              App.Tabs.switchTo(2);
              for(let i=0;i<60&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,300));
              const two = { name:App.state.fileName, pages:App.state.numPages, placements:App.state.placements.length, dirty:App.state.dirty };
              return JSON.stringify({ count, tabEls, one, two });
            })()`, true);
            console.log('[tabs] ' + r);
          } catch (e) { console.log('[tabs] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_TMARK: text markups (highlight/underline/strikeout) render + export.
      if (process.env.SMOKE_TMARK) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,900));
              const A=App.state;
              const add=(type,y,color)=>{ A.annoSeq=(A.annoSeq||0)+1; A.annotations.push({id:A.annoSeq,page:1,type,quads:[{x:60,y,w:140,h:14}],style:{stroke:color,fill:'none',width:2,opacity:1}}); };
              add('texthighlight',60,'#ffd400'); add('underline',90,'#e5484d'); add('strikeout',120,'#2f6fed');
              App.Markup.repositionAll();
              const rects=document.querySelectorAll('#viewer .markup-svg rect').length;
              const lines=document.querySelectorAll('#viewer .markup-svg line').length;
              let bytesLen=0,err=''; try{ bytesLen=(await App.Save.buildBytes()).length; }catch(e){ err=e.message; }
              return JSON.stringify({ann:A.annotations.length,rects,lines,bytesLen,err});
            })()`, true);
            console.log('[tmark] ' + r);
          } catch (e) { console.log('[tmark] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_COMPARE: the compare overlay renders a diff canvas. Comparing the
      // open document against a copy of itself must report zero differences.
      if (process.env.SMOKE_COMPARE) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,600));
              const bytes=App.state.pdfBytes.slice();
              await App.Compare.compareData(bytes,'copy.pdf');
              let cv=null;
              for(let i=0;i<100;i++){cv=document.querySelector('#cmp-view canvas');if(cv&&cv.width>0)break;await new Promise(r=>setTimeout(r,100));}
              const modalOpen=!document.querySelector('#compare-modal').classList.contains('hidden');
              const changed=parseInt((document.querySelector('#cmp-changed').textContent.match(/[\\d,]+/)||['0'])[0].replace(/,/g,''),10);
              const noDiff=/No differences/.test(document.querySelector('#cmp-changed').textContent);
              return JSON.stringify({modalOpen,canvasW:cv?cv.width:0,canvasH:cv?cv.height:0,changed,noDiff});
            })()`, true);
            console.log('[compare] ' + r);
          } catch (e) { console.log('[compare] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_RAIL: the tool rail collapses to an icon strip, narrows the layout,
      // persists the choice, and expands back.
      if (process.env.SMOKE_RAIL) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              const railW=()=>Math.round(document.querySelector('#tool-rail').getBoundingClientRect().width);
              const toggle=document.querySelector('#rail-toggle');
              const wide=railW();
              toggle.click(); await new Promise(r=>setTimeout(r,120));
              const collapsed=document.body.classList.contains('rail-collapsed');
              const narrow=railW();
              const txtHidden=getComputedStyle(document.querySelector('.rail-txt')).display==='none';
              const pref=App.Prefs.get('railCollapsed',false);
              toggle.click(); await new Promise(r=>setTimeout(r,120));
              const expanded=!document.body.classList.contains('rail-collapsed');
              const wideAgain=railW();
              return JSON.stringify({collapsed,narrow,wide,txtHidden,pref,expanded,wideAgain});
            })()`, true);
            console.log('[rail] ' + r);
          } catch (e) { console.log('[rail] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_RT: marks survive a save→reopen as editable objects (round-trip via
      // the embedded sidecar), and the reopened working doc is the pristine base.
      if (process.env.SMOKE_RT) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,600));
              const st=App.state;
              st.measureSeq++; st.measurements.push({id:st.measureSeq,page:1,type:'length',pts:[{vx:60,vy:80},{vx:240,vy:80}],value:12.5,unit:'ft',label:"12.5'"});
              st.annoSeq++; st.annotations.push({id:st.annoSeq,page:1,type:'line',pts:[{vx:60,vy:140},{vx:260,vy:200}],style:{stroke:'#e5484d',fill:'none',width:2,opacity:1}});
              st.placementSeq++; st.placements.push({id:st.placementSeq,type:'text',page:1,vx:60,vy:300,vw:120,vh:20,text:'APPROVED',fontPt:14});
              const bytes=await App.Save.buildBytes();
              const doc=await window.pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
              const att=await doc.getAttachments();
              const hasModel=!!(att&&att['pdfsigner-model.json']); const hasBase=!!(att&&att['pdfsigner-base.pdf']);
              const savedLen=bytes.length;
              await App.Viewer._loadInto(bytes.buffer.slice(0),'rt.pdf',null);
              const R=App.state;
              const baseLen=R.pdfBytes.byteLength||R.pdfBytes.length;
              // editability after reopen: move the measurement, delete the placement
              const before=R.measurements[0]&&R.measurements[0].pts[0].vx;
              if(R.measurements[0]) R.measurements[0].pts=R.measurements[0].pts.map(p=>({vx:p.vx+25,vy:p.vy+25}));
              const moved=R.measurements[0]&&R.measurements[0].pts[0].vx===before+25;
              const pBefore=R.placements.length; R.placements=R.placements.filter(p=>p.text!=='APPROVED');
              return JSON.stringify({hasModel,hasBase,savedLen,baseLen,m:R.measurements.length,a:R.annotations.length,p:pBefore,moved,pAfter:R.placements.length});
            })()`, true);
            console.log('[rt] ' + r);
          } catch (e) { console.log('[rt] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_COPY: selecting PDF text surfaces the copy button + a non-empty
      // text selection (the clipboard path itself can't be asserted headless).
      if (process.env.SMOKE_COPY) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<120&&document.querySelectorAll('.textLayer span').length<3;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,300));
              const spans=Array.from(document.querySelectorAll('.textLayer span')).filter(s=>s.textContent.trim());
              const range=document.createRange();
              range.setStart(spans[0].firstChild||spans[0],0);
              const last=spans[Math.min(4,spans.length-1)];
              range.setEnd(last.firstChild||last,(last.firstChild?last.firstChild.length:0));
              const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
              document.dispatchEvent(new Event('selectionchange'));
              await new Promise(r=>setTimeout(r,120));
              const text=String(sel).trim();
              const fabShown=!document.querySelector('#copy-fab').classList.contains('hidden');
              return JSON.stringify({spans:spans.length,textLen:text.length,fabShown});
            })()`, true);
            console.log('[copy] ' + r);
          } catch (e) { console.log('[copy] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_ROTATE: the Rotate button turns the view 90° (the page re-renders
      // and the markup overlay layer rotates to stay glued to the canvas). We
      // don't assert a literal w/h swap — a fit-to-width view refits the rotated
      // page to the container instead of swapping dims — only that the view
      // rotated and the overlay still covers the canvas. (Point-level alignment
      // is proven against PDF.js ground truth in scripts/verify-rotate.js.)
      if (process.env.SMOKE_ROTATE) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!document.querySelector('.page canvas');i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,500));
              const cv=()=>document.querySelector('.page[data-page-number="1"] canvas');
              const layer=()=>document.querySelector('.page[data-page-number="1"] .markup-layer');
              const dims=()=>({w:parseFloat(cv().style.width),h:parseFloat(cv().style.height)});
              const d0=dims();
              App.Viewer.rotate(90);
              // Wait until the layer picks up a rotation transform (overlay reflow).
              let tf='none';
              for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));
                tf=getComputedStyle(layer()).transform; if(tf&&tf!=='none')break;}
              const d1=dims();
              // A rotation matrix has non-zero off-diagonal terms (b/c); identity
              // matrix(1,0,0,1,...) and 'none' do not — this proves the counter-rotation ran.
              const m=/matrix\\(([^)]+)\\)/.exec(tf);
              const parts=m?m[1].split(',').map(Number):[1,0,0,1,0,0];
              const rotated=Math.abs(parts[1])>0.5||Math.abs(parts[2])>0.5;
              const rerendered=Math.abs(d1.h-d0.h)>1||Math.abs(d1.w-d0.w)>1;
              const lr=layer().getBoundingClientRect(), cr=cv().getBoundingClientRect();
              const boxErr=Math.max(Math.abs(lr.left-cr.left),Math.abs(lr.top-cr.top),Math.abs(lr.width-cr.width),Math.abs(lr.height-cr.height));
              return JSON.stringify({d0,d1,rotated,rerendered,boxErr:+boxErr.toFixed(2)});
            })()`, true);
            console.log('[rotate] ' + r);
          } catch (e) { console.log('[rotate] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_TEXT1: the Text tool is one-shot — placing a box disarms the tool
      // (so the box is immediately movable) and a second click adds no new box.
      if (process.env.SMOKE_TEXT1) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!document.querySelector('.page .markup-layer');i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              App.Markup.startTool('text');
              const armed=App.state.mode==='markup';
              const layer=document.querySelector('.page .markup-layer');
              const rc=layer.getBoundingClientRect();
              App.Markup.handleClick(1,layer,{clientX:rc.left+120,clientY:rc.top+120,shiftKey:false});
              const disarmed=App.Markup.tool===null&&App.state.mode===null&&!document.body.classList.contains('tool-active');
              const fo=document.querySelector('.markup-svg foreignObject.hit');
              const draggable=fo?getComputedStyle(fo).pointerEvents!=='none':false;
              const after1=App.state.annotations.length;
              if(App.state.mode==='markup') App.Markup.handleClick(1,layer,{clientX:rc.left+300,clientY:rc.top+300,shiftKey:false});
              const after2=App.state.annotations.length;
              return JSON.stringify({armed,disarmed,draggable,after1,after2});
            })()`, true);
            console.log('[text1] ' + r);
          } catch (e) { console.log('[text1] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_TEXT2: multiple text boxes stay independent — placing a second box
      // must not copy the first box's text, and each box must edit its own div
      // (guards the per-annotation lookup in startTextEdit).
      if (process.env.SMOKE_TEXT2) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!document.querySelector('.page .markup-layer');i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              const layer=document.querySelector('.page .markup-layer');
              const rc=layer.getBoundingClientRect();
              const typeInto=(txt)=>{
                const div=document.querySelector('.markup-svg .anno-text[contenteditable="true"]');
                if(!div) return false;
                div.textContent=txt; div.dispatchEvent(new Event('blur'));
                return true;
              };
              // Box 1 — placing opens its editor; type AAA.
              App.Markup.startTool('text');
              App.Markup.handleClick(1,layer,{clientX:rc.left+120,clientY:rc.top+120,shiftKey:false});
              const edit1=typeInto('AAA');
              // Box 2 — placing opens ITS editor; type BBB.
              App.Markup.startTool('text');
              App.Markup.handleClick(1,layer,{clientX:rc.left+320,clientY:rc.top+320,shiftKey:false});
              const edit2=typeInto('BBB');
              const anns=App.state.annotations.filter(a=>a.type==='text');
              const t1=anns[0]&&anns[0].text, t2=anns[1]&&anns[1].text;
              // Re-edit box 2 through a REAL pointer-driven double-click (two
              // quick pointerdowns). This is what a user does and what the
              // native dblclick event failed to deliver, because selecting on
              // the first click rebuilds the SVG and swaps out the element.
              const sel='.markup-svg foreignObject[data-anno-id="'+anns[1].id+'"]';
              const down=(el)=>el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:0,clientY:0}));
              let fo2=document.querySelector(sel);
              if(fo2) down(fo2);
              window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
              fo2=document.querySelector(sel); // re-query: the first click rebuilt the SVG
              if(fo2) down(fo2);
              const edit3=typeInto('CCC');
              const r1=anns[0]&&anns[0].text, r2=anns[1]&&anns[1].text;
              return JSON.stringify({count:anns.length,edit1,edit2,edit3,t1,t2,r1,r2});
            })()`, true);
            console.log('[text2] ' + r);
          } catch (e) { console.log('[text2] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_WYSIWYG: a text mark placed by clicking flattens to the SAME spot
      // it shows on screen (guards the CSS-units scale fix — see viewer.js).
      if (process.env.SMOKE_WYSIWYG) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<120&&!document.querySelector('.page .markup-layer');i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,600));
              const layer=document.querySelector('.page .markup-layer');
              const lr=layer.getBoundingClientRect();
              App.Markup.startTool('text');
              App.Markup.handleClick(1,layer,{clientX:lr.left+lr.width*0.45,clientY:lr.top+lr.height*0.30,shiftKey:false});
              const div=document.querySelector('.markup-svg foreignObject .anno-text');
              if(div){div.textContent='H';div.dispatchEvent(new Event('blur'));}
              App.Markup.deselect&&App.Markup.deselect();
              const fo=document.querySelector('.markup-svg foreignObject');
              const fr=fo.getBoundingClientRect();
              const onFx=(fr.left-lr.left)/lr.width, onFy=(fr.top-lr.top)/lr.height;
              const bytes=await App.Save.buildBytes();
              const doc=await window.pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
              const p1=await doc.getPage(1); const vpR=p1.getViewport({scale:2});
              const cv=document.createElement('canvas');cv.width=Math.ceil(vpR.width);cv.height=Math.ceil(vpR.height);
              const ctx=cv.getContext('2d'); await p1.render({canvasContext:ctx,viewport:vpR}).promise;
              const d=ctx.getImageData(0,0,cv.width,cv.height).data;
              let minX=1e9,minY=1e9,count=0;
              for(let y=0;y<cv.height;y++)for(let x=0;x<cv.width;x++){const i=(y*cv.width+x)*4;if(d[i]>170&&d[i+1]<120&&d[i+2]<120){count++;if(x<minX)minX=x;if(y<minY)minY=y;}}
              const flFx=count?minX/cv.width:-1, flFy=count?minY/cv.height:-1;
              return JSON.stringify({onFx:+onFx.toFixed(4),onFy:+onFy.toFixed(4),flFx:+flFx.toFixed(4),flFy:+flFy.toFixed(4),dfx:+(flFx-onFx).toFixed(4),dfy:+(flFy-onFy).toFixed(4)});
            })()`, true);
            console.log('[wysiwyg] ' + r);
          } catch (e) { console.log('[wysiwyg] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_FORM: typing into a prefilled AcroForm field persists on save.
      if (process.env.SMOKE_FORM) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<120&&!document.querySelector('.annotationLayer input');i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,500));
              const input=document.querySelector('.annotationLayer input');
              const before=input?input.value:null;
              input.focus(); input.value='FORM EDIT';
              input.dispatchEvent(new Event('input',{bubbles:true}));
              input.dispatchEvent(new Event('change',{bubbles:true}));
              await new Promise(r=>setTimeout(r,200));
              const storeSize=App.state.pdfDoc.annotationStorage.size;
              const bytes=await App.Save.buildBytes();
              const {PDFDocument}=window.PDFLib;
              const d=await PDFDocument.load(bytes);
              const f=d.getForm();
              const vals=f.getFields().map(x=>{try{return x.getName()+'='+(x.getText?x.getText():'')}catch(_){return x.getName()+'=?'}});
              return JSON.stringify({before,storeSize,vals,edited:vals.some(v=>/FORM EDIT/.test(v))});
            })()`, true);
            console.log('[form] ' + r);
          } catch (e) { console.log('[form] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_PRINT: the print path rasterizes every page to a non-blank image
      // (guards the image-based print that replaced the blank PDF-viewer print).
      if (process.env.SMOKE_PRINT) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,500));
              const bytes=await App.Save.buildBytes();
              const html=await App.buildPrintHtml(bytes);
              const imgCount=(html.match(/<img /g)||[]).length;
              const hasData=/data:image\\/png;base64,/.test(html);
              // decode the first page image and check it isn't blank
              const url=(html.match(/data:image\\/png;base64,[A-Za-z0-9+/=]+/)||[])[0];
              let darkPx=0,w=0,h=0;
              if(url){ const im=new Image(); await new Promise(res=>{im.onload=res;im.onerror=res;im.src=url;});
                const c=document.createElement('canvas'); c.width=w=im.naturalWidth; c.height=h=im.naturalHeight;
                const x=c.getContext('2d'); x.drawImage(im,0,0); const d=x.getImageData(0,0,c.width,c.height).data;
                for(let i=0;i<d.length;i+=4){ if(d[i]<200&&d[i+1]<200&&d[i+2]<200)darkPx++; } }
              return JSON.stringify({imgCount,numPages:App.state.numPages,hasData,w,h,darkPx});
            })()`, true);
            console.log('[print] ' + r);
          } catch (e) { console.log('[print] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_MDRAG: a placed measurement can be grabbed + dragged to move it.
      if (process.env.SMOKE_MDRAG) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.pageEls.length;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              App.state.scales[1]={factor:0.5,unit:'ft',ratioLabel:'t'};
              App.state.measurements.push({id:1,page:1,type:'length',pts:[{vx:100,vy:100},{vx:200,vy:100}],value:50,unit:'ft',label:'50 ft'});
              App.Measure.repositionAll();
              const hit=document.querySelector('.measure-layer .m-hit');
              const before=JSON.stringify(App.state.measurements[0].pts);
              let moved=false, selected=false; const hasHit=!!hit;
              if(hit){ const b=hit.getBoundingClientRect();
                hit.dispatchEvent(new PointerEvent('pointerdown',{clientX:b.left+b.width/2,clientY:b.top+b.height/2,bubbles:true,cancelable:true}));
                window.dispatchEvent(new PointerEvent('pointermove',{clientX:b.left+b.width/2+40,clientY:b.top+b.height/2+30,bubbles:true}));
                window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
                moved=JSON.stringify(App.state.measurements[0].pts)!==before;
                selected=App.state.measureSelectedId===1;
              }
              return JSON.stringify({hasHit,moved,selected});
            })()`, true);
            console.log('[mdrag] ' + r);
          } catch (e) { console.log('[mdrag] error', e && e.message); }
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
              // the window/capture handler + container.contains guard (the PR #3 fix).
              // Re-query the target on every dispatch: a zoom commit re-renders the
              // page and REPLACES its <canvas>, so a captured canvas node goes stale
              // (detached → container.contains() false → handler bails). The .page
              // div persists across re-renders, so it's a stable dispatch target.
              const live=()=>document.querySelector('#viewer .page')||App.$('#viewerContainer');
              const wheelBefore=V.currentScale;
              live().dispatchEvent(new WheelEvent('wheel',{deltaY:-120,ctrlKey:true,clientX:400,clientY:400,bubbles:true,cancelable:true}));
              await new Promise(r=>setTimeout(r,260)); // ride preview + debounced commit
              const wheelAfter=V.currentScale;
              // a plain wheel (no ctrl) must NOT zoom
              const plainBefore=V.currentScale;
              live().dispatchEvent(new WheelEvent('wheel',{deltaY:-120,ctrlKey:false,clientX:400,clientY:400,bubbles:true,cancelable:true}));
              await new Promise(r=>setTimeout(r,50));
              const plainAfter=V.currentScale;
              // Smooth-zoom preview: a burst of ctrl-wheel events must ride a GPU
              // CSS transform (no per-event re-render), then commit exactly one
              // real re-render when the gesture settles. Anchor at a low scale first
              // so the zoom-in burst has headroom below ZOOM_MAX to actually grow.
              V.currentScale=0.5; await new Promise(r=>setTimeout(r,300));
              let rerenders=0; const onScale=()=>rerenders++;
              App.Viewer._eventBus.on('scalechanging', onScale);
              const previewBefore=V.currentScale;
              for(let i=0;i<15;i++) live().dispatchEvent(new WheelEvent('wheel',{deltaY:-40,ctrlKey:true,clientX:400,clientY:400,bubbles:true,cancelable:true}));
              const midTransform=document.querySelector('#viewer').style.transform;
              const midScale=V.currentScale, midRerenders=rerenders;
              await new Promise(r=>setTimeout(r,260)); // let the debounced commit fire
              const endTransform=document.querySelector('#viewer').style.transform;
              const endScale=V.currentScale, endRerenders=rerenders;
              App.Viewer._eventBus.off('scalechanging', onScale);
              return JSON.stringify({before:+before.toFixed(3), afterIn:+afterIn.toFixed(3), afterOut:+afterOut.toFixed(3), zoomedIn: afterIn>before, zoomedOut: afterOut<afterIn, wheelZoomed: wheelAfter>wheelBefore, plainIgnored: plainAfter===plainBefore,
                previewTransformed: /scale\\(/.test(midTransform), previewNoRerender: midRerenders===0 && Math.abs(midScale-previewBefore)<1e-6,
                commitOneRerender: endRerenders===1, commitCleared: endTransform==='' && endScale>previewBefore});
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
      if (process.env.SMOKE_SELECT) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 60 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 800));
              const sel = document.querySelector('#btn-select'), A = App.state;
              const out = { exists: !!sel, enabled: !!(sel && !sel.disabled) };
              // Add a markup, then arm a drawing tool: existing items become
              // un-grabbable (tool-active) and Select is not the active tool.
              A.annoSeq = (A.annoSeq || 0) + 1;
              out.addedId = A.annoSeq;
              A.annotations.push({ id: A.annoSeq, page: 1, type: 'line',
                pts: [{ vx: 60, vy: 60 }, { vx: 200, vy: 60 }],
                style: { stroke: '#e5484d', fill: 'none', width: 3, opacity: 1 } });
              App.setMode('markup'); if (App.Markup.arm) App.Markup.arm('rect');
              out.toolActiveWhileDrawing = document.body.classList.contains('tool-active');
              out.selectArmedWhileDrawing = sel.classList.contains('armed');
              // Click Select: it disarms the drawing tool and becomes the active tool.
              sel.click();
              out.modeAfterSelect = App.state.mode;
              out.toolActiveAfterSelect = document.body.classList.contains('tool-active');
              out.selectArmedAfterSelect = sel.classList.contains('armed');
              // In this state clicking an item selects it (drag/resize/delete/nudge).
              App.Markup.select(A.annoSeq);
              out.annoSelectedId = App.state.annoSelectedId;
              return JSON.stringify(out);
            })()`, true);
            console.log('[select] ' + r);
          } catch (e) { console.log('[select] error', e && e.message); }
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
      if (process.env.SMOKE_ORGANIZE) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 60 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 1000));
              const start = App.state.numPages;
              App.Organize.toggle();
              const m = App.Organize._model();
              m[0].deleted = true; m[1].rotate = 90;
              const tmp = m[2]; m[2] = m[3]; m[3] = tmp;      // swap pages 3 & 4
              const live = m.filter((e) => !e.deleted);
              let pages = 0, rot = -1, extract = 0, err = '';
              try {
                const bytes = await App.Organize._assemble(live);
                const doc = await window.PDFLib.PDFDocument.load(bytes);
                pages = doc.getPageCount();
                rot = doc.getPage(0).getRotation().angle;      // live[0] = rotated page
                const exBytes = await App.Organize._assemble([m[4], m[6]]);
                extract = (await window.PDFLib.PDFDocument.load(exBytes)).getPageCount();
              } catch (e) { err = e.message; }
              App.Organize.close();
              return JSON.stringify({ start, pages, rot, extract, err });
            })()`, true);
            console.log('[organize] ' + r);
          } catch (e) { console.log('[organize] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      if (process.env.SMOKE_STAMP) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 60 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 1000));
              App.state.docStamp = {
                number: { on: true, prefix: 'A-', start: 1, digits: 4, pos: 'br', size: 10 },
                header: { on: false, text: '', size: 10 },
                footer: { on: true, text: 'Confidential', size: 9 },
                watermark: { on: true, text: 'DRAFT', size: 60, opacity: 0.15, angle: 45, color: '#e5484d' },
                range: { mode: 'all', from: 1, to: 0 }
              };
              App.DocStamp.repositionAll();
              const previews = document.querySelectorAll('#viewer .stamp-preview').length;
              App.state.flattenForms = true;   // exercise the pdf-lib form-flatten path
              let bytesLen = 0, err = '';
              try { bytesLen = (await App.Save.buildBytes()).length; } catch (e) { err = e.message; }
              return JSON.stringify({ previews, bytesLen, err });
            })()`, true);
            console.log('[stamp] ' + r);
          } catch (e) { console.log('[stamp] error', e && e.message); }
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
      if (process.env.SMOKE_MENU) {
        setTimeout(async () => {
          try {
            await mainWindow.webContents.executeJavaScript(
              `(async()=>{for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));await new Promise(r=>setTimeout(r,400));})()`, true);
            const m = Menu.getApplicationMenu();
            const topLabels = m ? m.items.map((i) => i.label) : [];
            const find = (menu, label) => {
              for (const it of menu.items) {
                if (it.label === label) return it;
                if (it.submenu) { const f = find(it.submenu, label); if (f) return f; }
              }
              return null;
            };
            const before = await mainWindow.webContents.executeJavaScript('App.Viewer._pdfViewer.currentScale', true);
            const zi = m && find(m, 'Zoom In');
            if (zi && typeof zi.click === 'function') zi.click();   // fires the renderer command
            await new Promise((r) => setTimeout(r, 300));
            const after = await mainWindow.webContents.executeJavaScript('App.Viewer._pdfViewer.currentScale', true);
            const fileMenu = m && find(m, 'File');
            const hasOpenRecent = !!(fileMenu && fileMenu.submenu && find(fileMenu.submenu, 'Open Recent'));
            console.log('[menu] ' + JSON.stringify({
              hasMenu: !!m,
              hasEdit: topLabels.includes('Edit'),
              hasView: topLabels.includes('View'),
              hasOpenRecent,
              zoomed: after > before
            }));
          } catch (e) { console.log('[menu] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      if (process.env.SMOKE_SIGN) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 80 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 600));
              const forge = await App.ensureLib('forge'); // lazy-loaded on demand (see util.js)
              // Throwaway self-signed identity generated in-renderer (never a real key).
              const keys = forge.pki.rsa.generateKeyPair(1024);
              const cert = forge.pki.createCertificate();
              cert.publicKey = keys.publicKey; cert.serialNumber = '01';
              cert.validity.notBefore = new Date(2020,0,1); cert.validity.notAfter = new Date(2035,0,1);
              const at = [{ name:'commonName', value:'Smoke Signer' }];
              cert.setSubject(at); cert.setIssuer(at);
              cert.sign(keys.privateKey, forge.md.sha256.create());
              const der = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'pw', { algorithm:'3des' })).getBytes();
              const p12 = Uint8Array.from(der, (c) => c.charCodeAt(0) & 0xff);
              const pdf = await App.Save.buildBytes();
              let len = 0, hasSig = false, br = false, err = '';
              try {
                const signed = await App.PdfSign.signPdf(pdf, p12, { passphrase:'pw', name:'Smoke Signer', reason:'test', visible:{ pageIndex:0, corner:'bl' } });
                len = signed.length;
                let s = ''; for (let i = 0; i < signed.length; i++) s += String.fromCharCode(signed[i]);
                hasSig = s.indexOf('/SubFilter /adbe.pkcs7.detached') !== -1;
                br = /\\/ByteRange \\[\\d+ \\d+ \\d+ \\d+\\]/.test(s);
              } catch (e) { err = e.message; }
              return JSON.stringify({ len, hasSig, br, err });
            })()`, true);
            console.log('[sign] ' + r);
          } catch (e) { console.log('[sign] error', e && e.message); }
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
              // Unpackaged dev build → in-app install is unavailable; the IPC must
              // resolve to { started:false } (fallback path), never throw.
              let dl = null, dlErr = '';
              try { dl = await window.api.startUpdateDownload(); } catch (e) { dlErr = e.message; }
              return JSON.stringify({ version: v, res, dl, dlErr });
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
    // Skip when a file is already buffered — this window may have been created
    // to open a *new* file (e.g. a warm macOS re-open), and process.argv still
    // holds the original launch path, which would otherwise clobber it.
    if (!pendingFile) {
      const initialFile = fileFromArgv(process.argv);
      if (initialFile) openInRenderer(initialFile);
    }
  });

  // Prompt to save unsaved edits before the window closes.
  mainWindow.on('close', async (e) => {
    if (mainWindow._forceClose || process.env.SMOKE_TEST) return;
    e.preventDefault();
    let dirty = false;
    try {
      dirty = await mainWindow.webContents.executeJavaScript(
        '!!(window.App && ((App.Tabs && App.Tabs.anyDirty()) || (App.state && App.state.dirty)))');
    } catch (_) { /* renderer gone → just close */ }
    if (!dirty) { mainWindow._forceClose = true; mainWindow.close(); return; }

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save the changes you made to this PDF?',
      detail: "Your changes will be lost if you don't save them."
    });
    if (response === 2) return;                       // Cancel → stay open
    if (response === 1) { mainWindow._forceClose = true; mainWindow.close(); return; } // Don't Save

    let ok = false;                                   // Save → save, then close if it worked
    try { ok = await mainWindow.webContents.executeJavaScript('App.Save.saveForClose()'); } catch (_) {}
    if (ok) { mainWindow._forceClose = true; mainWindow.close(); }
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
    }
    // Route through openInRenderer even with no window — it recreates one so a
    // second launch (or file open) while the app runs windowless still opens.
    openInRenderer(fileFromArgv(argv));
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    // macOS keeps the app alive after the last window closes. The SMOKE_REOPEN
    // e2e emulates that on Linux CI so the windowless file-open path is testable.
    if (process.platform !== 'darwin' && !process.env.SMOKE_REOPEN) app.quit();
  });

  // A debounced bounds write could still be pending when the app exits — flush.
  app.on('before-quit', () => { if (store) store.flushNow(); });

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
    recordRecent(filePath, path.basename(filePath));
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Print the finished document (all pages, with every placement/markup/measure
// baked in). The renderer hands us the same bytes `Save` would write; we render
// them through Chromium's PDF viewer in an offscreen window so the OS print
// dialog gets the complete document rather than only the on-screen (virtualized)
// pages.
ipcMain.handle('app:print', async (_e, bytes) => {
  if (!bytes) return { ok: false, error: 'Nothing to print' };
  let tmpFile = null;
  let printWin = null;
  try {
    tmpFile = path.join(app.getPath('temp'), `pdfsigner-print-${process.pid}-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, Buffer.from(bytes));
    printWin = new BrowserWindow({
      show: false,
      // paintWhenInitiallyHidden keeps the offscreen window rendering (else a
      // hidden window can skip painting the PDF → a blank print); backgroundThrottling
      // off stops Chromium from pausing the PDF viewer while it's not visible.
      paintWhenInitiallyHidden: true,
      webPreferences: { plugins: true, backgroundThrottling: false } // built-in PDF viewer
    });
    // Wait for the document to finish loading, and fail loudly if it can't.
    await new Promise((resolve, reject) => {
      printWin.webContents.once('did-finish-load', resolve);
      printWin.webContents.once('did-fail-load', (_ev, code, desc) => reject(new Error(desc || ('load error ' + code))));
      printWin.loadURL('file://' + tmpFile);
    });
    // Chromium's PDF viewer paints its pages asynchronously after load, and there
    // is no "PDF rendered" event — printing too early captures a blank page. Give
    // the viewer a moment to render before sending it to the printer.
    await new Promise((r) => setTimeout(r, 1500));
    const result = await new Promise((resolve) => {
      printWin.webContents.print({ printBackground: true }, (success, reason) => {
        resolve({ ok: success, error: success ? undefined : reason });
      });
    });
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (printWin && !printWin.isDestroyed()) printWin.close();
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ } }
  }
});

// Print an HTML document of pre-rendered page images (built by the renderer with
// PDF.js). This avoids Chromium's offscreen PDF viewer entirely — images always
// paint, so the print is never blank — at the cost of raster (vs vector) output.
ipcMain.handle('app:printHtml', async (_e, html) => {
  if (!html) return { ok: false, error: 'Nothing to print' };
  let tmpFile = null;
  let printWin = null;
  try {
    tmpFile = path.join(app.getPath('temp'), `pdfsigner-print-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(tmpFile, html, 'utf8');
    printWin = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: { backgroundThrottling: false }
    });
    await new Promise((resolve, reject) => {
      printWin.webContents.once('did-finish-load', resolve);
      printWin.webContents.once('did-fail-load', (_ev, code, desc) => reject(new Error(desc || ('load error ' + code))));
      printWin.loadURL('file://' + tmpFile);
    });
    // Make sure every page image has actually decoded before printing.
    try {
      await printWin.webContents.executeJavaScript(
        'Promise.all([...document.images].map(i => (i.decode ? i.decode().catch(() => {}) : (i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })))))');
    } catch (_) { /* best effort */ }
    await new Promise((r) => setTimeout(r, 250));
    const result = await new Promise((resolve) => {
      printWin.webContents.print({ printBackground: true }, (success, reason) => {
        resolve({ ok: success, error: success ? undefined : reason });
      });
    });
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (printWin && !printWin.isDestroyed()) printWin.close();
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ } }
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

/* ------------------------------------------------------------------ */
/*  IPC: in-app auto-update (electron-updater; desktop, packaged only)  */
/* ------------------------------------------------------------------ */

// True only when this build can actually download + install an update itself
// (packaged Windows). Everywhere else the renderer keeps the "open the download
// page" flow. SMOKE runs unpackaged, so this is false under e2e.
function updaterUsable() {
  return !!autoUpdater && !process.env.SMOKE_TEST &&
    canInstallInApp(process.platform, app.isPackaged);
}

let updaterWired = false;
// Forward electron-updater progress/result/error to the renderer once.
function wireUpdater() {
  if (updaterWired || !autoUpdater) return;
  updaterWired = true;
  autoUpdater.autoDownload = false;         // we start the download on user action
  autoUpdater.autoInstallOnAppQuit = false; // the user chooses when to restart
  const send = (channel, payload) => {
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send(channel, payload);
  };
  autoUpdater.on('download-progress', (p) => send('update-progress', { percent: p && p.percent }));
  autoUpdater.on('update-downloaded', () => send('update-downloaded'));
  autoUpdater.on('error', (err) => send('update-error', { message: err && err.message }));
}

// Begin downloading the available update. Returns { started } — the renderer
// shows progress when true, or falls back to the download page when false (web,
// unsigned macOS, dev, or any updater error).
ipcMain.handle('app:startUpdateDownload', async () => {
  if (!updaterUsable()) return { started: false };
  try {
    wireUpdater();
    const res = await autoUpdater.checkForUpdates(); // reads latest.yml from the release
    if (!res || !res.updateInfo ||
        semverCmp(String(res.updateInfo.version || ''), app.getVersion()) <= 0) {
      return { started: false };
    }
    autoUpdater.downloadUpdate();                    // fires 'download-progress' → 'update-downloaded'
    return { started: true };
  } catch (err) {
    return { started: false, error: err.message };
  }
});

// Quit and install the downloaded update. Bypass the unsaved-changes prompt on
// the window (the user already opted to install; edits are their own to keep).
ipcMain.handle('app:installUpdate', async () => {
  if (!updaterUsable()) return { ok: false };
  try {
    if (mainWindow) mainWindow._forceClose = true;
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function readPdf(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    recordRecent(filePath, path.basename(filePath));
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
    recordRecent(filePath, path.basename(filePath));
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
