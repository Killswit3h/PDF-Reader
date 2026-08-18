'use strict';

/*
 * Onboarding — a friendly welcome tour for brand-new users, and a "What's new"
 * note for returning users after an update. Plus a Help menu that re-opens the
 * tour (and the keyboard cheat-sheet) at any time.
 *
 * Renderer-only (Tier A): pure DOM + App.Prefs (localStorage), so it ships
 * identically to Electron desktop and the Android WebView with no file-I/O
 * boundary work. The tour spotlights REAL toolbar/rail controls with a
 * coach-mark card ("this button does X"), stepping through the app's main
 * capabilities — open, view, sign, measure, redline, organize, save, help.
 *
 * First-run policy (see `decide`):
 *   - Fresh install (prefs blob empty, tour never seen) → the full welcome tour.
 *   - Returning user on a build with unseen release notes → a "What's new" card,
 *     NOT the tour (an update shouldn't restart onboarding).
 *   - Otherwise → nothing.
 * A fresh install is told apart from an existing user updating INTO this feature
 * by whether ANY pref already exists: a returning user has settings (theme,
 * saved signature, tool defaults…); a first launch has none. That snapshot is
 * taken at the very top of boot, before anything can write a pref.
 *
 * Both are recorded once (`seenWelcome`, `whatsNewRev`) so neither nags again;
 * the Help menu always offers the tour back. Auto-start is suppressed under the
 * e2e smoke harness (window.api.isSmokeTest) so the overlay can't interfere with
 * the other SMOKE_* scenarios.
 */
