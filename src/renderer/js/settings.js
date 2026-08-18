'use strict';

/*
 * Settings.
 *
 * Every preference in this app used to live inside the tool it belonged to: the
 * theme on a toolbar button, feet-inches and snapping three levels deep in the
 * Measure menu, save-as-editable at the bottom of the Markups panel, the update
 * check nowhere at all. There was no place to answer "how is this configured?"
 * — you had to already know where each switch lived.
 *
 * This is that place. It does not own the settings: each control reads and
 * writes the same App.Prefs key its original home does, and pushes the change
 * back through the owning module so the two never disagree.
 */
(function () {
  const S = {};
  const $ = (s) => App.$(s);

  // key, default, and how to apply a change to the running app. Apply is what
  // keeps the buried original control in sync with this one.
  const FIELDS = {
    theme: {
      def: 'dark',
      apply: (v) => { if (App.setTheme) App.setTheme(v); }
    },
    measureFeetInches: {
      def: false,
      apply: (v) => {
        const el = $('#measure-ftin');
        if (el && el.checked !== v) { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    },
    measureContentSnap: {
      def: true,
      apply: (v) => {
        const el = $('#measure-snap');
        if (el && el.checked !== v) { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    },
    snap: {
      def: true,
      apply: (v) => {
        const el = $('#mk-snap');
        if (el && el.checked !== v) { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    },
    saveAnnots: {
      def: false,
      apply: (v) => {
        const el = $('#mkp-annots');
        if (el && el.checked !== v) { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    },
    restoreDocState: { def: true, apply: () => {} },
    updateCheck: { def: true, apply: () => {} }
  };

  function get(key) {
    const f = FIELDS[key];
    return App.Prefs ? App.Prefs.get(key, f.def) : f.def;
  }

  function fill() {
    Object.keys(FIELDS).forEach((key) => {
      const el = $('#set-' + key);
      if (!el) return;
      const v = get(key);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    });
    const p = $('#set-persist-note');
    if (p && App.Prefs && App.Prefs.canPersist) {
      // If the device cannot store preferences at all, say so here rather than
      // letting every toggle silently forget itself.
      const ok = App.Prefs.canPersist();
      p.classList.toggle('hidden', ok);
    }
  }

  function onChange(e) {
    const el = e.target;
    const key = el.id && el.id.indexOf('set-') === 0 ? el.id.slice(4) : null;
    if (!key || !FIELDS[key]) return;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    if (App.Prefs) App.Prefs.set(key, v);
    try { FIELDS[key].apply(v); } catch (_) { /* a failed sync must not break the dialog */ }
  }

  S.open = function () {
    fill();
    $('#settings-modal').classList.remove('hidden');
  };
  S.close = function () { $('#settings-modal').classList.add('hidden'); };

  // Read a setting with its default, for modules that need it at boot.
  S.get = get;

  S.init = function () {
    const modal = $('#settings-modal');
    if (!modal) return;
    modal.addEventListener('change', onChange);
    const close = $('#settings-close');
    const done = $('#settings-done');
    if (close) close.addEventListener('click', S.close);
    if (done) done.addEventListener('click', S.close);
    const reset = $('#settings-reset');
    if (reset) {
      reset.addEventListener('click', async () => {
        const ok = await App.confirm(
          'Reset every setting to its default? Your documents and markups are not affected.',
          { title: 'Reset settings', okLabel: 'Reset', danger: true });
        if (!ok) return;
        Object.keys(FIELDS).forEach((key) => {
          if (App.Prefs) App.Prefs.set(key, FIELDS[key].def);
          try { FIELDS[key].apply(FIELDS[key].def); } catch (_) { /* keep going */ }
        });
        fill();
        App.toast('Settings reset to defaults.', 'success');
      });
    }
  };

  App.Settings = S;
})();
