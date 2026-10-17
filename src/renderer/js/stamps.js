'use strict';

/*
 * Stamp picker — the standard review stamps (Approved, Revise & Resubmit,
 * As-Built, Void, ...) plus a custom-text stamp, the way Revu's Stamp tool
 * offers them. Choosing one arms the `stamp` markup tool (markup.js), which
 * drops it with one click and exports it as a live /Stamp annotation.
 *
 * Renderer-only: the library lives in src/shared/markup-tools.js.
 */
(function () {
  const S = {};
  const PREF = 'lastStamp';

  function modal() { return App.$('#stamp-modal'); }

  function arm(def) {
    if (!def) return;
    App.Markup.stampDef = def;
    if (App.Prefs) App.Prefs.set(PREF, def);
    close();
    if (App.Markup.textTool) App.Markup.stopTextMarkup();
    App.Markup.startTool('stamp');
    if (App.MarkupRail) App.MarkupRail.sync();
  }
  S.arm = arm;

  function render() {
    const list = App.$('#stamp-list'); if (!list) return;
    list.innerHTML = '';
    App.STAMPS.forEach((def) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stamp-opt';
      b.setAttribute('role', 'option');
      b.dataset.stamp = def.id;
      b.style.color = def.color;
      b.style.borderColor = def.color;
      b.textContent = def.text;
      if (def.date) {
        const d = document.createElement('small');
        d.textContent = App.stampDate(new Date());
        b.appendChild(d);
      }
      b.addEventListener('click', () => arm(def));
      list.appendChild(b);
    });
  }

  S.open = function () {
    if (!App.state.pdfDoc) return;
    render();
    modal().classList.remove('hidden');
    const first = App.$('#stamp-list .stamp-opt');
    if (first) first.focus();
  };
  function close() { modal().classList.add('hidden'); }
  S.close = close;

  function placeCustom() {
    const text = (App.$('#stamp-custom-text').value || '').trim().toUpperCase();
    if (!text) { App.toast('Type the stamp text first.', 'info'); App.$('#stamp-custom-text').focus(); return; }
    arm({ id: 'custom', text, color: App.$('#stamp-custom-color').value || '#1d4ed8',
      date: App.$('#stamp-custom-date').checked, name: 'Draft' });
  }

  S.init = function () {
    const saved = App.Prefs ? App.Prefs.get(PREF, null) : null;
    if (saved && saved.text) App.Markup.stampDef = saved;
    const c = App.$('#stamp-close'); if (c) c.addEventListener('click', close);
    const go = App.$('#stamp-custom-go'); if (go) go.addEventListener('click', placeCustom);
    const t = App.$('#stamp-custom-text');
    if (t) t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); placeCustom(); } });
  };

  App.Stamps = S;
})();
