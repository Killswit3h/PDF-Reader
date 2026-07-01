'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit surface exposed to the renderer. No raw node access.
contextBridge.exposeInMainWorld('api', {
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
    ipcRenderer.on('open-file-path', (_e, filePath) => cb(filePath))
});
