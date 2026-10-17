'use strict';

/*
 * Grid — Revu's Show Grid / Snap to Grid. A light grid drawn over each page's
 * markup layer, and (when snap is on) markup clicks land on its intersections
 * (markup.js ptFromEvent -> App.snapToGrid). Spacing is in PDF points, so the
 * grid stays the same size on the sheet at every zoom.
 *
 * Settings persist in Prefs: gridShow, gridSnap, gridSpacing.
 */
(function () {
  const G = {};
  const get = (k, d) => (App.Prefs ? App.Prefs.get(k, d) : d);
  const put = (k, v) => { if (App.Prefs) App.Prefs.set(k, v); };

  G.showOn = () => !!get('gridShow', false);
  G.snapOn = () => !!get('gridSnap', false);
  G.spacing = () => { const n = +get('gridSpacing', 18); return n > 0 ? n : 18; };

  // Keep the CSS grid in step with zoom. Called from every markup re-render, so
  // a zoom change redraws it without a listener of its own.
  G.refresh = function () {
    document.body.classList.toggle('grid-on', G.showOn());
    const px = G.spacing() * (App.state.zoom || 1);
    document.documentElement.style.setProperty('--grid-px', px.toFixed(2) + 'px');
  };

  G.open = function () {
    App.$('#grid-show').checked = G.showOn();
    App.$('#grid-snap').checked = G.snapOn();
    App.$('#grid-spacing').value = String(G.spacing());
    App.$('#grid-modal').classList.remove('hidden');
    App.$('#grid-show').focus();
  };
  G.set = function (patch) {
    if ('show' in patch) put('gridShow', !!patch.show);
    if ('snap' in patch) put('gridSnap', !!patch.snap);
    if ('spacing' in patch) put('gridSpacing', +patch.spacing || 18);
    G.refresh();
  };

  G.init = function () {
    const w = (id, ev, fn) => { const el = App.$(id); if (el) el.addEventListener(ev, fn); };
    w('#grid-show', 'change', (e) => G.set({ show: e.target.checked }));
    w('#grid-snap', 'change', (e) => G.set({ snap: e.target.checked }));
    w('#grid-spacing', 'change', (e) => G.set({ spacing: e.target.value }));
    w('#grid-close', 'click', () => App.$('#grid-modal').classList.add('hidden'));
    G.refresh();
  };

  App.Grid = G;
})();
