'use strict';

/*
 * Pure native-menu template builder (no Electron). `src/main.js` passes the
 * result to `Menu.buildFromTemplate`. Menu items that map to renderer actions
 * carry a `command` string and call `onCommand(command)`; the "Open Recent"
 * entries call `onOpenRecent(entry)` / `onClearRecent()`. Roles (copy, paste,
 * togglefullscreen, …) are left for Electron to fulfil natively — crucially the
 * Edit-menu roles are what make Cmd+C/V/X/A work in text fields on macOS, which
 * a null menu silently breaks.
 *
 * Kept free of `require('electron')` so the structure (labels, accelerators,
 * the recent submenu) can be asserted in a plain Node unit test.
 */

// Build the full template array.
//   opts.isMac       — true on darwin (adds the app menu + Window roles)
//   opts.isDev       — adds Reload / Toggle DevTools under View
//   opts.appName     — used in the app menu + About
//   opts.recent      — array of { path, name } (most-recent-first)
//   opts.onCommand   — (command) => void
//   opts.onOpenRecent— (entry)   => void
//   opts.onClearRecent — ()      => void
function buildMenuTemplate(opts) {
  const o = opts || {};
  const isMac = !!o.isMac;
  const send = (command) => () => { if (o.onCommand) o.onCommand(command); };
  const recent = Array.isArray(o.recent) ? o.recent : [];

  const recentSubmenu = recent.length
    ? recent.map((e) => ({
      label: e.name || e.path,
      click: () => { if (o.onOpenRecent) o.onOpenRecent(e); }
    })).concat([
      { type: 'separator' },
      { label: 'Clear Recent', click: () => { if (o.onClearRecent) o.onClearRecent(); } }
    ])
    : [{ label: 'No Recent Files', enabled: false }];

  const template = [];

  if (isMac) {
    template.push({
      label: o.appName || 'PDF Signer',
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: send('check-updates') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', command: 'open', click: send('open') },
      { label: 'Open Recent', submenu: recentSubmenu },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', command: 'save', click: send('save') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', command: 'save-as', click: send('save-as') },
      { type: 'separator' },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', command: 'print', click: send('print') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  });

  template.push({
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', command: 'undo', click: send('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', command: 'redo', click: send('redo') },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  });

  const viewSubmenu = [
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', command: 'zoom-in', click: send('zoom-in') },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', command: 'zoom-out', click: send('zoom-out') },
    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', command: 'zoom-reset', click: send('zoom-reset') },
    { label: 'Fit Width', accelerator: 'CmdOrCtrl+9', command: 'fit-width', click: send('fit-width') },
    { type: 'separator' },
    { label: 'Find…', accelerator: 'CmdOrCtrl+F', command: 'find', click: send('find') },
    { type: 'separator' },
    { label: 'Toggle Theme', command: 'toggle-theme', click: send('toggle-theme') },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ];
  if (o.isDev) {
    viewSubmenu.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' });
  }
  template.push({ label: 'View', submenu: viewSubmenu });

  if (isMac) {
    template.push({
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    });
  }

  const helpSubmenu = [
    { label: 'PDF Signer on GitHub', command: 'open-github', click: send('open-github') }
  ];
  if (!isMac) {
    helpSubmenu.unshift(
      { label: 'Check for Updates…', command: 'check-updates', click: send('check-updates') },
      { type: 'separator' }
    );
    helpSubmenu.push({ type: 'separator' }, { role: 'about' });
  }
  template.push({ role: 'help', label: 'Help', submenu: helpSubmenu });

  return template;
}

module.exports = { buildMenuTemplate };
