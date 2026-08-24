'use strict';

/*
 * Pure tab-order arithmetic for the document tab strip.
 *
 * The renderer keeps its open documents in an array whose ORDER IS the tab
 * order, so every rearrangement — drag-and-drop, the keyboard shortcut, and the
 * right-click "Move to Start/End" items — reduces to moving one id inside a
 * list of ids. That arithmetic lives here, away from the DOM, so the awkward
 * cases (dropping a tab onto the slot it already occupies, an id that vanished
 * mid-drag, clamping at the ends) are unit-testable in Node instead of only
 * reachable by dragging a real window around.
 *
 * Every function returns a NEW array and never mutates its input. A move that
 * changes nothing returns an equal copy, so callers can compare against the
 * original to decide whether a re-render is even needed.
 *
 * Dual export: `require()` in Node returns { TabOrder }, and a <script> tag in
 * the browser assigns App.TabOrder.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  const list = (order) => (Array.isArray(order) ? order.slice() : []);

  // Move `fromId` so it sits immediately before (placeBefore) or after the tab
  // `targetId`. This is the drop half of a drag: the cursor is over `targetId`,
  // and which half of that tab it sits on picks the side.
  //
  // The target index is re-read AFTER the dragged id is pulled out, so callers
  // never compensate for the hole the removal leaves behind — a left-to-right
  // move and a right-to-left move run the identical code path.
  function moveTab(order, fromId, targetId, placeBefore) {
    const next = list(order);
    if (fromId === targetId) return next;
    const from = next.indexOf(fromId);
    if (from === -1 || next.indexOf(targetId) === -1) return next;  // stale id — leave the order alone
    next.splice(from, 1);
    let to = next.indexOf(targetId);
    if (!placeBefore) to += 1;
    next.splice(to, 0, fromId);
    return next;
  }

  // Nudge `id` `delta` slots toward the start (negative) or the end (positive),
  // clamped at both ends — this is the keyboard shortcut, where running off the
  // edge should stop rather than wrap around to the far side of the strip.
  function shiftTab(order, id, delta) {
    const next = list(order);
    const from = next.indexOf(id);
    if (from === -1 || !delta) return next;
    const to = Math.max(0, Math.min(next.length - 1, from + Math.trunc(delta)));
    if (to === from) return next;
    next.splice(from, 1);
    next.splice(to, 0, id);
    return next;
  }

  // Send `id` to the far start ('start') or the far end of the strip.
  function moveTabToEdge(order, id, edge) {
    const next = list(order);
    const from = next.indexOf(id);
    if (from === -1) return next;
    next.splice(from, 1);
    if (edge === 'start') next.unshift(id); else next.push(id);
    return next;
  }

  // True when two orders hold the same ids in the same slots — the cheap "did
  // anything actually move?" check callers use to skip a re-render.
  function sameOrder(a, b) {
    const x = list(a), y = list(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  return { TabOrder: { moveTab, shiftTab, moveTabToEdge, sameOrder } };
});