(function () {
  const PREF_SEEN = 'seenWelcome';
  const PREF_NOTES_REV = 'whatsNewRev';

  // Release notes shown to returning users. Bump `rev` (a monotonic integer)
  // and refresh `items` whenever an update ships a change worth surfacing; every
  // user who hasn't acknowledged that rev sees the card once, then never again.
  const NOTES = {
    rev: 1,
    heading: 'What’s new',
    sub: 'A couple of additions to help you get up to speed faster:',
    items: [
      { icon: 'tour', title: 'Guided welcome tour',
        body: 'New here? A quick, interactive walkthrough now points out the main tools. Replay it any time from the <b>Help (?)</b> menu.' },
      { icon: 'keyboard', title: 'Keyboard shortcuts at a tap',
        body: 'Press <kbd>?</kbd> (or <kbd>F1</kbd>) to toggle the full shortcut list — or open it from the new <b>Help (?)</b> menu in the top bar.' }
    ]
  };

  // Each step spotlights one real control (by selector) with a plain-language
  // blurb. `sel: null` renders a centred card (the welcome / sign-off screens).
  // `place` hints where the card sits relative to the anchor; it auto-flips if
  // that would run off-screen. Anchors that happen to be hidden fall back to a
  // centred card, so the tour never breaks on a narrow / mid-load layout.
  const STEPS = [
    {
      sel: null, icon: 'tour',
      title: 'Welcome to FieldMark',
      body: 'Your offline PDF viewer for plans and drawings — view, measure, redline and sign, all on this device with nothing sent to the cloud. This quick tour points out the essentials. It takes about a minute.'
    },
    {
      sel: '#btn-open', icon: 'folder-open', place: 'bottom',
      title: 'Open a drawing',
      body: 'Start here to open a PDF — or just drag a <b>.pdf</b> straight onto the window. Recent files reopen fast.'
    },
    {
      sel: '#btn-fit-width', icon: 'fit-width', place: 'bottom',
      title: 'Zoom, fit &amp; rotate',
      body: 'Zoom in and out, fit the sheet to the window, drag a box to zoom into detail, and rotate the view. Tip: hold <kbd>Ctrl</kbd> and scroll to zoom right where your pointer is.'
    },
    {
      sel: '#btn-select', icon: 'cursor', place: 'right',
      title: 'Select &amp; edit anything',
      body: 'The resting tool. Click any markup, measurement or stamp to move, resize, nudge with the arrow keys, or delete it.'
    },
    {
      sel: '#btn-sign', icon: 'signature', place: 'right',
      title: 'Sign, initial &amp; date',
      body: 'Drop a saved signature or initials anywhere on the page, or stamp today’s date. Draw a signature once and reuse it — it stays on this device.'
    },
    {
      sel: '#btn-measure', icon: 'measure', place: 'right',
      title: 'Measure &amp; take off',
      body: 'Set the drawing’s scale once, then measure lengths, perimeters, areas, angles and counts — with snapping and running totals for quantity take-offs.'
    },
    {
      sel: '#btn-markup', icon: 'pencil', place: 'right',
      title: 'Redline &amp; mark up',
      body: 'Arrows, boxes, clouds, freehand, text and callouts, plus highlight / underline / strikeout on real PDF text. Single keys arm each tool — press <kbd>B</kbd> for a box, <kbd>A</kbd> for an arrow.'
    },
    {
      sel: '#btn-document', icon: 'document', place: 'right',
      title: 'Organize &amp; compare',
      body: 'Reorder, rotate or delete pages, add page numbers and stamps, apply a digital signature, and compare or overlay two documents side by side.'
    },
    {
      sel: '#btn-save', icon: 'save', place: 'bottom',
      title: 'Save your work',
      body: 'Save writes your markups, measurements and signatures back into the PDF. Use <b>Save As…</b> to keep the original untouched.'
    },
    {
      sel: '#btn-help', icon: 'tour', place: 'bottom',
      title: 'You’re all set!',
      body: 'That’s the whole toolkit. Open this Help menu any time to replay the tour, and press <kbd>?</kbd> to pop the full list of keyboard shortcuts. Happy marking up!'
    }
  ];

  let idx = 0;
  let active = false;
  let root = null; // { host, backdrop, spot, card } lazily built once
  const relayout = () => { if (active) render(); };

  function q(sel) { return document.querySelector(sel); }

  function isMac() {
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  }

  // Render ⌘ on macOS wherever a blurb writes the literal "Ctrl".
  function localizeMods(html) {
    return isMac() ? html.replace(/<kbd>Ctrl<\/kbd>/g, '<kbd>⌘</kbd>') : html;
  }

  function build() {
    if (root) return root;
    const host = document.createElement('div');
    host.id = 'tour-root';
    host.className = 'hidden';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Welcome tour');
    host.innerHTML = [
      '<div class="tour-backdrop"></div>',
      '<div class="tour-spot" aria-hidden="true"></div>',
      '<div class="tour-card" role="document">',
      '  <button class="tour-x" type="button" aria-label="Close tour" title="Close">' + App.icon('close') + '</button>',
      '  <div class="tour-emoji" aria-hidden="true"></div>',
      '  <h2 class="tour-title"></h2>',
      '  <p class="tour-body"></p>',
      '  <div class="tour-foot">',
      '    <div class="tour-dots" aria-hidden="true"></div>',
      '    <div class="tour-btns">',
      '      <button class="tour-skip link-btn" type="button">Skip</button>',
      '      <button class="tour-back tb-btn" type="button">Back</button>',
      '      <button class="tour-next tb-btn primary" type="button">Next</button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(host);

    host.querySelector('.tour-x').addEventListener('click', () => finish(false));
    host.querySelector('.tour-skip').addEventListener('click', () => finish(false));
    host.querySelector('.tour-back').addEventListener('click', () => go(idx - 1));
    host.querySelector('.tour-next').addEventListener('click', () => {
      if (idx >= STEPS.length - 1) finish(true); else go(idx + 1);
    });
    // Clicking the dim area outside the card advances; the highlighted control
    // stays visible but the tour owns the interaction until it's dismissed.
    host.querySelector('.tour-backdrop').addEventListener('click', () => {
      if (idx >= STEPS.length - 1) finish(true); else go(idx + 1);
    });

    root = {
      host,
      backdrop: host.querySelector('.tour-backdrop'),
      spot: host.querySelector('.tour-spot'),
      card: host.querySelector('.tour-card'),
      emoji: host.querySelector('.tour-emoji'),
      title: host.querySelector('.tour-title'),
      body: host.querySelector('.tour-body'),
      dots: host.querySelector('.tour-dots'),
      back: host.querySelector('.tour-back'),
      next: host.querySelector('.tour-next')
    };
    return root;
  }

  // Place the card near the anchor rect, preferring `place`, flipping / clamping
  // to stay on screen. With no rect, centre it.
  function placeCard(rect, place) {
    const card = root.card;
    card.classList.remove('centered');
    // Measure the card after content is set.
    const cw = card.offsetWidth || 340;
    const ch = card.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 12; // gap from the anchor / viewport edge

    if (!rect) {
      card.classList.add('centered');
      card.style.left = Math.round((vw - cw) / 2) + 'px';
      card.style.top = Math.round((vh - ch) / 2) + 'px';
      return;
    }

    let top, left;
    const order = place === 'right'
      ? ['right', 'bottom', 'left', 'top']
      : ['bottom', 'right', 'top', 'left'];
    const fits = (p) => {
      if (p === 'bottom') return rect.bottom + M + ch <= vh;
      if (p === 'top') return rect.top - M - ch >= 0;
      if (p === 'right') return rect.right + M + cw <= vw;
      if (p === 'left') return rect.left - M - cw >= 0;
      return false;
    };
    const chosen = order.find(fits) || order[0];
    if (chosen === 'bottom' || chosen === 'top') {
      top = chosen === 'bottom' ? rect.bottom + M : rect.top - M - ch;
      left = rect.left + rect.width / 2 - cw / 2;
    } else {
      left = chosen === 'right' ? rect.right + M : rect.left - M - cw;
      top = rect.top + rect.height / 2 - ch / 2;
    }
    left = Math.max(M, Math.min(left, vw - cw - M));
    top = Math.max(M, Math.min(top, vh - ch - M));
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function visibleRect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;            // hidden / collapsed
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null;
    return r;
  }

  function render() {
    build();
    const step = STEPS[idx];
    // Each step shows the icon of the control it is pointing at, so the card and
    // the spotlit button read as the same thing.
    root.emoji.innerHTML = step.icon ? App.icon(step.icon, 'ico-lg') : '';
    root.emoji.classList.toggle('hidden', !step.icon);
    root.title.innerHTML = step.title;
    root.body.innerHTML = localizeMods(step.body);

    // Progress dots.
    root.dots.innerHTML = '';
    STEPS.forEach((_, i) => {
      const d = document.createElement('span');
      d.className = 'tour-dot' + (i === idx ? ' on' : '');
      root.dots.appendChild(d);
    });

    root.back.classList.toggle('hidden', idx === 0);
    root.next.textContent = idx >= STEPS.length - 1 ? 'Done' : 'Next';

    const anchor = step.sel ? q(step.sel) : null;
    const rect = visibleRect(anchor);
    if (rect) {
      const pad = 6;
      const s = root.spot.style;
      s.left = (rect.left - pad) + 'px';
      s.top = (rect.top - pad) + 'px';
      s.width = (rect.width + pad * 2) + 'px';
      s.height = (rect.height + pad * 2) + 'px';
      root.spot.classList.remove('hidden');
      root.backdrop.classList.add('hidden');   // the spotlight's ring dims the rest
    } else {
      root.spot.classList.add('hidden');
      root.backdrop.classList.remove('hidden'); // no anchor → plain full dim
    }
    placeCard(rect, step.place);
  }

  function go(n) {
    idx = Math.max(0, Math.min(n, STEPS.length - 1));
    render();
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (idx >= STEPS.length - 1) finish(true); else go(idx + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation();
      go(idx - 1);
    }
  }

  // ---------- What's new (returning users) ----------
  function wn() { return App.$('#whatsnew-modal'); }

  function renderWhatsNew() {
    const t = App.$('#wn-title'); if (t) t.textContent = NOTES.heading;
    const sub = App.$('#wn-sub'); if (sub) sub.textContent = NOTES.sub || '';
    const list = App.$('#wn-list');
    if (!list) return;
    list.innerHTML = '';
    NOTES.items.forEach((it) => {
      const li = document.createElement('li');
      li.className = 'wn-item';
      const em = document.createElement('span');
      em.className = 'wn-emoji'; em.setAttribute('aria-hidden', 'true');
      em.innerHTML = App.icon(it.icon || 'check');
      const txt = document.createElement('div');
      txt.className = 'wn-text';
      const h = document.createElement('div');
      h.className = 'wn-item-title'; h.textContent = it.title;
      const p = document.createElement('div');
      p.className = 'wn-item-body'; p.innerHTML = localizeMods(it.body);
      txt.appendChild(h); txt.appendChild(p);
      li.appendChild(em); li.appendChild(txt);
      list.appendChild(li);
    });
  }

  function openWhatsNew() {
    const m = wn(); if (!m) return;
    renderWhatsNew();
    m.classList.remove('hidden');
    // Acknowledge on open: a returning user only needs to see each rev once,
    // however they dismiss it.
    try { if (App.Prefs) App.Prefs.set(PREF_NOTES_REV, NOTES.rev); } catch (_) { /* quota */ }
    const ok = App.$('#wn-ok'); if (ok) ok.focus();
  }
  function closeWhatsNew() { const m = wn(); if (m) m.classList.add('hidden'); }

  function setupWhatsNew() {
    const close = () => closeWhatsNew();
    const x = App.$('#wn-close'); if (x) x.addEventListener('click', close);
    const ok = App.$('#wn-ok'); if (ok) ok.addEventListener('click', close);
    const t = App.$('#wn-tour'); if (t) t.addEventListener('click', () => { closeWhatsNew(); Tour.start(); });
  }

  // Pure policy: given whether this looks like a fresh install, whether the tour
  // was ever seen, and the last acknowledged notes rev, decide what (if anything)
  // to auto-show. Exposed for tests. Returns 'tour' | 'whatsnew' | 'none'.
  function decide(state) {
    const s = state || {};
    if (s.freshInstall && !s.seenWelcome) return 'tour';
    if (NOTES && NOTES.rev > ((s.ackRev | 0))) return 'whatsnew';
    return 'none';
  }

  const Tour = {
    init() { setupWhatsNew(); /* the tour overlay itself is built lazily on start */ },

    // Open the tour from the beginning (Help menu, first run, or What's-New).
    start() {
      closeWhatsNew();
      build();
      idx = 0;
      active = true;
      root.host.classList.remove('hidden');
      document.body.classList.add('tour-open');
      // Capture-phase key handling so the tour's keys win over app.js shortcuts.
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', relayout);
      window.addEventListener('scroll', relayout, true);
      render();
      if (root.next) root.next.focus();
    },

    // `complete` true when the user reached the end (vs. skipped) — either way we
    // never auto-show it again.
    finish(complete) { finish(complete); },

    isActive() { return active; },

    // What's-new (returning users after an update).
    showWhatsNew() { openWhatsNew(); },
    closeWhatsNew() { closeWhatsNew(); },
    isWhatsNewOpen() { const m = wn(); return !!m && !m.classList.contains('hidden'); },

    // Exposed for tests: the pure first-run policy and the current notes rev.
    decideFirstRun(state) { return decide(state); },
    notesRev() { return NOTES.rev; },

    // Called once at the end of boot. `freshInstall` is the empty-prefs snapshot
    // taken before any pref was written this session. Auto-shows the tour (fresh
    // install) or the What's-new card (returning user with unseen notes); records
    // the matching pref so neither recurs. Suppressed under the smoke harness so
    // its overlay can't intercept the other SMOKE_* scenarios.
    maybeAutoStart(freshInstall) {
      if (window.api && window.api.isSmokeTest) return 'suppressed';
      if (!App.Prefs) return 'none';
      const seenWelcome = App.Prefs.get(PREF_SEEN, false);
      const ackRev = App.Prefs.get(PREF_NOTES_REV, 0);
      const d = decide({ freshInstall: !!freshInstall, seenWelcome, ackRev });
      if (d === 'tour') {
        // A brand-new user sees everything in the tour, so pre-acknowledge the
        // current notes — no redundant "what's new" for the version they install.
        try { App.Prefs.set(PREF_NOTES_REV, NOTES.rev); } catch (_) { /* quota */ }
        setTimeout(() => { if (!active) Tour.start(); }, 700);   // let anchors settle
      } else if (d === 'whatsnew') {
        // An existing user updating in: never auto-nag the full tour again.
        if (!seenWelcome) { try { App.Prefs.set(PREF_SEEN, true); } catch (_) { /* quota */ } }
        setTimeout(() => { openWhatsNew(); }, 700);
      }
      return d;
    }
  };

  function finish(complete) {
    if (!active) return;
    active = false;
    if (root) {
      root.host.classList.add('hidden');
      root.spot.classList.add('hidden');
    }
    document.body.classList.remove('tour-open');
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', relayout);
    window.removeEventListener('scroll', relayout, true);
    try { if (App.Prefs) App.Prefs.set(PREF_SEEN, true); } catch (_) { /* quota */ }
    if (complete && App.toast) App.toast('You can replay this tour any time from Help (?)', 'success', 3000);
  }

  App.Tour = Tour;
})();
