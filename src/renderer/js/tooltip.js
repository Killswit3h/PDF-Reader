'use strict';

/*
 * In-app tooltips.
 *
 * Every control in this app named itself with a native `title` attribute — 121
 * of them in index.html and 21 more assigned at runtime. The OS tooltip that
 * draws them is a poor fit for a tool like this:
 *
 *   - it appears after roughly a second, which is too slow to browse a toolbar
 *     of icon-only buttons;
 *   - the OS positions it, not the control. In the screenshot that prompted
 *     this work, the shelf's row tooltip was drawn at the top-left of the
 *     window, on top of the Open button, ~900px from the row it described;
 *   - it cannot be styled, so it never matches the app in either theme;
 *   - and the Android WebView does not draw it at all, so on a third of the
 *     platforms this app ships to, those 142 names were simply invisible.
 *
 * So the names move out of `title` and into `data-tip`, and one fixed-position
 * element draws them.
 *
 * Renderer-only (Tier A): pure DOM, no new dependency, no window.api surface —
 * it ships to Windows, macOS and Android from the one file.
 *
 * Two design notes worth keeping:
 *
 *   1. The migration is done by a MutationObserver on the `title` attribute,
 *      not by a sweep. A sweep would work once, but 21 places in the app assign
 *      `el.title = …` at runtime (the bookmark toggle relabels itself on every
 *      page change, the rail toggle on every collapse, and so on). Observing
 *      the attribute means every one of those call sites keeps working, unedited
 *      and unaware.
 *
 *   2. The tooltip node lives on <body> and is `position: fixed`. A CSS-only
 *      ::after tooltip would be clipped by any ancestor with overflow:hidden —
 *      #markup-props, #bookmark-menu and the mobile #toolbar all scroll — and
 *      could not be flipped to stay inside the window.
 */
(function () {
  const T = {};

  const DELAY_HOVER = 450;   // long enough not to fire while sweeping past
  const MARGIN = 8;          // keep-inside-the-window inset
  const GAP = 6;             // control-to-tooltip clearance

  let tip = null;
  let anchor = null;         // element the visible tooltip belongs to
  let timer = 0;
  let canHover = false;

  /* ---------------- name migration ---------------- */

  // Elements that must keep their native title. <title> inside an SVG is a
  // child element rather than this attribute, but an author could still put the
  // attribute on an <svg>, and an iframe/embed title is an accessibility name we
  // have no business moving.
  function skip(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.hasAttribute('data-no-tip')) return true;
    const tag = el.tagName;
    return tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT' || tag === 'svg';
  }

  // Does the element already say its own name without the title?
  function hasOwnName(el) {
    if (el.getAttribute('aria-label')) return true;
    if (el.getAttribute('aria-labelledby')) return true;
    return !!(el.textContent && el.textContent.trim());
  }

  // title -> data-tip, preserving the accessible name.
  function migrate(el) {
    if (skip(el)) return;
    const t = el.getAttribute('title');
    if (t == null) return;
    const text = t.trim();
    el.removeAttribute('title');            // no native tooltip, ever (FR-20)
    if (!text) { el.removeAttribute('data-tip'); return; }
    el.setAttribute('data-tip', text);
    // The title WAS the accessible name for icon-only buttons; removing it
    // without a replacement would strip them for screen readers.
    if (!hasOwnName(el)) el.setAttribute('aria-label', text);
    // A visible tooltip whose text just changed should show the new text.
    if (el === anchor) draw(el);
  }

  function migrateTree(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.hasAttribute && root.hasAttribute('title')) migrate(root);
    const kids = root.querySelectorAll ? root.querySelectorAll('[title]') : [];
    for (const el of kids) migrate(el);
  }

  /* ---------------- show / hide ---------------- */

  function ensureNode() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'tooltip';
    tip.className = 'hidden';
    // Decorative: the control it describes already carries the same string as
    // its accessible name, so announcing it twice would only be noise.
    tip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tip);
    return tip;
  }

  // Place below the control, flipped above when that would leave the window,
  // and clamped horizontally so it can never be painted off-screen.
  function draw(el) {
    const text = el.getAttribute('data-tip');
    if (!text) return hide();
    const node = ensureNode();
    node.textContent = text;               // never innerHTML: this string can
                                           // come out of a user-supplied PDF
    node.classList.remove('hidden');
    node.style.left = '0px';               // measure unclamped first
    node.style.top = '0px';

    const r = el.getBoundingClientRect();
    const t = node.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    let top = r.bottom + GAP;
    if (top + t.height > vh - MARGIN) {
      const above = r.top - GAP - t.height;
      if (above >= MARGIN) top = above;
      else top = Math.max(MARGIN, vh - MARGIN - t.height);
    }
    let left = r.left + (r.width - t.width) / 2;
    left = Math.max(MARGIN, Math.min(left, vw - MARGIN - t.width));

    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
    anchor = el;
  }

  function show(el) {
    if (!el || !el.getAttribute || !el.getAttribute('data-tip')) return;
    if (el.disabled && el.tagName === 'INPUT') return;
    clearTimeout(timer);
    draw(el);
  }

  function hide() {
    clearTimeout(timer);
    anchor = null;
    if (tip) tip.classList.add('hidden');
  }

  function target(node) {
    if (!node || !node.closest) return null;
    return node.closest('[data-tip]');
  }

  /* ---------------- wiring ---------------- */

  T.show = show;
  T.hide = hide;
  T.refresh = function (el) { if (el && el === anchor) draw(el); };

  T.init = function () {
    ensureNode();
    migrateTree(document.body);

    // Runtime `el.title = …` assignments, and controls added later (the
    // measurement list, organizer thumbnails, the "..." sheet), migrate here.
    if (typeof MutationObserver === 'function') {
      new MutationObserver((records) => {
        for (const rec of records) {
          if (rec.type === 'attributes') migrate(rec.target);
          else for (const n of rec.addedNodes) migrateTree(n);
        }
      }).observe(document.body, {
        subtree: true, childList: true,
        attributes: true, attributeFilter: ['title']
      });
    }

    // Hover is gated on a pointer that actually hovers. On touch there is no
    // hover state to read, and nothing here calls preventDefault(), so taps are
    // untouched either way.
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    canHover = mq.matches;
    if (mq.addEventListener) mq.addEventListener('change', (e) => { canHover = e.matches; hide(); });
    else if (mq.addListener) mq.addListener((e) => { canHover = e.matches; hide(); });

    document.addEventListener('pointerover', (e) => {
      if (!canHover || e.pointerType === 'touch') return;
      const el = target(e.target);
      if (!el || el === anchor) return;
      clearTimeout(timer);
      timer = setTimeout(() => show(el), DELAY_HOVER);
    }, true);

    document.addEventListener('pointerout', (e) => {
      const el = target(e.target);
      if (!el) return;
      // Moving between a control's own children is not a leave.
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;
      hide();
    }, true);

    // Keyboard focus names the control immediately — there is no "resting the
    // pointer" gesture to wait out.
    document.addEventListener('focusin', (e) => {
      const el = target(e.target);
      if (el) show(el); else hide();
    }, true);
    document.addEventListener('focusout', hide, true);

    // Anything that means "I'm doing something else now" dismisses it. Escape
    // does NOT consume the key: the app's own Escape handling (disarm the tool,
    // cancel a measurement, close a menu) has to keep running.
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('click', hide, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
  };

  App.Tooltip = T;
})();
