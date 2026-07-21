'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const pkg = require('../package.json');
const { repoSlug, semverCmp, fileFromArgv, filesFromArgv, canInstallInApp } = require('./shared/update-utils');

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

// macOS "Liquid Glass" window shell. On darwin the window becomes translucent so
// the OS vibrancy material blurs the desktop behind the frosted chrome, and the
// title bar is integrated (hiddenInset) — the toolbar itself becomes the drag
// region and reads as one continuous glass surface, with the traffic lights
// vertically centred in its 52px height. Everything is guarded to macOS; on
// Windows/Linux this object is empty and the standard opaque frame is used.
// `visualEffectState: 'active'` keeps the material lively even when unfocused.
const MAC_GLASS_WINDOW = IS_MAC ? {
  vibrancy: 'under-window',
  visualEffectState: 'active',
  titleBarStyle: 'hiddenInset',
  trafficLightPosition: { x: 19, y: 18 },
  backgroundColor: '#00000000'
} : {};

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
// Files that arrived before the renderer was ready, buffered in arrival order.
// It's a list, not a single slot, so opening several PDFs at once (multi-select
// "Open with", or a batch of macOS 'open-file' events) doesn't drop all but the
// last — every one is flushed as a tab once the renderer signals ready.
let pendingFiles = [];

// Torn-off child windows + their pending initial documents (keyed by the new
// window's webContents id; delivered on that window's 'renderer-ready').
const childWindows = new Set();
const pendingTearoffs = new Map();

// Block navigation / new-window popups (a hostile PDF link must not replace the
// app or spawn a window); real web links go to the user's browser. Applied to
// every app window (main + torn-off).
function applyWindowSecurity(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

// Prompt to save unsaved edits before a window closes (Save / Don't Save /
// Cancel). Shared by the main window and every torn-off window.
function attachCloseGuard(win) {
  win.on('close', async (e) => {
    if (win._forceClose || process.env.SMOKE_TEST) return;
    e.preventDefault();
    let dirty = false;
    try {
      dirty = await win.webContents.executeJavaScript(
        '!!(window.App && ((App.Tabs && App.Tabs.anyDirty()) || (App.state && App.state.dirty)))');
    } catch (_) { /* renderer gone → just close */ }
    if (!dirty) { win._forceClose = true; win.close(); return; }

    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save the changes you made to this PDF?',
      detail: "Your changes will be lost if you don't save them."
    });
    if (response === 2) return;                       // Cancel → stay open
    if (response === 1) { win._forceClose = true; win.close(); return; } // Don't Save

    let ok = false;                                   // Save → save, then close if it worked
    try { ok = await win.webContents.executeJavaScript('App.Save.saveForClose()'); } catch (_) {}
    if (ok) { win._forceClose = true; win.close(); }
  });
}

