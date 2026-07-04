'use strict';

/*
 * Tool Chest — save & reuse custom markup tools and image stamps.
 *
 * Renderer-only (Tier A): tools are stored as JSON in App.Prefs (localStorage),
 * which works identically in Electron and the Android WebView. A markup tool
 * captures a shape type + style; an image stamp captures a PNG/JPEG the user
 * places like a signature.
 *
 * Tool shapes (App.Prefs 'toolChest'):
 *   { id, kind:'markup', name, type, style }
 *   { id, kind:'stamp',  name, dataUrl, aspect }
 */
(function () {
  const T = {};
  const KEY = 'toolChest';

  function load() { return (App.Prefs ? App.Prefs.get(KEY, []) : []) || []; }
  function save(list) { if (App.Prefs) App.Prefs.set(KEY, list); }
  function panel() { return App.$('#toolchest-panel'); }

  T.toggle = function () {
    const p = panel();
    const open = p.classList.toggle('hidden');
    document.body.classList.toggle('has-tcpanel', !open);
    if (!open) render();
  };
  function close() { panel().classList.add('hidden'); document.body.classList.remove('has-tcpanel'); }

  // ---- capture the current markup style/tool (or the selected annotation) ----
  function saveCurrentMarkup() {
    let type = null, style = null;
    const sel = App.state.annotations.find((a) => a.id === App.state.annoSelectedId);
    if (sel) { type = sel.type; style = Object.assign({}, sel.style); }
    else if (App.Markup && App.Markup.tool) { type = App.Markup.tool; style = Object.assign({}, App.state.annoStyle || {}); }
    if (!type) { App.toast('Pick a markup tool or select a markup first.', 'error', 4000); return; }
    const list = load();
    const name = `${type} · ${(style.stroke || '#000')}`;
    list.push({ id: 'tc' + Date.now(), kind: 'markup', name, type, style });
    save(list); render();
    App.toast(`Saved “${name}” to the Tool Chest.`, 'success');
  }

  // ---- add an image stamp from a local file ----
  function addImageStamp() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/*';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = () => {
          const aspect = img.naturalHeight ? img.naturalWidth / img.naturalHeight : 3;
          const list = load();
          const name = (file.name || 'stamp').replace(/\.[^.]+$/, '');
          list.push({ id: 'tc' + Date.now(), kind: 'stamp', name, dataUrl, aspect });
          save(list); render();
          App.toast(`Added stamp “${name}”.`, 'success');
        };
        img.onerror = () => App.toast('That image could not be loaded.', 'error');
        img.src = dataUrl;
      };
      reader.onerror = () => App.toast('Could not read that file.', 'error');
      reader.readAsDataURL(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  // ---- activate a tool ----
  function activate(tool) {
    if (!App.state.pdfDoc) return;
    if (tool.kind === 'markup') {
      App.state.annoStyle = Object.assign({}, tool.style);
      if (App.Prefs) App.Prefs.set('annoStyle', App.state.annoStyle);
      App.Markup.startTool(tool.type);
    } else if (tool.kind === 'stamp') {
      App.Placement.arm({ type: 'image', dataUrl: tool.dataUrl, aspect: tool.aspect, defaultWidthPt: 150 });
      App.setMode('stamp');
    }
    close();
  }

  function removeTool(id) {
    save(load().filter((t) => t.id !== id));
    render();
  }

  function render() {
    const list = App.$('#tc-list'); if (!list) return;
    const tools = load();
    list.innerHTML = '';
    if (!tools.length) {
      list.innerHTML = '<div class="mp-empty"><div class="mp-empty-ico">🧰</div>No saved tools yet.<br>' +
        'Save a markup style or add an image stamp.</div>';
      return;
    }
    tools.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'tc-row';
      const thumb = t.kind === 'stamp'
        ? `<img class="tc-thumb" src="${t.dataUrl}" alt="" />`
        : `<span class="tc-swatch" style="background:${(t.style && t.style.stroke) || '#888'}"></span>`;
      row.innerHTML =
        thumb +
        `<span class="tc-name">${esc(t.name)}</span>` +
        `<span class="tc-kind">${t.kind === 'stamp' ? 'stamp' : t.type}</span>` +
        `<button class="tc-del" title="Remove">✕</button>`;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('tc-del')) { removeTool(t.id); return; }
        activate(t);
      });
      list.appendChild(row);
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  T.init = function () {
    const b = (id, fn) => { const el = App.$(id); if (el) el.addEventListener('click', fn); };
    b('#tc-close', close);
    b('#tc-save-markup', saveCurrentMarkup);
    b('#tc-add-stamp', addImageStamp);
    render();
  };

  App.ToolChest = T;
})();
