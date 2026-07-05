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

  // ---- Updates ----
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdates: () => ipcRenderer.invoke('app:checkUpdates'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url)
});