// Create a torn-off window pre-loaded with a document. `payload` is buffered and
// pushed to the new renderer once it reports ready (see 'renderer-ready').
function createChildWindow(payload) {
  const parent = BrowserWindow.getFocusedWindow() || mainWindow;
  const pb = parent && !parent.isDestroyed() ? parent.getBounds() : { x: 60, y: 60, width: 1280, height: 900 };
  const win = new BrowserWindow({
    width: pb.width, height: pb.height,
    x: (pb.x || 60) + 40, y: (pb.y || 60) + 40,
    minWidth: 800, minHeight: 600, backgroundColor: '#16171a', show: false, title: 'FieldMark',
    ...MAC_GLASS_WINDOW,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  childWindows.add(win);
  applyWindowSecurity(win);
  attachCloseGuard(win);
  win.on('closed', () => childWindows.delete(win));
  if (payload) pendingTearoffs.set(win.webContents.id, payload);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

// Hand a file path to the renderer, or buffer it until the renderer is ready.
function openInRenderer(filePath) {
  if (!filePath) return;
  if (rendererReady && mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('open-file-path', filePath);
  } else {
    pendingFiles.push(filePath);
    // macOS keeps the app running after its window is closed. If a file arrives
    // then (e.g. opening an Outlook attachment), there is no window to receive
    // it — create one now so it opens immediately instead of hanging until the
    // user clicks the Dock icon. On a cold start the app isn't ready yet;
    // whenReady() creates the first window and the 'renderer-ready' handler
    // flushes pendingFiles, so don't double-create in that case.
    if (!mainWindow && app.isReady()) createWindow();
  }
}

// Open several paths at once. Each becomes its own tab; the renderer opens them
// sequentially in this order (see App.Viewer.load).
function openManyInRenderer(filePaths) {
  (filePaths || []).forEach(openInRenderer);
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
  // Route to the focused window so menu actions target the window the user is
  // looking at (matters once tabs can be torn off into separate windows).
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win && win.webContents) {
    win.webContents.send('menu-command', command);
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
  }, MAC_GLASS_WINDOW, saved || {}));

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
  // Block navigation / popups (a mis-dropped file:// or a hostile PDF link must
  // not replace the app); real web links open in the user's browser.
  applyWindowSecurity(mainWindow);

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
      // SMOKE_MULTI: launch with TWO PDFs in argv (a multi-select "Open with")
      // and verify BOTH open as their own tabs — the whole batch is delivered,
      // not just the first file.
      if (process.env.SMOKE_MULTI) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 120; i++) {
                await new Promise(r => setTimeout(r, 100));
                if (App.Tabs && App.Tabs.count() >= 2 && App.state.numPages) break;
              }
              await new Promise(r => setTimeout(r, 400));
              return JSON.stringify({
                count: App.Tabs ? App.Tabs.count() : 0,
                tabEls: document.querySelectorAll('#tab-bar .tab').length,
                names: (App.Tabs ? App.Tabs.list() : []).map((t) => t.name)
              });
            })()`, true);
            console.log('[multi] ' + r);
          } catch (e) { console.log('[multi] error', e && e.message); }
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
      // SMOKE_TABREORDER: open a second file (tab), then reorder the tabs and
      // verify both the sessions order and the rendered tab DOM order follow.
      if (process.env.SMOKE_TABREORDER) {
        setTimeout(async () => {
          try {
            await mainWindow.webContents.executeJavaScript(
              `(async()=>{for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));})()`, true);
            mainWindow.webContents.send('open-file-path', process.env.SMOKE_TABREORDER);
            await mainWindow.webContents.executeJavaScript(
              `(async()=>{for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));if(App.state.fileName==='big.pdf'&&App.state.numPages)break;}})()`, true);
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              const names=()=>Array.from(document.querySelectorAll('#tab-bar .tab .tab-label')).map(n=>n.textContent.replace(/^• /,''));
              const before=names();               // [sample.pdf, big.pdf]
              // Drag tab id 2 (big.pdf) to sit before tab id 1 (sample.pdf).
              App.Tabs.reorder(2, 1, true);
              await new Promise(r=>setTimeout(r,100));
              const after=names();                 // expect [big.pdf, sample.pdf]
              const activeStayed=App.state.fileName; // reordering must not switch docs
              return JSON.stringify({ before, after, activeStayed });
            })()`, true);
            console.log('[tabreorder] ' + r);
          } catch (e) { console.log('[tabreorder] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_TEAROFF: tearing a tab off opens a SECOND window pre-loaded with
      // that document — and its unsaved edits travel with it (base + marks model).
      if (process.env.SMOKE_TEAROFF) {
        setTimeout(async () => {
          try {
            const setup = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              // Open a SECOND tab (reuse the current bytes) so tear-off is allowed.
              const b=App.state.pdfBytes;
              await App.Tabs.open(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'second.pdf',null);
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              // Mark the active (second) doc so we can prove edits travel with it.
              App.state.measureSeq++; App.state.measurements.push({id:App.state.measureSeq,page:1,type:'length',pts:[{vx:40,vy:40},{vx:180,vy:40}],value:9,unit:'ft',label:"9'"});
              App.state.dirty=true;
              const before=App.Tabs.count();
              const canTear=App.Tabs.canTearOff();
              const ok=await App.Tabs.tearOffActive();
              await new Promise(r=>setTimeout(r,150));
              return JSON.stringify({before,after:App.Tabs.count(),canTear,ok,srcName:App.state.fileName});
            })()`, true);
            await new Promise((r) => setTimeout(r, 1500)); // child window boots + rehydrates
            const wins = BrowserWindow.getAllWindows();
            const child = wins.find((w) => w !== mainWindow);
            let childState = 'null';
            if (child) {
              childState = await child.webContents.executeJavaScript(`(async()=>{
                for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
                await new Promise(r=>setTimeout(r,200));
                return JSON.stringify({name:App.state.fileName,m:App.state.measurements.length,tabs:App.Tabs.count(),dirty:App.state.dirty});
              })()`, true);
            }
            console.log('[tearoff] ' + JSON.stringify({ windows: wins.length, setup: JSON.parse(setup), child: JSON.parse(childState) }));
          } catch (e) { console.log('[tearoff] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_SPLIT: the in-window Side-by-Side pane renders a second document
      // read-only; the window-tiling API is present.
      if (process.env.SMOKE_SPLIT) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,800));
              const b=App.state.pdfBytes;
              await App.Tabs.open(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'second.pdf',null);
              await new Promise(r=>setTimeout(r,400));
              const tabs=App.Tabs.list().length;
              App.SplitView.open();
              let canvases=0;
              for(let i=0;i<60;i++){canvases=document.querySelectorAll('#split-body .mini-page canvas').length;if(canvases>0)break;await new Promise(r=>setTimeout(r,100));}
              const paneVisible=!document.getElementById('split-pane').classList.contains('hidden');
              const options=document.querySelectorAll('#split-pick option').length;
              App.SplitView.close();
              const closed=!document.body.classList.contains('has-split');
              const apiTile=typeof window.api.tileSideBySide==='function';
              return JSON.stringify({ tabs, canvases, paneVisible, options, closed, apiTile });
            })()`, true);
            console.log('[split] ' + r);
          } catch (e) { console.log('[split] error', e && e.message); }
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
              // Fit control: fit sizes the page to the window; zoom in enlarges it.
              document.querySelector('#cmp-fit').click();
              const fitW=parseFloat(cv.style.width)||0;
              const fitActive=document.querySelector('#cmp-fit').classList.contains('active');
              document.querySelector('#cmp-zoom-in').click();
              const zoomW=parseFloat(cv.style.width)||0;
              const fitInactive=document.querySelector('#cmp-fit').classList.contains('active');
              return JSON.stringify({modalOpen,canvasW:cv?cv.width:0,canvasH:cv?cv.height:0,changed,noDiff,fitW,zoomW,fitActive,fitInactive});
            })()`, true);
            console.log('[compare] ' + r);
          } catch (e) { console.log('[compare] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_DOCOVERLAY: the document overlay view superimposes two docs one on
      // top of the other. It must render a composited canvas, and toggling a
      // layer off (or changing its tint) must recomposite to different pixels —
      // proving both documents actually contribute to the blend. (Distinct from
      // SMOKE_OVERLAY below, which exercises the on-page annotation layer.)
      if (process.env.SMOKE_DOCOVERLAY) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,600));
              const bytes=App.state.pdfBytes.slice();
              await App.Overlay.overlayData(bytes,'copy.pdf');
              let cv=null;
              for(let i=0;i<100;i++){cv=document.querySelector('#ovl-view canvas');if(cv&&cv.width>0)break;await new Promise(r=>setTimeout(r,100));}
              const modalOpen=!document.querySelector('#overlay-modal').classList.contains('hidden');
              const px=(c)=>{const t=document.createElement('canvas');t.width=c.width;t.height=c.height;const x=t.getContext('2d');x.drawImage(c,0,0);return x.getImageData(0,0,c.width,c.height).data;};
              const sum=(d)=>{let s=0;for(let i=0;i<d.length;i+=4)s+=d[i]+d[i+1]+d[i+2];return s;};
              const both=sum(px(cv));
              // Toggle layer B off → only A tints → pixel sum changes.
              document.querySelector('#ovl-b-on').click();
              document.querySelector('#ovl-b-on').dispatchEvent(new Event('input',{bubbles:true}));
              await new Promise(r=>setTimeout(r,200));
              const cv2=document.querySelector('#ovl-view canvas');
              const aOnly=sum(px(cv2));
              // Fit control sizes the page to the window; zoom-in enlarges it.
              document.querySelector('#ovl-fit').click();
              const fitW=parseFloat(cv2.style.width)||0;
              const fitActive=document.querySelector('#ovl-fit').classList.contains('active');
              document.querySelector('#ovl-zoom-in').click();
              const zoomW=parseFloat(cv2.style.width)||0;
              // Page nav.
              const pageTxt=document.querySelector('#ovl-page').textContent;
              return JSON.stringify({modalOpen,canvasW:cv?cv.width:0,canvasH:cv?cv.height:0,both,aOnly,changed:both!==aOnly,fitW,fitActive,zoomW,pageTxt});
            })()`, true);
            console.log('[docoverlay] ' + r);
          } catch (e) { console.log('[docoverlay] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_MRAIL: the right-hand markup rail appears once a document is open,
      // clicking a tool button arms that tool (and highlights it), Select
      // disarms, and the collapse handle hides the rail + persists the choice.
      if (process.env.SMOKE_MRAIL) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              const rail=document.querySelector('#markup-rail');
              const shown=()=>getComputedStyle(rail).display!=='none';
              const docOpenShown=shown();
              const rectBtn=rail.querySelector('.mr-btn[data-mk="rect"]');
              rectBtn.click();
              await new Promise(r=>setTimeout(r,100));
              const rectArmed=rectBtn.classList.contains('armed');
              const toolIsRect=App.Markup.tool==='rect';
              const selBtn=rail.querySelector('.mr-btn[data-mr="select"]');
              selBtn.click();
              await new Promise(r=>setTimeout(r,100));
              const selArmed=selBtn.classList.contains('armed');
              const rectDisarmed=!rectBtn.classList.contains('armed');
              // Collapse: hide handle removes the rail, sets the pref, reopen tab shows.
              document.querySelector('#mr-toggle').click();
              await new Promise(r=>setTimeout(r,100));
              const hiddenAfter=!shown();
              const pref=App.Prefs.get('markupRailOff',false);
              const reopenShown=getComputedStyle(document.querySelector('#mr-reopen')).display!=='none';
              document.querySelector('#mr-reopen').click();
              await new Promise(r=>setTimeout(r,100));
              const shownAgain=shown();
              return JSON.stringify({docOpenShown,rectArmed,toolIsRect,selArmed,rectDisarmed,hiddenAfter,pref,reopenShown,shownAgain});
            })()`, true);
            console.log('[mrail] ' + r);
          } catch (e) { console.log('[mrail] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_SHARP: zooming a page past the OLD 2^24 canvas cap must still
      // render the page canvas at full resolution (pixel buffer ≈ CSS box × dpr)
      // rather than downscaling it — the fix for blurry zoomed vector plans.
      if (process.env.SMOKE_SHARP) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,500));
              const OLD_CAP=16777216, pv=App.Viewer._pdfViewer;
              const vp=pv.getPageView(0).viewport, cur=pv.currentScale;
              const w1=vp.width/cur, h1=vp.height/cur;         // scale-1 CSS px
              const scale=Math.sqrt(OLD_CAP*1.7/(w1*h1));      // past the old cap
              pv.currentScale=scale;
              for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,100));
                const c=document.querySelector('#viewer .page canvas');
                if(c&&c.width*c.height>OLD_CAP*1.2)break;}
              const c=document.querySelector('#viewer .page canvas');
              const cssW=parseFloat(c.style.width), dpr=window.devicePixelRatio||1;
              return JSON.stringify({ canvasPx:c.width*c.height, cssArea:cssW*parseFloat(c.style.height),
                sharpness:c.width/cssW, dpr, oldCap:OLD_CAP });
            })()`, true);
            console.log('[sharp] ' + r);
          } catch (e) { console.log('[sharp] error', e && e.message); }
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
      // SMOKE_MCOLOR: a chosen measurement color applies only to measurements
      // drawn AFTER the change; earlier ones keep their color, and Reset goes
      // back to the per-type default. Drives the real tool flow (handleClick).
      if (process.env.SMOKE_MCOLOR) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,500));
              const M=App.Measure, z=App.state.zoom;
              const ov={getBoundingClientRect:()=>({left:0,top:0})};
              function line(x1,y1,x2,y2){
                M.startTool('length');
                M.handleClick(1,ov,{clientX:x1*z,clientY:y1*z,shiftKey:false});
                M.handleClick(1,ov,{clientX:x2*z,clientY:y2*z,shiftKey:false});
              }
              line(40,60,200,60);      // default (blue)
              M.setColor('#ff0000');   // pick red
              line(40,120,200,120);    // red
              M.setColor(null);        // reset to per-type default
              line(40,180,200,180);    // default again
              const ms=App.state.measurements;
              const c=[ms[0].color,ms[1].color,ms[2].color];
              M.repositionAll();
              await new Promise(r=>setTimeout(r,60));
              const strokes=Array.from(document.querySelectorAll('.page[data-page-number="1"] .measure-layer polyline.m-shape')).map(p=>p.getAttribute('stroke'));
              let exportOk=false; try{ await App.Save.buildBytes(); exportOk=true; }catch(e){}
              return JSON.stringify({n:ms.length,c,strokes,exportOk});
            })()`, true);
            console.log('[mcolor] ' + r);
          } catch (e) { console.log('[mcolor] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_DUP: the selected placed object can be duplicated (Ctrl+D) and
      // copy/pasted (Ctrl+C/Ctrl+V) into an offset copy. Covers placements and
      // markups, driven through the real window keydown path.
      if (process.env.SMOKE_DUP) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              const K=(key)=>window.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey:true,bubbles:true,cancelable:true}));
              const clearAll=()=>{App.Placement.deselect();App.Markup.deselect();App.state.measureSelectedId=null;App.Measure.repositionAll();};
              // placement duplicate via Ctrl+D
              clearAll();
              App.state.placementSeq++;
              const p0={id:App.state.placementSeq,type:'date',page:1,vx:100,vy:100,vw:80,vh:19,text:'HELLO',fontPt:14};
              App.state.placements.push(p0); App.Placement.repositionAll(); App.Placement.select(p0.id);
              K('d');
              const pl=App.state.placements, np=pl[pl.length-1];
              const place={after:pl.length,offX:np.vx-p0.vx,offY:np.vy-p0.vy,text:np.text,newId:np.id!==p0.id,selected:App.state.selectedId===np.id};
              // markup copy/paste via Ctrl+C then Ctrl+V (twice → cascades)
              clearAll();
              App.state.annoSeq=(App.state.annoSeq||0)+1;
              const a0={id:App.state.annoSeq,page:1,type:'text',pts:[{vx:50,vy:50}],style:{stroke:'#e5484d',fill:'none',width:2,opacity:1,fontSize:14},text:'NOTE'};
              App.state.annotations.push(a0); App.Markup.select(a0.id);
              K('c'); K('v');
              const na1=App.state.annotations[App.state.annotations.length-1];
              const firstOff=na1.pts[0].vx-a0.pts[0].vx; // 14 for the first paste
              K('v'); // cascade: offsets again from na1
              const an=App.state.annotations, na=an[an.length-1];
              const markup={after:an.length,offX:firstOff,cascadeOff:na.pts[0].vx-na1.pts[0].vx,text:na.text,newId:na.id!==a0.id};
              return JSON.stringify({place,markup});
            })()`, true);
            console.log('[dup] ' + r);
          } catch (e) { console.log('[dup] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_MKPRESET: the markup Line color exposes 6 quick presets; clicking
      // one applies it (native input + default style + active swatch), and the
      // color-wheel (native input) still applies a custom color.
      if (process.env.SMOKE_MKPRESET) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,300));
              const btns=Array.from(document.querySelectorAll('#mk-stroke-presets .mk-sw'));
              const count=btns.length;
              const blue=btns.find(b=>b.dataset.color==='#2f6fed');
              blue.click();
              await new Promise(r=>setTimeout(r,20));
              const inputVal=document.querySelector('#mk-stroke').value;
              const defStroke=App.state.annoStyle.stroke;
              const active=btns.filter(b=>b.classList.contains('active')).map(b=>b.dataset.color);
              const el=document.querySelector('#mk-stroke'); el.value='#abcdef'; el.dispatchEvent(new Event('input',{bubbles:true}));
              const customDef=App.state.annoStyle.stroke;
              // Restore the default markup style: applyStyle persists annoStyle to
              // localStorage, which is shared across the suite's Electron runs, so
              // leaving a custom color here would poison later color-sensitive
              // scenarios (e.g. wysiwyg's red-pixel check).
              App.state.annoStyle={stroke:'#e5484d',fill:'none',width:2,opacity:1,fontSize:14};
              if(App.Prefs)App.Prefs.set('annoStyle',App.state.annoStyle);
              return JSON.stringify({count,inputVal,defStroke,active,customDef});
            })()`, true);
            console.log('[mkpreset] ' + r);
          } catch (e) { console.log('[mkpreset] error', e && e.message); }
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
      // SMOKE_TFONT: a text box exposes font-family + size controls that update
      // the on-screen box AND survive export — the flatten path embeds the
      // matching StandardFont, the live-annotation path writes the mapped DA font.
      if (process.env.SMOKE_TFONT) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!document.querySelector('.page .markup-layer');i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              const layer=document.querySelector('.page .markup-layer');
              const rc=layer.getBoundingClientRect();
              // Font controls are hidden until a text context is active.
              const famEl=document.querySelector('#mk-font-family'), sizeEl=document.querySelector('#mk-font-size');
              const hiddenBefore=famEl.closest('.mk-font-only').classList.contains('hidden');
              App.Markup.startTool('text');
              App.Markup.handleClick(1,layer,{clientX:rc.left+120,clientY:rc.top+120,shiftKey:false});
              const div=document.querySelector('.markup-svg .anno-text[contenteditable="true"]');
              if(div){div.textContent='Hi';div.dispatchEvent(new Event('blur'));}
              const an=App.state.annotations.filter(a=>a.type==='text').pop();
              App.Markup.select(an.id);
              const shownWhenSelected=!famEl.closest('.mk-font-only').classList.contains('hidden');
              // Change family + size through the real UI controls.
              famEl.value='Times'; famEl.dispatchEvent(new Event('change',{bubbles:true}));
              sizeEl.value='28'; sizeEl.dispatchEvent(new Event('input',{bubbles:true}));
              const styFam=an.style.fontFamily, stySize=an.style.fontSize;
              const fo=document.querySelector('.markup-svg foreignObject[data-anno-id="'+an.id+'"] .anno-text');
              const cssFam=fo?getComputedStyle(fo).fontFamily:'';
              // Export both ways and confirm the font choice made it into the bytes.
              // (Read the FreeText DA back through pdf-lib — the raw bytes are
              // object-stream compressed, so a byte-scan can't see it.)
              App.state.saveAnnots=true;
              const asBytes=await App.Save.buildBytes();
              const {PDFDocument,PDFName}=window.PDFLib;
              const rt=await PDFDocument.load(asBytes.slice(0));
              let da='';
              const annots=rt.getPage(0).node.Annots();
              if(annots)for(let i=0;i<annots.size();i++){
                const dict=rt.context.lookup(annots.get(i));
                const st=dict&&dict.get(PDFName.of('Subtype'));
                if(st&&st.asString&&st.asString()==='/FreeText'){const d=dict.get(PDFName.of('DA'));if(d&&d.asString)da=d.asString();}
              }
              const daHasFont=/TiRo\\s+28\\s+Tf/.test(da);
              App.state.saveAnnots=false;
              const flatBytes=await App.Save.buildBytes();
              const flatOk=flatBytes&&flatBytes.length>1000;
              // Restore the shared default style so later suite runs aren't poisoned.
              App.state.annoStyle={stroke:'#e5484d',fill:'none',width:2,opacity:1,fontSize:14,fontFamily:'Helvetica'};
              if(App.Prefs)App.Prefs.set('annoStyle',App.state.annoStyle);
              return JSON.stringify({hiddenBefore,shownWhenSelected,styFam,stySize,cssFam,daHasFont,flatOk});
            })()`, true);
            console.log('[tfont] ' + r);
          } catch (e) { console.log('[tfont] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_TROT: a flattened text box stays horizontal-on-screen on a rotated
      // page. When the export viewport carries a rotation (as a plan sheet with an
      // intrinsic /Rotate does), the on-screen writing direction maps to a
      // non-horizontal PDF-space vector, so the flatten path must rotate the glyphs
      // to follow it — otherwise the saved text reads vertically. We flatten once
      // through a rotated viewport and once through the plain one and read the
      // drawn text matrix back with PDF.js: rotated => off-diagonal terms, plain
      // => axis-aligned.
      if (process.env.SMOKE_TROT) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!document.querySelector('.page .markup-layer');i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              const layer=document.querySelector('.page .markup-layer');
              const rc=layer.getBoundingClientRect();
              App.Markup.startTool('text');
              App.Markup.handleClick(1,layer,{clientX:rc.left+120,clientY:rc.top+120,shiftKey:false});
              const div=document.querySelector('.markup-svg .anno-text[contenteditable="true"]');
              if(div){div.textContent='ROT';div.dispatchEvent(new Event('blur'));}
              const pg=await App.state.pdfDoc.getPage(1);
              const flat=async(vp)=>{App.state.baseViewports[0]=vp;App.state.saveAnnots=false;return await App.Save.buildBytes();};
              const readMatrix=async(bytes)=>{
                const doc=await window.pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
                const page=await doc.getPage(1);
                const tc=await page.getTextContent();
                const it=tc.items.find(x=>(x.str||'').includes('ROT'));
                if(!it)return null;
                const t=it.transform;
                return {b:+t[1].toFixed(3),c:+t[2].toFixed(3)};
              };
              const rot=await readMatrix(await flat(pg.getViewport({scale:1,rotation:90})));
              const plain=await readMatrix(await flat(pg.getViewport({scale:1})));
              App.state.saveAnnots=false;
              return JSON.stringify({rot,plain});
            })()`, true);
            console.log('[trot] ' + r);
          } catch (e) { console.log('[trot] error', e && e.message); }
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
      // SMOKE_PRINT: the print path hands the OS default PDF app the complete
      // exported document — a non-blank PDF with one page per sheet — and the
      // main process writes a temp PDF and reports ok (opening is skipped on CI
      // via SMOKE_NO_PRINT_OPEN, since headless has no PDF handler).
      if (process.env.SMOKE_PRINT) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,500));
              const bytes=await App.Save.buildBytes();
              // The exported PDF the printer receives: same page count, not blank.
              const doc=await window.pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise;
              const printPages=doc.numPages;
              const page=await doc.getPage(1);
              const vp=page.getViewport({scale:1});
              const c=document.createElement('canvas');
              const w=c.width=Math.ceil(vp.width), h=c.height=Math.ceil(vp.height);
              await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
              const d=c.getContext('2d').getImageData(0,0,w,h).data;
              let darkPx=0; for(let i=0;i<d.length;i+=4){ if(d[i]<200&&d[i+1]<200&&d[i+2]<200)darkPx++; }
              try{doc.destroy();}catch(_){}
              // Drive the real IPC print path (open is skipped in this harness).
              const res=await window.api.print(bytes);
              return JSON.stringify({numPages:App.state.numPages,printPages,w,h,darkPx,
                printOk:!!(res&&res.ok),hasFile:!!(res&&res.file)});
            })()`, true);
            console.log('[print] ' + r);
          } catch (e) { console.log('[print] error', e && e.message); }
          app.quit();
        }, 1200);
        return;
      }
      // SMOKE_PRINTPREVIEW: the print flow shows a preview modal with one rendered
      // (non-blank) thumbnail per page; a typed page range narrows the print to a
      // subset (App.Print.buildSubset yields a PDF with just those pages); and
      // cancelling closes the modal without printing (preview resolves null).
      if (process.env.SMOKE_PRINTPREVIEW) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.numPages;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,500));
              const bytes=await App.Save.buildBytes();
              const grid=document.getElementById('pp-grid');
              const fire=(el,t)=>el.dispatchEvent(new Event(t,{bubbles:true}));

              // --- pass 1: open, render thumbnails, then cancel ---
              let pending=App.Print.preview(bytes);
              let thumbs=0,drawn=0;
              for(let i=0;i<80;i++){
                const cs=[...grid.querySelectorAll('.pp-thumb')];
                thumbs=cs.length; drawn=cs.filter(c=>c.dataset.done).length;
                if(thumbs===App.state.numPages && drawn>0) break;
                await new Promise(r=>setTimeout(r,100));
              }
              const open=!document.getElementById('printprev-modal').classList.contains('hidden');
              let darkPx=0; const first=grid.querySelector('.pp-thumb');
              if(first && first.width){ const x=first.getContext('2d');
                const d=x.getImageData(0,0,first.width,first.height).data;
                for(let i=0;i<d.length;i+=4){ if(d[i]<200&&d[i+1]<200&&d[i+2]<200)darkPx++; } }
              App.Print.cancel();
              const proceed=await pending;
              const closed=document.getElementById('printprev-modal').classList.contains('hidden');

              // --- pass 2: open, choose a range, print a subset ---
              const N=App.state.numPages;
              const range = N>=2 ? '1' : '1';          // first page only
              pending=App.Print.preview(bytes);
              for(let i=0;i<40 && !grid.querySelector('.pp-thumb');i++) await new Promise(r=>setTimeout(r,50));
              const rr=document.getElementById('pp-mode-range'); rr.checked=true; fire(rr,'change');
              const inp=document.getElementById('pp-range'); inp.value=range; fire(inp,'input');
              const excluded=[...grid.querySelectorAll('.pp-tile.excluded')].length;
              const printDisabled=document.getElementById('pp-print').disabled;
              App.Print.confirm();
              const sel=await pending;
              const sub=await App.Print.buildSubset(bytes, sel.pages, sel.total);
              const jsdoc=await window.pdfjsLib.getDocument({data:new Uint8Array(sub)}).promise;
              const subPages=jsdoc.numPages; try{jsdoc.destroy();}catch(_){}

              // --- pass 3: "Current page" prints only the page being viewed ---
              const cur = N>=2 ? 2 : 1;                 // pretend we were viewing this page
              pending=App.Print.preview(bytes, cur);
              for(let i=0;i<40 && !grid.querySelector('.pp-thumb');i++) await new Promise(r=>setTimeout(r,50));
              const curLabel=(document.getElementById('pp-current-n')||{}).textContent||'';
              const rc=document.getElementById('pp-mode-current'); rc.checked=true; fire(rc,'change');
              const curExcluded=[...grid.querySelectorAll('.pp-tile.excluded')].length;
              App.Print.confirm();
              const curSel=await pending;

              return JSON.stringify({numPages:N,thumbs,drawn,open,closed,proceed,darkPx,
                selPages:sel&&sel.pages,excluded,printDisabled,subPages,
                curLabel,curExcluded,curSelPages:curSel&&curSel.pages});
            })()`, true);
            console.log('[printpreview] ' + r);
          } catch (e) { console.log('[printpreview] error', e && e.message); }
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
      // SMOKE_MRESIZE: a placed measurement exposes per-vertex grab handles on
      // selection; dragging an endpoint handle extends/shortens the line (and
      // recomputes its value), and the selected line's color + thickness can be
      // edited after the fact. Drives the real handle + panel-editor paths.
      if (process.env.SMOKE_MRESIZE) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!App.state.pageEls.length;i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,400));
              const M=App.Measure;
              App.state.scales[1]={factor:1,unit:'ft',ratioLabel:'t'};
              App.state.measureSeq++;
              const id=App.state.measureSeq;
              App.state.measurements.push({id,page:1,type:'length',pts:[{vx:100,vy:100},{vx:200,vy:100}],value:100,unit:'ft',width:2,color:'#2f6fed',label:'100 ft'});
              M.select(id);
              await new Promise(r=>setTimeout(r,80));
              // grab the endpoint handle (second vertex) and stretch it +80px
              const handles=Array.from(document.querySelectorAll('.measure-layer .m-handle'));
              const hasHandles=handles.length===2;
              const beforeLen=App.state.measurements[0].value;
              let resized=false;
              if(handles.length){
                const h=handles[handles.length-1], b=h.getBoundingClientRect();
                h.dispatchEvent(new PointerEvent('pointerdown',{clientX:b.left+b.width/2,clientY:b.top+b.height/2,bubbles:true,cancelable:true}));
                window.dispatchEvent(new PointerEvent('pointermove',{clientX:b.left+b.width/2+80,clientY:b.top+b.height/2,bubbles:true}));
                window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
                resized=App.state.measurements[0].pts[1].vx>200 && App.state.measurements[0].value>beforeLen;
              }
              // edit the selected line's color + thickness via the panel API
              M.setSelectedColor('#ff0000'); M.endEdit();
              M.setSelectedWidth(5); M.endEdit();
              const col=App.state.measurements[0].color, wid=App.state.measurements[0].width;
              M.repositionAll();
              await new Promise(r=>setTimeout(r,60));
              const line=document.querySelector('.page[data-page-number="1"] .measure-layer polyline.m-shape');
              const stroke=line&&line.getAttribute('stroke');
              const sw=line&&line.style.strokeWidth;
              let exportOk=false; try{ await App.Save.buildBytes(); exportOk=true; }catch(e){}
              return JSON.stringify({hasHandles,resized,col,wid,stroke,sw,exportOk});
            })()`, true);
            console.log('[mresize] ' + r);
          } catch (e) { console.log('[mresize] error', e && e.message); }
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
      // SMOKE_FREEHAND: the highlighter + freehand pen paint a live multi-point
      // stroke on press-drag (not a two-point box), and holding still snaps the
      // stroke to a clean straight line. Exercised via the real inkStart/inkMove/
      // inkEnd path plus the deterministic _straighten hook.
      if (process.env.SMOKE_FREEHAND) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async()=>{
              for(let i=0;i<80&&!document.querySelector('.page .markup-layer');i++)await new Promise(r=>setTimeout(r,100));
              await new Promise(r=>setTimeout(r,600));
              const layer=document.querySelector('.page .markup-layer');
              const rc=layer.getBoundingClientRect();
              const P=(x,y)=>({clientX:rc.left+x,clientY:rc.top+y});
              const draw=(tool,pts)=>{
                App.Markup.startTool(tool);
                App.Markup.inkStart(1,layer,P(pts[0][0],pts[0][1]));
                for(let i=1;i<pts.length;i++) App.Markup.handleMove(1,layer,P(pts[i][0],pts[i][1]));
                App.Markup.inkEnd();
              };
              // 1) freehand highlighter — a curvy multi-point stroke
              draw('highlight',[[40,60],[70,90],[110,70],[150,110],[190,80]]);
              const hl=App.state.annotations[App.state.annotations.length-1];
              // 2) freehand pen
              draw('ink',[[40,200],[70,230],[110,210],[150,250]]);
              const ink=App.state.annotations[App.state.annotations.length-1];
              // 3) hold-to-straighten: draw, then fire the straighten hook mid-stroke
              App.Markup.startTool('highlight');
              App.Markup.inkStart(1,layer,P(40,320));
              App.Markup.handleMove(1,layer,P(80,360));
              App.Markup.handleMove(1,layer,P(140,330));
              App.Markup.handleMove(1,layer,P(200,370));
              App.Markup._straighten(1);
              const straightMid=App.Markup.active&&App.Markup.active.pts.length;
              App.Markup.inkEnd();
              const straight=App.state.annotations[App.state.annotations.length-1];
              App.Markup.repositionAll();
              const polylines=document.querySelectorAll('#viewer .markup-svg polyline').length;
              // 4) smoothing: the curve-fit render densifies the raw pen stroke.
              const inkSmoothPts=App.Markup.smoothStroke(ink).length;
              const straightSmoothPts=App.Markup.smoothStroke(straight).length; // 2-pt stays 2
              // 5) single-key tool shortcuts arm tools instantly; V returns to select.
              const key=(k)=>window.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));
              key('a'); const kA=App.Markup.tool;
              key('h'); const kH=App.Markup.tool;
              key('v'); const kV=App.Markup.tool, kVmode=App.state.mode;
              let bytesLen=0,err='';
              try{const b=await App.Save.buildBytes();bytesLen=b.length;}catch(e){err=e.message;}
              return JSON.stringify({
                hlType:hl&&hl.type, hlPts:hl&&hl.pts.length,
                inkType:ink&&ink.type, inkPts:ink&&ink.pts.length,
                straightMid, straightPts:straight&&straight.pts.length,
                inkPtsRaw:ink&&ink.pts.length, inkSmoothPts, straightSmoothPts,
                kA, kH, kV, kVmode,
                polylines, bytesLen, err
              });
            })()`, true);
            console.log('[freehand] ' + r);
          } catch (e) { console.log('[freehand] error', e && e.message); }
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
      // SMOKE_DSIGN: the restructured digital-signature dialog — saved digital IDs
      // (attach once, remembered), the placement-mode picker (Invisible / Click /
      // Corner) with its visual corner grid + live preview, and forgetting an ID.
      if (process.env.SMOKE_DSIGN) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 80 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              App.DigitalIds.clear();
              const out = {};
              // Empty state → attach form, no saved chips.
              App.DigiSign.open();
              out.emptyShowsNew = !App.$('#dsig-new').classList.contains('hidden');
              out.emptyHidesSaved = App.$('#dsig-saved-wrap').classList.contains('hidden');
              out.modeCount = document.querySelectorAll('input[name="dsig-mode"]').length;
              out.cornerBtns = document.querySelectorAll('.dsig-corner-btn').length;
              // Corner mode reveals the grid + preview; picking a corner selects it.
              const cr = document.querySelector('input[name="dsig-mode"][value="corner"]');
              cr.checked = true; cr.dispatchEvent(new Event('change'));
              out.cornerOptsShown = !App.$('#dsig-corner-opts').classList.contains('hidden');
              out.previewShown = !App.$('#dsig-preview').classList.contains('hidden');
              document.querySelector('.dsig-corner-btn[data-corner="tl"]').click();
              out.tlSelected = document.querySelector('.dsig-corner-btn[data-corner="tl"]').classList.contains('selected');
              const nr = document.querySelector('input[name="dsig-mode"][value="none"]');
              nr.checked = true; nr.dispatchEvent(new Event('change'));
              out.previewHiddenOnNone = App.$('#dsig-preview').classList.contains('hidden');
              // A saved ID prefills everything and enables Sign without retyping.
              App.DigitalIds.save({ label:'Work ID', fileName:'work.p12', p12:'AAA=', savePass:true, pass:'pw', name:'Jane Doe', reason:'Approve', location:'NYC' });
              App.DigiSign.open();
              out.savedShown = !App.$('#dsig-saved-wrap').classList.contains('hidden');
              out.chipCount = document.querySelectorAll('#dsig-id-list .dsig-id').length;
              out.namePrefilled = App.$('#dsig-name').value === 'Jane Doe';
              out.goEnabled = !App.$('#dsig-go').disabled;
              // Forget drops it back to the empty state.
              document.querySelector('#dsig-id-list .dsig-id-forget').click();
              out.afterForget = App.DigitalIds.list().length;
              return JSON.stringify(out);
            })()`, true);
            console.log('[dsign] ' + r);
          } catch (e) { console.log('[dsign] error', e && e.message); }
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
              // continuous: an open multi-segment run whose value is the sum of every leg
              A.measurements.push({ id: 6, page: 2, type: 'continuous', pts: [{vx:100,vy:100},{vx:300,vy:100},{vx:300,vy:300}] });
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
      // SMOKE_MSNAP: the take-off precision features — snap-to-drawing geometry,
      // feet-inches display, and per-segment breakdown. sample.pdf carries a
      // border-box rectangle whose corners the content-snap index must find.
      if (process.env.SMOKE_MSNAP) {
        setTimeout(async () => {
          try {
            const r = await mainWindow.webContents.executeJavaScript(`(async () => {
              for (let i = 0; i < 40 && !App.state.numPages; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 400));
              const A = App.state;
              // (6) content snapping: harvest page 1 and snap near the box corner.
              App.Snap.ensure(1);
              for (let i = 0; i < 60 && !App.Snap._pages[1]; i++) await new Promise(r => setTimeout(r, 50));
              const store = App.Snap._pages[1];
              const snapPoints = store ? store.count : 0;
              const s = App.Snap.query(1, { vx: 75, vy: 95 }, 12);
              const snapHit = s ? { vx: Math.round(s.vx), vy: Math.round(s.vy) } : null;
              // (5) feet-inches + (7) per-segment lengths.
              A.scales[1] = { factor: 1, unit: 'ft', ratioLabel: '1pt=1ft' };
              A.measurements.push({ id: 1, page: 1, type: 'length', pts: [{vx:100,vy:100},{vx:130,vy:100}] });
              A.measurements.push({ id: 2, page: 1, type: 'perimeter', pts: [{vx:0,vy:0},{vx:40,vy:0},{vx:40,vy:30}] });
              App.Measure.recomputeAll();
              const decimal = A.measurements[0].label;
              App.Measure.setFeetInches(true);
              const ftin = A.measurements[0].label;
              const segs = App.segmentLengths('perimeter', A.measurements[1].pts, A.scales[1]);
              return JSON.stringify({ snapPoints, snapHit, decimal, ftin, segs });
            })()`, true);
            console.log('[msnap]', r);
          } catch (e) { console.log('[msnap] error', e && e.message); }
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
    // Skip when files are already buffered — this window may have been created
    // to open a *new* file (e.g. a warm macOS re-open), and process.argv still
    // holds the original launch path, which would otherwise clobber it.
    if (!pendingFiles.length) {
      openManyInRenderer(filesFromArgv(process.argv));
    }
  });

  // Prompt to save unsaved edits before the window closes.
  attachCloseGuard(mainWindow);

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
    // Windows can batch a multi-select "Open with" into one second-instance,
    // so open every PDF the argv carries, not just the first.
    openManyInRenderer(filesFromArgv(argv));
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    // macOS keeps the app alive after the last window closes. The SMOKE_REOPEN
    // e2e emulates that on Linux CI so the windowless file-open path is testable.
    if (process.platform !== 'darwin' && !process.env.SMOKE_REOPEN) app.quit();
  });

  // A debounced bounds write could still be pending when the app exits — flush.
  // Also drop any temp PDFs we opened for printing (the OS PDF app is done with
  // them by the time the user quits; a still-held file just fails to unlink).
  app.on('before-quit', () => {
    if (store) store.flushNow();
    while (printTempFiles.length) {
      try { fs.unlinkSync(printTempFiles.pop()); } catch (_) { /* ignore */ }
    }
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

// Native open dialog with multi-select. Returns an array of readPdf results
// (in the order the dialog reports them) or null on cancel. Reads run in
// parallel; each entry carries its own { ok, error } so one bad file doesn't
// sink the rest.
ipcMain.handle('dialog:openPdfMulti', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled || !filePaths.length) return null;
  return Promise.all(filePaths.map((p) => readPdf(p)));
});

