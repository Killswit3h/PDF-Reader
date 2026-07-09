'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Disable Chromium's native pinch / "smart" zoom. While it's enabled, Electron
// consumes trackpad-pinch and Ctrl/Cmd+wheel gestures as native page zoom, so
// the renderer's own `wheel` handler either never fires or sees `ctrlKey`
// stripped (electron/electron#12436). Pinning the visual-zoom limits to 1×
// releases those events to the DOM, where viewer.js turns them into PDF zoom.
try { webFrame.setVisualZoomLevelLimits(1, 1); } catch (_) { /* older Electron */ }

// Minimal, explicit surface exposed to the renderer. No raw node access.
contextBridge.exposeInMainWorld('api', {
  // Marks the Electron desktop build. The renderer uses this to let the native
  // application menu own the Cmd/Ctrl accelerators (Open/Save/Find/Undo/…) so
  // they don't double-fire against the shared in-page keyboard handler.
  isDesktop: true,

  // Native "Open PDF" dialog. Resolves to { ok, path, name, data } or null.
  openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),

  // Read a PDF by absolute path (drag-drop or "Open with").
  readPdf: (filePath) => ipcRenderer.invoke('file:readPdf', filePath),

  // Overwrite the opened PDF in place (Save — no dialog).
  writePdf: (filePath, bytes) => ipcRenderer.invoke('file:writePdf', { filePath, bytes }),

  // Native "Save As" dialog + write. bytes = Uint8Array of final PDF.
  savePdfDialog: (defaultName, bytes) =>
    ipcRenderer.invoke('dialog:savePdf', { defaultName, bytes }),

  // Native "Save As" dialog + write a text file (CSV export).
  saveTextDialog: (defaultName, text) =>
    ipcRenderer.invoke('dialog:saveText', { defaultName, text }),

  // Main process asks us to open a file (command-line / second-instance).
  onOpenFilePath: (cb) =>
    ipcRenderer.on('open-file-path', (_e, filePath) => cb(filePath)),

  // Tell the main process the renderer is ready to receive an initial file.
  // This closes the race where a launch-time "Open with" path would otherwise
  // be sent before this listener exists (and silently dropped).
  notifyReady: () => ipcRenderer.send('renderer-ready'),

  // A native-menu item was chosen; deliver the command string to the renderer.
  onMenuCommand: (cb) =>
    ipcRenderer.on('menu-command', (_e, command) => cb(command)),

  // Print the finished document. `bytes` is the exported PDF (Uint8Array); the
  // main process renders it offscreen and opens the OS print dialog.
  print: (bytes) => ipcRenderer.invoke('app:print', bytes),
  // Print pre-rendered page images wrapped in HTML — more reliable than handing
  // a PDF to Chromium's offscreen built-in viewer (which could print blank),
  // since images always paint. The renderer rasterizes each page with PDF.js.
  printHtml: (html) => ipcRenderer.invoke('app:printHtml', html),

  // ---- Updates ----
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdates: () => ipcRenderer.invoke('app:checkUpdates'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // Start downloading the available update in-app. Resolves { started } — false
  // when self-install isn't possible (falls back to openExternal in the UI).
  startUpdateDownload: () => ipcRenderer.invoke('app:startUpdateDownload'),
  // Quit and install the downloaded update.
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  // Download lifecycle events (electron-updater).
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, d) => cb(d)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, d) => cb(d))
});
