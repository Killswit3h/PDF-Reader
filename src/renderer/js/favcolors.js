'use strict';

/*
 * Favourite colours — the UI over src/shared/favorite-colors.js.
 *
 * Why this exists: plan sets are colour-coded off a legend, and the legend
 * names exact hex codes per pay item ("Guardrail (Green) #3B7D23"). The six
 * generic presets on the markup bar cannot express that, so the only way to hit
 * the legend colour was to open the OS colour wheel and re-type the code for
 * every single markup. Favourites are entered once — typed, or pasted straight
 * out of the legend table — and then cost one click each.
 *
 * Renderer-only (Tier A): the list is JSON in App.Prefs (localStorage), so it
 * works identically in Electron and the Android WebView.
 *
 * Any toolbar with a colour control mounts a strip:
 *   App.FavColors.mount(el, { current: () => hex, onPick: (hex) => {} })
 * The strips re-render together, so a colour saved from the markup bar shows up
 * in the Measure menu without either module knowing about the other.
 */
(function () {
  const F = {};
  const KEY = 'favoriteColors';
  const mounts = [];

  function load() { return App.sanitizeFavorites(App.Prefs ? App.Prefs.get(KEY, []) : []); }
  function persist(list) {
    const clean = App.sanitizeFavorites(list);
    if (App.Prefs) App.Prefs.set(KEY, clean);
    F.refresh();
    return clean;
  }

  F.list = load;
  F.has = (hex) => App.isFavorite(load(), hex);

  /* ---------------- strips ---------------- */

  // `el` is the container for the swatches. `opts.current()` reports the colour
  // the owning tool is set to (so the matching swatch reads as active) and
  // `opts.onPick(hex)` applies one.
  F.mount = function (el, opts) {
    if (!el) return;
    const m = { el, opts: opts || {}, sig: null };
    mounts.push(m);
    // One delegated listener per strip: the swatches are rebuilt whenever the
    // list changes, and per-button listeners would be rebound with them.
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.fav-sw');
      if (!btn || !el.contains(btn)) return;
      const hex = btn.dataset.color;
      if (m.opts.onPick) m.opts.onPick(hex);
      F.refresh();
    });
    render(m);
  };

  // Rebuild only when the saved list actually changed — refresh() runs on every
  // property-bar sync, and replacing innerHTML each time would drop the focus
  // of anyone tabbing through the swatches. The active outline is cheap enough
  // to restate every call.
  function render(m) {
    const favs = load();
    const sig = JSON.stringify(favs);
    if (sig !== m.sig) {
      m.sig = sig;
      m.el.innerHTML = '';
      favs.forEach((f) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fav-sw';
        b.dataset.color = f.hex;
        b.style.background = f.hex;
        // The name alone is not enough to pick between two greens; the code is
        // what the legend is checked against.
        const label = f.name === f.hex.toUpperCase() ? f.hex.toUpperCase() : `${f.name} — ${f.hex.toUpperCase()}`;
        b.title = label;
        b.setAttribute('aria-label', label);
        m.el.appendChild(b);
      });
    }
    const cur = App.normalizeHex(m.opts.current ? m.opts.current() : null);
    m.el.querySelectorAll('.fav-sw').forEach((b) => b.classList.toggle('active', b.dataset.color === cur));
    m.el.classList.toggle('is-empty', !favs.length);
    if (m.opts.onRender) m.opts.onRender(favs, cur);
  }

  F.refresh = function () { mounts.forEach(render); };

  /* ---------------- add / remove from a toolbar ---------------- */

  // The star button next to a colour control: save this colour, or un-save it if
  // it is already on the list. Naming happens in the manage dialog — the toolbar
  // is the wrong place to stop and type.
  F.toggle = function (hex) {
    const h = App.normalizeHex(hex);
    if (!h) { App.toast('That is not a colour that can be saved.', 'error'); return; }
    if (App.isFavorite(load(), h)) {
      persist(App.removeFavorite(load(), h));
      App.toast(`Removed ${h.toUpperCase()} from favourites.`, 'info');
      return;
    }
    const r = App.addFavorite(load(), h);
    if (!r.added && r.reason === 'full') {
      App.toast(`Favourites are full (${App.FAV_LIMIT}). Remove one first.`, 'error');
      return;
    }
    persist(r.list);
    App.toast(`Saved ${h.toUpperCase()} to favourites — name it under Favourites…`, 'success');
  };

  // Keep a star button's state in step with the colour its toolbar is set to.
  // Both toolbars call this from their own sync pass rather than each rolling
  // their own idea of what "already saved" looks like.
  F.syncStar = function (el, hex) {
    if (!el) return;
    const on = F.has(hex);
    el.classList.toggle('is-fav', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = on ? 'Remove this color from favorites' : 'Save this color to favorites';
    el.title = label;
    el.setAttribute('aria-label', label);
  };

  /* ---------------- manage dialog ---------------- */

  function modal() { return App.$('#favcolor-modal'); }

  F.open = function () {
    const m = modal(); if (!m) return;
    const paste = App.$('#fav-paste');
    if (paste) paste.value = '';
    renderList();
    m.classList.remove('hidden');
  };
  F.close = function () { const m = modal(); if (m) m.classList.add('hidden'); };

  function renderList() {
    const wrap = App.$('#fav-list'); if (!wrap) return;
    const favs = load();
    wrap.innerHTML = '';
    if (!favs.length) {
      wrap.innerHTML = '<div class="fav-empty">No favourite colours yet. Paste your legend below, ' +
        'or pick a colour on the toolbar and hit the star.</div>';
      return;
    }
    favs.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'fav-row';
      row.innerHTML =
        `<input class="fav-row-color" type="color" value="${f.hex}" aria-label="Colour for ${esc(f.name)}" />` +
        `<input class="fav-row-name" type="text" value="${esc(f.name)}" maxlength="${App.FAV_NAME_MAX}" placeholder="Name (e.g. Guardrail)" aria-label="Name for ${f.hex.toUpperCase()}" />` +
        `<code class="fav-row-hex">${f.hex.toUpperCase()}</code>` +
        `<button class="fav-row-btn" data-act="up" title="Move up" aria-label="Move ${esc(f.name)} up"${i === 0 ? ' disabled' : ''}>${App.icon('chevron-up')}</button>` +
        `<button class="fav-row-btn" data-act="down" title="Move down" aria-label="Move ${esc(f.name)} down"${i === favs.length - 1 ? ' disabled' : ''}>${App.icon('chevron-down')}</button>` +
        `<button class="fav-row-btn fav-row-del" data-act="del" title="Remove" aria-label="Remove ${esc(f.name)}">${App.icon('trash')}</button>`;

      // Persist without rebuilding the list: 'change' fires on blur, and
      // replacing the row would drop the focus of anyone tabbing out of the
      // field into the buttons beside it. A rename moves nothing, so the rows
      // are already correct — only the strips outside need the new name.
      row.querySelector('.fav-row-name').addEventListener('change', (e) => {
        persist(App.renameFavorite(load(), f.hex, e.target.value));
      });
      row.querySelector('.fav-row-color').addEventListener('change', (e) => recolor(f.hex, e.target.value));
      row.querySelectorAll('.fav-row-btn').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'del') persist(App.removeFavorite(load(), f.hex));
        else persist(App.moveFavorite(load(), i, act === 'up' ? i - 1 : i + 1));
        renderList();
      }));
      wrap.appendChild(row);
    });
  }

  // Change one entry's colour in place, keeping its position and its name.
  function recolor(oldHex, value) {
    const h = App.normalizeHex(value);
    const cur = load();
    const at = App.indexOfHex(cur, oldHex);
    if (!h || at < 0) { renderList(); return; }
    if (h === cur[at].hex) return;
    if (App.isFavorite(cur, h)) {
      App.toast(`${h.toUpperCase()} is already in your favourites.`, 'error');
      renderList();
      return;
    }
    // A row still labelled with its own code should follow the code, not keep
    // advertising the colour it used to be.
    const name = cur[at].name === cur[at].hex.toUpperCase() ? h.toUpperCase() : cur[at].name;
    cur[at] = { hex: h, name };
    persist(cur);
    renderList();
  }

  // Bulk add from the paste box — the path that turns a legend table into a
  // palette in one go.
  function addPasted() {
    const box = App.$('#fav-paste');
    const text = box ? box.value : '';
    const entries = App.parseFavoriteList(text);
    if (!entries.length) {
      App.toast('No colour codes found in that text. Each line needs a hex code like #3B7D23.', 'error');
      return;
    }
    const r = App.mergeFavorites(load(), entries);
    persist(r.list);
    if (box) box.value = '';
    renderList();
    const bits = [`${r.added} added`];
    if (r.duplicate) bits.push(`${r.duplicate} already saved`);
    if (r.skipped) bits.push(`${r.skipped} skipped`);
    App.toast(bits.join(', ') + '.', r.added ? 'success' : 'info');
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  F.init = function () {
    const b = (id, fn) => { const el = App.$(id); if (el) el.addEventListener('click', fn); };
    b('#fav-close', F.close);
    b('#fav-done', F.close);
    b('#fav-add-pasted', addPasted);
    b('#fav-clear', async () => {
      if (!load().length) return;
      const ok = await App.confirm('Remove every favourite colour?', { title: 'Clear favourites', okLabel: 'Remove all', danger: true });
      if (!ok) return;
      persist([]);
      renderList();
    });
    // Clicking the scrim closes, like the app's other dialogs.
    const m = modal();
    if (m) m.addEventListener('mousedown', (e) => { if (e.target === m) F.close(); });
    F.refresh();
  };

  App.FavColors = F;
})();