// The renderer has finished booting and is now listening for 'open-file-path'.
// Flush any file that arrived before the renderer was ready.
ipcMain.on('renderer-ready', (e) => {
  // A torn-off window: hand it its buffered document and stop (it isn't the
  // primary window, so it must not claim `pendingFiles` or flip rendererReady).
  const pend = pendingTearoffs.get(e.sender.id);
  if (pend) {
    pendingTearoffs.delete(e.sender.id);
    e.sender.send('open-tearoff', pend);
    return;
  }
  rendererReady = true;
  if (pendingFiles.length) {
    const files = pendingFiles;
    pendingFiles = [];
    files.forEach((f) => e.sender.send('open-file-path', f));
  }
});

// Renderer asks to pop a document into its own window (tab tear-off).
ipcMain.handle('window:openTearoff', (_e, payload) => {
  if (!payload || !payload.base) return false;
  createChildWindow(payload);
  return true;
});

// Tile the requesting window and one other app window (a torn-off window if any,
// else the main window) to the left/right halves of the display — one per
// monitor when a second display is available. Complements tab tear-off so a
// document dragged to another monitor lands cleanly beside the original.
ipcMain.handle('window:tile', (e) => {
  const requester = BrowserWindow.fromWebContents(e.sender);
  if (!requester) return { ok: false, reason: 'No window to tile.' };
  // The "other" window: prefer a different app window (torn-off or main).
  let other = null;
  for (const w of childWindows) { if (w !== requester && !w.isDestroyed()) { other = w; break; } }
  if (!other && mainWindow && mainWindow !== requester && !mainWindow.isDestroyed()) other = mainWindow;
  if (!other) return { ok: false, reason: 'Open a second window first (drag a tab to another monitor).' };
  const displays = screen.getAllDisplays();
  requester.unmaximize(); other.unmaximize();
  if (displays.length >= 2) {
    requester.setBounds(displays[0].workArea); other.setBounds(displays[1].workArea);
  } else {
    const wa = screen.getDisplayMatching(requester.getBounds()).workArea;
    const halfW = Math.floor(wa.width / 2);
    requester.setBounds({ x: wa.x, y: wa.y, width: halfW, height: wa.height });
    other.setBounds({ x: wa.x + halfW, y: wa.y, width: wa.width - halfW, height: wa.height });
  }
  return { ok: true };
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

// Temp PDFs written for printing. We hand them to the OS default PDF app, which
// owns the file until the user is done, so we can't delete them inline — they're
// cleaned up when the app quits.
const printTempFiles = [];

// Print the finished document (all pages, with every placement/markup/measure
// baked in). The renderer hands us the same bytes `Save` would write; we write
// them to a temp PDF and drive the OS print dialog for it.
//
// On every desktop platform we print the PDF ourselves from a hidden window
// (Chromium's PDF plugin) so the native system print dialog — with preview and
// printer picker — pops up straight away. We deliberately no longer hand the
// file to `shell.openPath`: when *this* app is the OS default PDF handler
// (common once you've opened PDFs with it), openPath just reopens the temp file
// as another FieldMark window — the user gets a second copy of the document and
// never a printer picker, which reads as "I clicked Print and nothing happened".
// macOS was already fixed this way; Windows/Linux had the same latent bug.
// If the offscreen print can't get going, we fall back to the default viewer so
// the user still has a way to print.
ipcMain.handle('app:print', async (_e, bytes) => {
  if (!bytes) return { ok: false, error: 'Nothing to print' };
  try {
    const tmpFile = path.join(app.getPath('temp'), `fieldmark-print-${process.pid}-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, Buffer.from(bytes));
    printTempFiles.push(tmpFile);
    // The e2e smoke harness exercises the pipeline without launching an external
    // app or a print dialog (there's no PDF handler / printer on headless CI).
    if (process.env.SMOKE_NO_PRINT_OPEN) return { ok: true, file: tmpFile };
    return await printViaSystemDialog(tmpFile);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Desktop print path: load the temp PDF into a hidden window (Chromium's built-in
// PDF viewer) and call webContents.print(), which raises the native system print
// dialog with a live preview and printer picker. Resolves { ok, dialog:true } once
// the dialog closes (whether the user prints or cancels — cancel isn't an error).
// If the offscreen print can't get going at all, fall back to opening the file in
// the OS default viewer so the user still has a way to print.
function printViaSystemDialog(tmpFile) {
  return new Promise((resolve) => {
    let win = new BrowserWindow({
      show: false,
      webPreferences: { plugins: true, sandbox: false }
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { if (win && !win.isDestroyed()) win.close(); } catch (_) { /* ignore */ }
      win = null;
      resolve(result);
    };
    // If we can't render/print the PDF ourselves, open it in a viewer so the user
    // isn't left with no way to print at all. On macOS force Preview (an app that
    // isn't us, so we don't just reopen the file in FieldMark); on Windows/Linux
    // hand it to the OS default PDF handler.
    const fallbackToViewer = (why) => {
      try {
        if (process.platform === 'darwin') {
          const r = spawn('open', ['-a', 'Preview', tmpFile], { detached: true, stdio: 'ignore' });
          r.on('error', () => {});
          r.unref();
          finish({ ok: true, file: tmpFile });
        } else {
          shell.openPath(tmpFile).then(
            (err) => finish(err ? { ok: false, error: err, file: tmpFile } : { ok: true, file: tmpFile }),
            () => finish({ ok: false, error: why || 'Could not open the print dialog', file: tmpFile })
          );
        }
      } catch (_) {
        finish({ ok: false, error: why || 'Could not open the print dialog', file: tmpFile });
      }
    };

    win.webContents.once('did-fail-load', (_e2, code, desc) => fallbackToViewer(desc || ('load failed ' + code)));
    win.webContents.once('did-finish-load', () => {
      // Let the PDF plugin paint before we invoke print, or the job can come out blank.
      setTimeout(() => {
        if (!win || win.isDestroyed()) return finish({ ok: true, file: tmpFile, dialog: true });
        try {
          win.webContents.print({ silent: false, printBackground: true }, (_success, reason) => {
            // success=false is also how a user cancel is reported — not an error.
            finish({ ok: true, file: tmpFile, dialog: true });
            void reason;
          });
        } catch (e) {
          fallbackToViewer(e && e.message);
        }
      }, 400);
    });
    win.loadFile(tmpFile).catch((e) => fallbackToViewer(e && e.message));
  });
}

/* ------------------------------------------------------------------ */
/*  IPC: update check (compare app version to latest GitHub release)   */
/* ------------------------------------------------------------------ */

function fetchLatestRelease(owner, repo) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases/latest`,
      method: 'GET',
      headers: { 'User-Agent': 'FieldMark', Accept: 'application/vnd.github+json' }
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
