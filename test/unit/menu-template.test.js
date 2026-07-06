import { describe, it, expect } from 'vitest';
import { buildMenuTemplate } from '../../src/shared/menu-template.js';

// Depth-first search for the first submenu item with a given label.
function find(template, label) {
  for (const item of template) {
    if (item.label === label) return item;
    if (item.submenu) { const f = find(item.submenu, label); if (f) return f; }
  }
  return null;
}

describe('buildMenuTemplate', () => {
  it('has File / Edit / View / Help on every platform', () => {
    const t = buildMenuTemplate({ isMac: false });
    const labels = t.map((m) => m.label);
    expect(labels).toContain('File');
    expect(labels).toContain('Edit');
    expect(labels).toContain('View');
    expect(labels).toContain('Help');
  });

  it('adds an app menu + Window menu on macOS', () => {
    const t = buildMenuTemplate({ isMac: true, appName: 'PDF Signer' });
    expect(t[0].label).toBe('PDF Signer');
    expect(t.map((m) => m.label)).toContain('Window');
  });

  it('gives the Edit menu the native clipboard roles (fixes macOS Cmd+C/V)', () => {
    const t = buildMenuTemplate({ isMac: true });
    const roles = find(t, 'Edit').submenu.map((i) => i.role).filter(Boolean);
    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']));
  });

  it('wires accelerators for the core file actions', () => {
    const t = buildMenuTemplate({ isMac: false });
    expect(find(t, 'Open…').accelerator).toBe('CmdOrCtrl+O');
    expect(find(t, 'Save').accelerator).toBe('CmdOrCtrl+S');
    expect(find(t, 'Save As…').accelerator).toBe('CmdOrCtrl+Shift+S');
    expect(find(t, 'Print…').accelerator).toBe('CmdOrCtrl+P');
    expect(find(t, 'Find…').accelerator).toBe('CmdOrCtrl+F');
  });

  it('routes a command item through onCommand when clicked', () => {
    const seen = [];
    const t = buildMenuTemplate({ isMac: false, onCommand: (c) => seen.push(c) });
    find(t, 'Save').click();
    find(t, 'Zoom In').click();
    expect(seen).toEqual(['save', 'zoom-in']);
  });

  it('exposes Keyboard Shortcuts under Help', () => {
    const seen = [];
    const t = buildMenuTemplate({ isMac: false, onCommand: (c) => seen.push(c) });
    const item = find(t, 'Keyboard Shortcuts');
    expect(item).toBeTruthy();
    item.click();
    expect(seen).toEqual(['shortcuts']);
  });

  it('lists recent files and a Clear item, newest first', () => {
    const recent = [{ path: '/a/new.pdf', name: 'new.pdf' }, { path: '/a/old.pdf', name: 'old.pdf' }];
    const opened = [];
    let cleared = false;
    const t = buildMenuTemplate({
      isMac: false, recent,
      onOpenRecent: (e) => opened.push(e.path),
      onClearRecent: () => { cleared = true; }
    });
    const sub = find(t, 'Open Recent').submenu;
    expect(sub[0].label).toBe('new.pdf');
    expect(sub[1].label).toBe('old.pdf');
    sub[0].click();
    expect(opened).toEqual(['/a/new.pdf']);
    find(sub, 'Clear Recent').click();
    expect(cleared).toBe(true);
  });

  it('shows a disabled placeholder when there are no recent files', () => {
    const t = buildMenuTemplate({ isMac: false, recent: [] });
    const sub = find(t, 'Open Recent').submenu;
    expect(sub[0].label).toBe('No Recent Files');
    expect(sub[0].enabled).toBe(false);
  });
});
