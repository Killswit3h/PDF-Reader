'use strict';

/*
 * Markup / annotation engine (Bluebeam-style tools).
 *
 * Model (App.state.annotations) — geometry in scale-1 viewport points, so it
 * renders at `pt * zoom` and exports via viewport.convertToPdfPoint, exactly
 * like placements/measurements:
 *   { id, page, type, pts:[{vx,vy}], style:{stroke,fill,width,opacity,arrow,fontSize}, text }
 * types: line arrow rect ellipse polyline polygon cloud ink text callout highlight
 *        note stamp link redact (+ quad-based texthighlight underline strikeout squiggly)
 * review fields (Markups List columns, src/shared/markup-meta.js):
 *   subject, status, comment, locked, createdAt
 *
 * Interaction:
 *   - A drawing tool active (App.state.mode==='markup')  -> clicks/drag create.
 *   - No tool active (mode null)                         -> click a shape to
 *     select; drag to move; corner handle to resize; Delete to remove.
 * Undo/redo via whole-array snapshots (annotations are small JSON).
 */
(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const TWO_POINT = { line: 1, arrow: 1, rect: 1, ellipse: 1, link: 1, redact: 1 };
  // One click drops these: a sticky note's icon, or a review stamp sized to its
  // text. The eraser is a tool, not a markup type -- it removes what it touches.
  const ONE_CLICK = { note: 1, stamp: 1 };
  const NOTE_SIZE = 22;
  const N_POINT = { polyline: 1, polygon: 1, cloud: 1 };
  // Freehand tools use press-drag-release and paint a live stroke as the pen
  // moves. `highlight` joined `ink` here: it used to be a two-point drag box, but
  // now it's a translucent highlighter you draw by hand (like Apple Notes).
  const FREEHAND = { ink: 1, highlight: 1 };
  const DEF_TEXT_W = 150, DEF_TEXT_H = 44;
  const isTextType = (t) => t === 'text' || t === 'callout';

  // Two default styles, not one. A drawn markup wants to shout (red, 2pt); a
  // text note wants to read like the sheet it sits on — plain black type, no
  // frame, no fill. Keeping them apart (the way Bluebeam keeps per-tool
  // properties) means picking blue for an arrow doesn't turn every later note
  // blue, and the text tool can default to black without recolouring shapes.
  const SHAPE_STYLE = { stroke: '#e5484d', fill: 'none', width: 2, opacity: 1, fontSize: 14, fontFamily: 'Helvetica' };
  const TEXT_STYLE = { stroke: '#000000', fill: 'none', width: 2, opacity: 1, fontSize: 14, fontFamily: 'Helvetica' };
  const styleKey = (kind) => isTextType(kind) ? 'annoTextStyle' : 'annoStyle';

  // Text-box fonts. Limited to the three PDF standard-font families so a saved
  // box renders identically whether we flatten it (save.js embeds the matching
  // StandardFont) or write it as a live FreeText annotation (the `da` name goes
  // into the annotation's DA string). `css` is the on-screen font stack.
  const FONTS = [
    { id: 'Helvetica', css: 'Helvetica, Arial, sans-serif', pdf: 'Helvetica', da: 'Helv' },
    { id: 'Times', css: '"Times New Roman", Times, serif', pdf: 'TimesRoman', da: 'TiRo' },
    { id: 'Courier', css: '"Courier New", Courier, monospace', pdf: 'Courier', da: 'Cour' }
  ];
  function fontById(id) { return FONTS.find((f) => f.id === id) || FONTS[0]; }

  // Apple-Pencil-style "hold to snap straight": while freehand drawing, if the
  // pen stays put for this long the stroke collapses to a clean straight line
  // from its first point to where the pen is resting. STILL_TOL is the jitter
  // radius (scale-1 viewport points) within which the pen counts as "held".
  // Highlighting is a quicker, coarser gesture than inking, so the highlighter
  // snaps sooner (1.5s) than the pen (3s).
  const STRAIGHTEN_HOLD_MS = 3000, HIGHLIGHT_STRAIGHTEN_HOLD_MS = 1500, STILL_TOL = 4;
  const holdMsFor = (tool) => tool === 'highlight' ? HIGHLIGHT_STRAIGHTEN_HOLD_MS : STRAIGHTEN_HOLD_MS;

  // A highlighter lays down a much wider band than a pen so text shows through
  // it. Derived from the shared style width so the width slider still tunes it.
  function highlightWidth(style) { return Math.max(10, ((style && style.width) || 2) * 6); }

  // Freehand strokes (pen + highlighter) are curve-fit for a silky, Shottr-like
  // feel: jitter is simplified away then resampled through a Catmull-Rom spline.
  // The raw pts stay in the model (so drag/move/handles are unchanged) — only the
  // rendered + exported geometry is smoothed, and both share this one function so
  // on-screen == on-page. A 2-point (hold-to-straighten) stroke passes through
  // untouched. K.smoothStroke is exported so save.js reuses the exact same curve.
  const SMOOTH = { eps: 1, samples: 8 };
  function smoothStroke(an) {
    return (an.type === 'ink' || an.type === 'highlight')
      ? App.Geom.smoothStroke(an.pts, SMOOTH) : an.pts;
  }

  const K = {
    stampDef: null,      // stamp chosen in the stamp picker, for the stamp tool
    tool: null,          // current drawing tool or null
    active: null,        // { type, page, pts:[], hover }
    inkDrawing: false
  };

  function ns(t) { return document.createElementNS(SVGNS, t); }
  // Geometry is shared + unit-tested (src/shared/geometry.js).
  const { dist, bbox } = App.Geom;

  /* ---------------- model + undo/redo ---------------- */
  // `kind` is an annotation type (or the armed tool); text/callout read the text
  // defaults, everything else the shape defaults.
  function defaults(kind) {
    const k = styleKey(kind);
    if (App.state[k]) return App.state[k];
    const saved = App.Prefs ? App.Prefs.get(k, null) : null;
    return (App.state[k] = saved || Object.assign({}, isTextType(kind) ? TEXT_STYLE : SHAPE_STYLE));
  }
  // Tool Chest saves and re-applies a tool's style; route it through the same
  // split so a saved text tool lands on the text defaults, not the shape ones.
  K.defaultsFor = (kind) => defaults(kind);
  K.setDefaultsFor = function (kind, style) {
    const k = styleKey(kind);
    App.state[k] = Object.assign({}, style);
    if (App.Prefs) App.Prefs.set(k, App.state[k]);
    return App.state[k];
  };
  // Undo/redo is now unified across all layers (see js/history.js). markup
  // keeps calling snapshot() before each mutation; the stack is shared.
  function snapshot() { App.History.snapshot(); }
  K.undo = function () { App.History.undo(); };
  K.redo = function () { App.History.redo(); };

  /* ---------------- tool lifecycle ---------------- */
  K.startTool = function (type) {
    K.commitActive();
    K.tool = type;
    K.active = null;
    App.setMode('markup');
    const hint = type === 'text' ? 'Click to place a text box, then type. Click away to finish.'
      : type === 'note' ? 'Click to drop a note, then type the comment.'
      : type === 'stamp' ? `Click to place the ${(K.stampDef && K.stampDef.text) || 'stamp'} stamp.`
      : type === 'eraser' ? 'Click or drag over markups to erase them. Locked markups stay.'
      : type === 'link' ? 'Drag a box over the area to link, then enter a page number or web address.'
      : type === 'redact' ? 'Drag a box over what to remove. Document > Apply Redactions removes it for good.'
      : type === 'callout' ? 'Click the target, then where the note goes.'
      : N_POINT[type] ? 'Click points, Enter/double-click to finish.'
      : FREEHAND[type] ? `Press and drag to draw. Hold still ${holdMsFor(type) / 1000}s to snap it straight.`
      : 'Click start then end.';
    App.toast(`Markup: ${App.markupTypeLabel ? App.markupTypeLabel(type).replace(/^eraser$/, 'Eraser') : type}. ${hint}`, 'info', 3500);
    syncPropBar();
  };
  K.isFreehand = (t) => !!FREEHAND[t] || t === 'eraser';
  K.stop = function () {
    if (K.clearHold) K.clearHold();
    K.inkDrawing = false;
    K.commitActive();
    K.tool = null; K.active = null;
    K.repositionAll();
  };
  K.cancelActive = function () { if (K.clearHold) K.clearHold(); K.inkDrawing = false; K.active = null; K.repositionAll(); };

  K.commitActive = function () {
    const a = K.active; K.active = null;
    if (!a) return;
    const need = a.type === 'polygon' || a.type === 'cloud' ? 3 : a.type === 'polyline' ? 2 : 2;
    if (a.pts.length < need) return;
    finalize(a);
  };

  function finalize(a) {
    snapshot();
    App.state.annoSeq = (App.state.annoSeq || 0) + 1;
    const an = {
      id: App.state.annoSeq,
      page: a.page,
      type: a.type,
      pts: a.pts.map((p) => ({ vx: p.vx, vy: p.vy })),
      style: Object.assign({}, defaults(a.type)),
      text: a.type === 'text' || a.type === 'callout' ? (a.text || 'Text') : undefined,
      createdAt: Date.now()
    };
    if (a.type === 'stamp') {
      an.text = a.text;
      an.stampName = a.stampName;
      an.style = Object.assign({}, an.style, { stroke: a.color, fill: 'none', width: 3, opacity: 1 });
    }
    if (a.type === 'note') an.style = Object.assign({}, an.style, { fill: '#ffd400' });
    App.state.annotations.push(an);
    App.state.annoSelectedId = an.id;
    App.$('#btn-save').disabled = false;
    if (an.type === 'text' || an.type === 'callout') {
      // One-shot: dropping a text box disarms the tool and switches to
      // select/move, so the next click grabs THIS box (to reposition it)
      // instead of dropping another one. Disarm before opening the editor —
      // leaving markup mode flips the box's hit area back on so it's draggable.
      K.tool = null;
      App.setMode(null);
      startTextEdit(an);
    } else if (an.type === 'note') {
      K.repositionAll();
      editComment(an, true);
    } else if (an.type === 'link') {
      K.repositionAll();
      editLink(an, true);
    } else {
      K.repositionAll();
    }
    if (App.MarkupPanel) App.MarkupPanel.render();
  }

  // Sticky note: type the comment right after dropping it. Cancelling a brand
  // new note removes it rather than leaving an empty one behind.
  async function editComment(an, fresh) {
    const txt = await App.promptText('Comment', {
      title: an.type === 'note' ? 'Note' : 'Comment', value: an.comment || '', multiline: true,
      placeholder: 'Type the comment (Ctrl+Enter to save)', okLabel: 'Save'
    });
    if (txt == null) { if (fresh && !an.comment) dropFresh(an); return; }
    snapshot();
    an.comment = txt;
    K.repositionAll();
    if (App.MarkupPanel) App.MarkupPanel.render();
  }
  K.editComment = (id) => { const an = annoById(id); if (an) editComment(an, false); };

  // Hyperlink target: a page number jumps inside the document, anything else
  // must be an http(s) or mailto address (App.parseLinkTarget refuses the rest).
  async function editLink(an, fresh) {
    const cur = an.link ? (an.link.url || String(an.link.page || '')) : '';
    const txt = await App.promptText('Page number in this document, or a web address (https://...)', {
      title: 'Hyperlink', value: cur, placeholder: 'e.g. 12  or  https://www.fdot.gov', okLabel: 'Link'
    });
    if (txt == null) { if (fresh && !an.link) dropFresh(an); return; }
    const target = App.parseLinkTarget(txt, App.state.numPages);
    if (!target) {
      App.toast('Not a page in this document or a web address (http, https or mailto only).', 'error', 5000);
      if (fresh && !an.link) dropFresh(an);
      return;
    }
    snapshot();
    an.link = target;
    K.repositionAll();
    if (App.MarkupPanel) App.MarkupPanel.render();
  }
  K.editLink = (id) => { const an = annoById(id); if (an) editLink(an, false); };

  // Follow a hyperlink markup: jump to its page, or hand a vetted URL to the OS.
  K.followLink = function (an) {
    const l = an && an.link;
    if (!l) return false;
    if (l.page) { App.Viewer.goToPage(l.page); return true; }
    const url = App.safeLinkUrl(l.url);
    if (!url) { App.toast('This link is not a web address and was not opened.', 'error'); return false; }
    if (window.api && window.api.openExternal) window.api.openExternal(url);
    return true;
  };

  // Undo the creation of a markup the user backed out of (no history entry).
  function dropFresh(an) {
    App.state.annotations = App.state.annotations.filter((x) => x.id !== an.id);
    if (App.state.annoSelectedId === an.id) App.state.annoSelectedId = null;
    if (App.History.discardLast) App.History.discardLast();
    K.repositionAll();
    if (App.MarkupPanel) App.MarkupPanel.render();
  }

  /* ---------------- interaction (from app.js delegation) ---------------- */
  function ptFromEvent(layer, e) {
    // Map through the shared inverse-rotation helper so clicks land under the pen
    // even when the page is rotated 90/180/270° (the layer is rigid-rotated by
    // CSS; a raw getBoundingClientRect offset only works at 0°).
    let p = App.Viewer.pointFromEvent(layer, e);
    // ortho on Shift, relative to the last placed point
    if (K.active && K.active.pts.length && e.shiftKey) {
      p = App.Geom.ortho(K.active.pts[K.active.pts.length - 1], p);
    } else if (App.Grid && App.Grid.snapOn() && !FREEHAND[K.tool] && K.tool !== 'eraser') {
      p = App.snapToGrid(p, App.Grid.spacing());
    }
    return p;
  }

  K.handleClick = function (page, layer, e) {
    if (!K.tool || FREEHAND[K.tool]) return;
    const p = ptFromEvent(layer, e);

    if (K.tool === 'eraser') { eraseAt(page, p); return; }
    if (K.tool === 'note') {
      finalize({ type: 'note', page, pts: [{ vx: p.vx - NOTE_SIZE / 2, vy: p.vy - NOTE_SIZE / 2 }] });
      return;
    }
    if (K.tool === 'stamp') {
      const def = K.stampDef || App.stampById('approved');
      const lines = App.stampLines(def, new Date());
      const sz = App.stampSize(lines, 18);
      finalize({ type: 'stamp', page, text: lines.join('\n'), color: def.color, stampName: def.name,
        pts: [{ vx: p.vx - sz.w / 2, vy: p.vy - sz.h / 2 }, { vx: p.vx + sz.w / 2, vy: p.vy + sz.h / 2 }] });
      return;
    }

    // Text: one click drops a default-size editable box.
    if (K.tool === 'text') {
      finalize({ type: 'text', page, text: 'Text',
        pts: [{ vx: p.vx, vy: p.vy }, { vx: p.vx + DEF_TEXT_W, vy: p.vy + DEF_TEXT_H }] });
      return;
    }
    // Callout: click 1 = arrow tip, click 2 = text-box location.
    if (K.tool === 'callout') {
      if (!K.active) K.active = { type: 'callout', page, pts: [] };
      if (K.active.page !== page) return;
      K.active.pts.push(p);
      if (K.active.pts.length === 2) {
        const tip = K.active.pts[0], box = K.active.pts[1];
        K.active = null;
        finalize({ type: 'callout', page, text: 'Text',
          pts: [{ vx: box.vx, vy: box.vy }, { vx: box.vx + DEF_TEXT_W, vy: box.vy + DEF_TEXT_H }, { vx: tip.vx, vy: tip.vy }] });
      } else { K.repositionAll(); }
      return;
    }

    if (!K.active) K.active = { type: K.tool, page, pts: [] };
    if (K.active.page !== page) return;

    if (TWO_POINT[K.tool]) {
      K.active.pts.push(p);
      if (K.active.pts.length === 2) { const a = K.active; K.active = null; finalize(a); }
    } else { // N-point
      const last = K.active.pts[K.active.pts.length - 1];
      if (last && dist(last, p) < 1.5) { K.repositionAll(); return; } // dedupe dblclick
      K.active.pts.push(p);
    }
    K.repositionAll();
  };

  K.handleMove = function (page, layer, e) {
    if (K.inkDrawing) { inkMove(page, layer, e); return; }
    if (!K.active || K.active.page !== page || !K.active.pts.length) return;
    K.active.hover = ptFromEvent(layer, e);
    K.scheduleReposition(page);
  };

  K.finishDrawing = function () { K.commitActive(); K.repositionAll(); };

  // Freehand (ink + highlight) use press-drag-release, painting a live stroke.
  let _holdTimer = 0;
  function clearHold() { if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = 0; } }
  K.clearHold = clearHold;
  // Arm the "held still" countdown. Every meaningful move re-arms it, so it only
  // fires once the pen has rested (within STILL_TOL) for STRAIGHTEN_HOLD_MS.
  function armHold(page) {
    clearHold();
    const holdMs = holdMsFor(K.active ? K.active.type : K.tool);
    _holdTimer = setTimeout(() => { _holdTimer = 0; straightenActive(page); }, holdMs);
  }
  // Collapse the freehand scribble to one clean straight segment: first point →
  // where the pen is now resting. Locks `straight` so the rest of the drag just
  // rubber-bands that endpoint (it behaves like a line tool until you lift).
  function straightenActive(page) {
    const a = K.active;
    if (!a || a.straight || a.pts.length < 2) return;
    const start = a.pts[0], end = a.pts[a.pts.length - 1];
    if (Math.hypot(end.vx - start.vx, end.vy - start.vy) < STILL_TOL) return; // too tiny to bother
    a.pts = [{ vx: start.vx, vy: start.vy }, { vx: end.vx, vy: end.vy }];
    a.straight = true;
    App.toast('Snapped straight — drag to adjust, release to place.', 'info', 1800);
    K.repositionAll(page);
  }

  // Eraser: everything the pointer touches while pressed is removed, in one undo
  // step. Locked markups are skipped -- that is what the lock is for.
  let _erasing = null;
  function eraseAt(page, p) {
    const tol = 6 / (App.state.zoom || 1);
    const hit = App.topMarkupAt(App.state.annotations.filter((a) => !a.locked), page, p, tol);
    if (!hit) return false;
    if (!_erasing || !_erasing.snap) { snapshot(); if (_erasing) _erasing.snap = true; }
    App.state.annotations = App.state.annotations.filter((a) => a.id !== hit.id);
    if (App.state.annoSelectedId === hit.id) App.state.annoSelectedId = null;
    App.$('#btn-save').disabled = false;
    K.repositionAll(page);
    if (App.MarkupPanel) App.MarkupPanel.render();
    return true;
  }
  K._eraseAt = eraseAt;

  K.inkStart = function (page, layer, e) {
    if (K.tool === 'eraser') {
      _erasing = { page, layer, snap: false };
      eraseAt(page, App.Viewer.pointFromEvent(layer, e));
      K.inkDrawing = true;
      return;
    }
    if (!FREEHAND[K.tool]) return;
    K.inkDrawing = true;
    const p = ptFromEvent(layer, e);
    K.active = { type: K.tool, page, pts: [p], holdAnchor: p, straight: false };
    armHold(page);
  };
  function inkMove(page, layer, e) {
    if (_erasing) { if (_erasing.page === page) eraseAt(page, App.Viewer.pointFromEvent(layer, e)); return; }
    if (!K.active || K.active.page !== page) return;
    const p = ptFromEvent(layer, e);
    if (K.active.straight) {
      // Already snapped: keep two points and rubber-band the end.
      K.active.pts = [K.active.pts[0], p];
      K.scheduleReposition(page);
      return;
    }
    const last = K.active.pts[K.active.pts.length - 1];
    if (!last || Math.hypot(p.vx - last.vx, p.vy - last.vy) > 1.2) K.active.pts.push(p);
    // Re-arm the straighten countdown only when the pen has actually travelled;
    // small jitter within STILL_TOL counts as "holding still" so the timer runs.
    const anchor = K.active.holdAnchor;
    if (!anchor || Math.hypot(p.vx - anchor.vx, p.vy - anchor.vy) > STILL_TOL) {
      K.active.holdAnchor = p;
      armHold(page);
    }
    K.scheduleReposition(page);
  }
  K.inkEnd = function () {
    if (!K.inkDrawing) return;
    K.inkDrawing = false;
    if (_erasing) { _erasing = null; return; }
    clearHold();
    const a = K.active; K.active = null;
    // finalize() rebuilds the stored annotation from pts alone, so the transient
    // holdAnchor/straight fields never leak into App.state.annotations.
    if (a && a.pts.length >= 2) finalize(a);
    else K.repositionAll();
  };

  /* ---------------- selection / move / resize ---------------- */
  function annoById(id) { return App.state.annotations.find((a) => a.id === id); }
  K.select = function (id) { App.state.annoSelectedId = id; K.repositionAll(); if (App.MarkupPanel) App.MarkupPanel.render(); syncPropBar(); App.refreshChrome && App.refreshChrome(); };
  K.deselect = function () { if (App.state.annoSelectedId != null) { App.state.annoSelectedId = null; K.repositionAll(); App.refreshChrome && App.refreshChrome(); } };

  // ---------- Copy / duplicate ----------
  K.getSelected = function () { return annoById(App.state.annoSelectedId) || null; };
  // Create a new annotation from a (cloned) data object, offset by (dx,dy)
  // viewport points. Returns the new id.
  K.paste = function (data, dx, dy) {
    if (!data) return null;
    snapshot();
    const an = JSON.parse(JSON.stringify(data));
    App.state.annoSeq = (App.state.annoSeq || 0) + 1;
    an.id = App.state.annoSeq;
    an.pts = an.pts.map((p) => ({ vx: p.vx + (dx || 0), vy: p.vy + (dy || 0) }));
    App.state.annotations.push(an);
    App.$('#btn-save').disabled = false;
    K.select(an.id);
    return an.id;
  };
  // Keyboard nudge (arrow keys) for the selected annotation.
  K.nudge = function (dx, dy) {
    const an = annoById(App.state.annoSelectedId);
    if (!an || an.locked) return;
    snapshot();
    if (an.quads) an.quads = an.quads.map((q) => ({ x: q.x + dx, y: q.y + dy, w: q.w, h: q.h }));
    else an.pts = an.pts.map((pt) => ({ vx: pt.vx + dx, vy: pt.vy + dy }));
    K.repositionAll();
  };

  K.remove = function (id) {
    const target = annoById(id);
    if (target && target.locked) { App.toast('This markup is locked. Unlock it in the Markups list first.', 'info', 3500); return; }
    snapshot();
    App.state.annotations = App.state.annotations.filter((a) => a.id !== id);
    if (App.state.annoSelectedId === id) App.state.annoSelectedId = null;
    K.repositionAll();
  };

  function startDrag(an, e) {
    e.preventDefault(); e.stopPropagation();
    // Double-click a hyperlink to follow it (single click still selects it).
    if (an.type === 'link' || an.type === 'note') {
      const now = Date.now();
      if (_lastClick.id === an.id && now - _lastClick.t < 350) {
        _lastClick = { id: null, t: 0 };
        if (an.type === 'link') K.followLink(an); else editComment(an, false);
        return;
      }
      _lastClick = { id: an.id, t: now };
    }
    K.select(an.id);
    if (an.locked) return;
    const z = App.state.zoom, sx = e.clientX, sy = e.clientY;
    const orig = an.pts.map((p) => ({ vx: p.vx, vy: p.vy }));
    snapshot();
    function move(ev) {
      // Screen motion → unrotated page motion. Everything below works in page
      // space, so the axis lock and the snap search stay orientation-agnostic.
      const d = App.Viewer.deltaFromEvent(ev.clientX - sx, ev.clientY - sy);
      let dx = d.dx, dy = d.dy;
      // Shift → orthogonal (lock to the dominant axis).
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      // Snap the anchor point onto a nearby vertex of another shape.
      if (snapEnabled()) {
        const cand = [];
        App.state.annotations.forEach((o) => { if (o.id !== an.id && o.page === an.page && o.pts) cand.push(...o.pts); });
        const moved0 = { vx: orig[0].vx + dx, vy: orig[0].vy + dy };
        const s = App.Geom.nearestVertex(cand, moved0, 8 / z);
        if (s) { dx += s.vx - moved0.vx; dy += s.vy - moved0.vy; }
      }
      an.pts = orig.map((p) => ({ vx: p.vx + dx, vy: p.vy + dy }));
      K.scheduleReposition(an.page);
    }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); K.repositionAll(); }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }

  function snapEnabled() { return App.Prefs ? App.Prefs.get('snap', true) : true; }

  let _lastClick = { id: null, t: 0 };

  function startResize(an, e) {
    e.preventDefault(); e.stopPropagation();
    K.select(an.id);
    if (an.locked) return;
    const sx = e.clientX, sy = e.clientY;
    const b = bbox(an.pts);
    const orig = an.pts.map((p) => ({ vx: p.vx, vy: p.vy }));
    snapshot();
    function move(ev) {
      // The handle sits at the bbox corner in page space, so the drag that pulls
      // it has to be measured in page space too — else a rotated page grows the
      // shape along the wrong edge.
      const { dx, dy } = App.Viewer.deltaFromEvent(ev.clientX - sx, ev.clientY - sy);
      const sw = b.w ? (b.w + dx) / b.w : 1;
      const sh = b.h ? (b.h + dy) / b.h : 1;
      an.pts = orig.map((p) => ({ vx: b.x + (p.vx - b.x) * sw, vy: b.y + (p.vy - b.y) * sh }));
      K.scheduleReposition(an.page);
    }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); K.repositionAll(); }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }

  /* ---------------- rendering ---------------- */
  // A drag/draw fires `pointermove` faster than the display refreshes (120–240 Hz
  // trackpads/pens), and each rebuild retears the SVG for every page. Coalesce
  // the hot-path calls to one rebuild per animation frame and, since a single
  // gesture only touches one page, let callers restrict the rebuild to that page
  // so a 200-markup document doesn't re-render all pages on every pointer tick.
  let _repoRAF = 0, _repoPage;
  K.scheduleReposition = function (onlyPage) {
    if (_repoRAF) return; // a frame is already queued; it renders the latest state
    _repoPage = onlyPage;
    _repoRAF = requestAnimationFrame(() => { const p = _repoPage; _repoRAF = 0; _repoPage = undefined; doReposition(p); });
  };
  // Any direct (non-scheduled) rebuild also cancels a pending frame and renders in
  // full, so gesture-end commits always land the exact, all-pages-consistent state.
  K.repositionAll = function (onlyPage) {
    if (_repoRAF) { cancelAnimationFrame(_repoRAF); _repoRAF = 0; _repoPage = undefined; }
    doReposition(onlyPage);
  };
  function doReposition(onlyPage) {
    const z = App.state.zoom;
    if (App.Grid) App.Grid.refresh();
    (App.state.pageEls || []).forEach((pe, i) => {
      if (!pe) return;
      const page = i + 1;
      if (onlyPage != null && page !== onlyPage) return;
      let svg = pe.holder.querySelector('.markup-svg');
      if (svg) svg.remove();
      svg = ns('svg');
      svg.setAttribute('class', 'markup-svg');
      svg.setAttribute('width', pe.holder.style.width);
      svg.setAttribute('height', pe.holder.style.height);
      pe.holder.appendChild(svg);
      App.state.annotations.forEach((an) => { if (an.page === page) drawAnno(svg, an, z, an.id === App.state.annoSelectedId); });
      if (K.active && K.active.page === page) drawPreview(svg, K.active, z);
    });
  };

  function pts2str(pts, z) { return pts.map((p) => `${p.vx * z},${p.vy * z}`).join(' '); }

  function arrowHead(svg, from, to, z, color, width) {
    const [w1, w2] = App.Geom.arrowHeadPoints(from, to, width);
    const p = ns('polygon');
    p.setAttribute('points',
      `${to.vx * z},${to.vy * z} ${w1.vx * z},${w1.vy * z} ${w2.vx * z},${w2.vy * z}`);
    p.setAttribute('fill', color);
    svg.appendChild(p);
  }

  function cloudPath(pts, z, closed) {
    // scalloped path around the polygon perimeter
    const r = 8; // scallop radius (points)
    let d = '';
    const loop = closed ? pts.concat([pts[0]]) : pts;
    for (let i = 0; i < loop.length - 1; i++) {
      const a = loop[i], b = loop[i + 1];
      const segLen = Math.hypot(b.vx - a.vx, b.vy - a.vy);
      const n = Math.max(1, Math.round(segLen / (r * 2)));
      for (let j = 0; j < n; j++) {
        const t0 = j / n, t1 = (j + 1) / n;
        const x0 = a.vx + (b.vx - a.vx) * t0, y0 = a.vy + (b.vy - a.vy) * t0;
        const x1 = a.vx + (b.vx - a.vx) * t1, y1 = a.vy + (b.vy - a.vy) * t1;
        if (i === 0 && j === 0) d += `M ${x0 * z} ${y0 * z} `;
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        // bulge outward (perpendicular)
        const nx = -(y1 - y0), nyv = (x1 - x0);
        const nl = Math.hypot(nx, nyv) || 1;
        const bx = mx + (nx / nl) * r, by = my + (nyv / nl) * r;
        d += `Q ${bx * z} ${by * z} ${x1 * z} ${y1 * z} `;
      }
    }
    return d;
  }

  function drawAnno(svg, an, z, selected) {
    const s = an.style;
    const stroke = s.stroke, fill = s.fill && s.fill !== 'none' ? s.fill : 'none';
    const common = (el, hit) => {
      el.setAttribute('stroke', stroke);
      el.setAttribute('stroke-width', s.width);
      el.setAttribute('fill', fill);
      el.setAttribute('opacity', s.opacity);
      const dash = App.dashArray ? App.dashArray(s.dash, s.width) : null;
      if (dash) el.setAttribute('stroke-dasharray', dash.join(' '));
      if (hit) { el.setAttribute('class', 'hit'); el.addEventListener('pointerdown', (e) => startDrag(an, e)); }
      svg.appendChild(el);
    };
    // A wide, invisible grab twin so thin line-shapes are easy to click + drag.
    const fatHit = (el) => {
      el.setAttribute('class', 'hit');
      el.setAttribute('stroke', 'transparent');
      el.setAttribute('stroke-width', 16);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke-linejoin', 'round');
      el.setAttribute('stroke-linecap', 'round');
      el.addEventListener('pointerdown', (e) => startDrag(an, e));
      svg.appendChild(el);
    };

    if (an.type === 'line' || an.type === 'arrow') {
      const l = ns('line');
      l.setAttribute('x1', an.pts[0].vx * z); l.setAttribute('y1', an.pts[0].vy * z);
      l.setAttribute('x2', an.pts[1].vx * z); l.setAttribute('y2', an.pts[1].vy * z);
      l.setAttribute('fill', 'none'); common(l, true);
      const hl = ns('line');
      hl.setAttribute('x1', an.pts[0].vx * z); hl.setAttribute('y1', an.pts[0].vy * z);
      hl.setAttribute('x2', an.pts[1].vx * z); hl.setAttribute('y2', an.pts[1].vy * z);
      fatHit(hl);
      if (an.type === 'arrow') arrowHead(svg, an.pts[0], an.pts[1], z, stroke, s.width);
    } else if (an.type === 'highlight') {
      // Freehand highlighter: a wide, translucent, round-capped band tracing the
      // (curve-fit) pen path so the underlying text stays legible through it.
      const pl = ns('polyline');
      pl.setAttribute('points', pts2str(smoothStroke(an), z));
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', stroke);
      pl.setAttribute('stroke-width', highlightWidth(s) * z);
      pl.setAttribute('stroke-linejoin', 'round');
      pl.setAttribute('stroke-linecap', 'round');
      pl.setAttribute('opacity', 0.35);
      pl.setAttribute('class', 'hit');
      pl.addEventListener('pointerdown', (e) => startDrag(an, e));
      svg.appendChild(pl);
    } else if (an.type === 'rect') {
      const b = bbox(an.pts);
      const r = ns('rect');
      r.setAttribute('x', b.x * z); r.setAttribute('y', b.y * z);
      r.setAttribute('width', b.w * z); r.setAttribute('height', b.h * z);
      common(r, true);
    } else if (an.type === 'ellipse') {
      const b = bbox(an.pts);
      const el = ns('ellipse');
      el.setAttribute('cx', (b.x + b.w / 2) * z); el.setAttribute('cy', (b.y + b.h / 2) * z);
      el.setAttribute('rx', (b.w / 2) * z); el.setAttribute('ry', (b.h / 2) * z);
      common(el, true);
    } else if (an.type === 'polyline' || an.type === 'ink') {
      // Ink is curve-fit for a silky line; polyline keeps its exact vertices.
      const rp = smoothStroke(an);
      const pl = ns('polyline');
      pl.setAttribute('points', pts2str(rp, z));
      pl.setAttribute('fill', 'none'); common(pl, true);
      if (an.type === 'ink') pl.setAttribute('stroke-linejoin', 'round'), pl.setAttribute('stroke-linecap', 'round');
      const hp = ns('polyline');
      hp.setAttribute('points', pts2str(rp, z));
      fatHit(hp);
    } else if (an.type === 'polygon') {
      const pg = ns('polygon');
      pg.setAttribute('points', pts2str(an.pts, z)); common(pg, true);
    } else if (an.type === 'cloud') {
      const path = ns('path');
      path.setAttribute('d', cloudPath(an.pts, z, true));
      path.setAttribute('fill', fill); common(path, true);
    } else if (an.type === 'text' || an.type === 'callout') {
      drawText(svg, an, z);
    } else if (an.type === 'texthighlight' || an.type === 'underline' || an.type === 'strikeout' || an.type === 'squiggly') {
      drawTextMarkup(svg, an, z);
    } else if (an.type === 'note') {
      drawNote(svg, an, z, (e) => startDrag(an, e));
    } else if (an.type === 'stamp') {
      drawStamp(svg, an, z, (e) => startDrag(an, e));
    } else if (an.type === 'link' || an.type === 'redact') {
      const b = bbox(an.pts);
      const r = ns('rect');
      r.setAttribute('x', b.x * z); r.setAttribute('y', b.y * z);
      r.setAttribute('width', b.w * z); r.setAttribute('height', b.h * z);
      if (an.type === 'link') {
        // On screen only: a link has no appearance in the saved file, like
        // Acrobat's and Revu's, so this dashed box is just a handle to find it.
        r.setAttribute('fill', 'rgba(47,111,237,0.08)');
        r.setAttribute('stroke', '#2f6fed');
        r.setAttribute('stroke-dasharray', '5 3');
        r.setAttribute('stroke-width', 1.2);
        const t = ns('title'); t.textContent = an.link ? (an.link.url || 'Go to page ' + an.link.page) + ' (double-click to open)' : 'Hyperlink (no target)';
        r.appendChild(t);
      } else {
        // Pending redaction: red outline over a translucent black, so what will
        // be removed is visible until Apply Redactions burns it out.
        r.setAttribute('fill', 'rgba(0,0,0,0.35)');
        r.setAttribute('stroke', '#e5484d');
        r.setAttribute('stroke-width', 1.5);
      }
      r.setAttribute('class', 'hit');
      r.addEventListener('pointerdown', (e) => startDrag(an, e));
      svg.appendChild(r);
    }

    if (selected) { if (an.quads) drawQuadsSel(svg, an, z); else drawSelection(svg, an, z); }
    if (an.locked && selected) drawLockBadge(svg, an, z);
  }

  // Sticky note icon: a folded yellow sheet. A dot in the corner shows the note
  // has a comment.
  function drawNote(svg, an, z, onDown) {
    const x = an.pts[0].vx * z, y = an.pts[0].vy * z, w = NOTE_SIZE * z;
    const g = ns('g');
    const body = ns('path');
    const f = w * 0.3;
    body.setAttribute('d', `M${x} ${y} h${w} v${w - f} l${-f} ${f} h${-(w - f)} z`);
    body.setAttribute('fill', (an.style && an.style.fill && an.style.fill !== 'none') ? an.style.fill : '#ffd400');
    body.setAttribute('stroke', '#7a5c00'); body.setAttribute('stroke-width', 1);
    g.appendChild(body);
    const fold = ns('path');
    fold.setAttribute('d', `M${x + w} ${y + w - f} h${-f} v${f}`);
    fold.setAttribute('fill', 'none'); fold.setAttribute('stroke', '#7a5c00'); fold.setAttribute('stroke-width', 1);
    g.appendChild(fold);
    for (let i = 1; i <= 3; i++) {
      const l = ns('line');
      l.setAttribute('x1', x + w * 0.2); l.setAttribute('x2', x + w * (i === 3 ? 0.55 : 0.8));
      l.setAttribute('y1', y + w * 0.22 * i); l.setAttribute('y2', y + w * 0.22 * i);
      l.setAttribute('stroke', '#7a5c00'); l.setAttribute('stroke-width', 1);
      g.appendChild(l);
    }
    const t = ns('title'); t.textContent = an.comment || 'Note (double-click to edit)';
    g.appendChild(t);
    g.setAttribute('class', 'hit');
    g.setAttribute('opacity', an.style && an.style.opacity != null ? an.style.opacity : 1);
    if (onDown) g.addEventListener('pointerdown', onDown);
    svg.appendChild(g);
  }

  // Review stamp: rounded frame in the stamp colour, bold label, optional date
  // line. Text scales with the box, so resizing a stamp resizes its lettering.
  function drawStamp(svg, an, z, onDown) {
    const b = bbox(an.pts);
    const col = (an.style && an.style.stroke) || '#15803d';
    const lines = String(an.text || 'STAMP').split('\n');
    const g = ns('g');
    const r = ns('rect');
    r.setAttribute('x', b.x * z); r.setAttribute('y', b.y * z);
    r.setAttribute('width', b.w * z); r.setAttribute('height', b.h * z);
    r.setAttribute('rx', 6 * z); r.setAttribute('fill', 'rgba(255,255,255,0.01)');
    r.setAttribute('stroke', col); r.setAttribute('stroke-width', Math.max(1, ((an.style && an.style.width) || 3) * z * 0.8));
    g.appendChild(r);
    const geo = stampGeometry(b, lines);
    lines.forEach((ln, i) => {
      const t = ns('text');
      t.setAttribute('x', (b.x + b.w / 2) * z);
      t.setAttribute('y', geo.baselines[i] * z);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
      t.setAttribute('font-weight', i === 0 ? '700' : '400');
      t.setAttribute('font-size', geo.sizes[i] * z);
      t.setAttribute('fill', col);
      t.textContent = ln;
      g.appendChild(t);
    });
    g.setAttribute('opacity', an.style && an.style.opacity != null ? an.style.opacity : 1);
    g.setAttribute('class', 'hit');
    if (onDown) g.addEventListener('pointerdown', onDown);
    svg.appendChild(g);
  }
  // Shared by the screen and save.js so a stamp prints where it shows: font
  // size and baseline (viewport points) for each line inside box b.
  // Advance width of a line in ems, measured with Helvetica on a canvas (the
  // PDF side draws Helvetica / Helvetica-Bold, so this is what it will occupy).
  // Falls back to an average capital width where there is no canvas.
  let _measureCtx = null;
  function emWidth(text, bold) {
    try {
      if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
      _measureCtx.font = (bold ? 'bold ' : '') + '100px Helvetica, Arial, sans-serif';
      return _measureCtx.measureText(String(text)).width / 100;
    } catch (_) { return String(text).length * (bold ? 0.72 : 0.56); }
  }
  function stampGeometry(b, lines) {
    const two = lines.length > 1;
    const padX = Math.min(b.w * 0.08, 14);
    const fitW = Math.max(10, b.w - 2 * padX);
    const mainEm = Math.max(0.5, emWidth(lines[0] || '', true));
    const main = Math.min(b.h / (two ? 2.35 : 1.6), fitW / mainEm);
    let sub = main * 0.62;
    if (two) sub = Math.min(sub, fitW / Math.max(0.5, emWidth(lines[1], false)));
    const block = main + (two ? sub * 1.2 : 0);
    const top = b.y + (b.h - block) / 2;
    const baselines = [top + main * 0.85];
    if (two) baselines.push(top + main + sub * 1.05);
    const sizes = two ? [main, sub] : [main];
    const widths = lines.slice(0, sizes.length).map((ln, i) => emWidth(ln, i === 0) * sizes[i]);
    return { sizes, baselines, widths };
  }
  K.stampGeometry = stampGeometry;

  function drawLockBadge(svg, an, z) {
    const b = an.quads ? quadsBBox(an.quads) : (an.type === 'note' ? { x: an.pts[0].vx, y: an.pts[0].vy, w: NOTE_SIZE, h: NOTE_SIZE } : bbox(an.pts));
    const t = ns('text');
    t.setAttribute('x', b.x * z - 2); t.setAttribute('y', b.y * z - 6);
    t.setAttribute('font-size', 11); t.setAttribute('fill', '#64748b');
    t.textContent = 'Locked';
    svg.appendChild(t);
  }

  function drawText(svg, an, z) {
    const s = an.style;
    const b = bbox(an.type === 'callout' ? an.pts.slice(0, 2) : an.pts);
    if (an.type === 'callout' && an.pts[2]) {
      // leader line from box edge to tip
      const tip = an.pts[2];
      const l = ns('line');
      l.setAttribute('x1', (b.x) * z); l.setAttribute('y1', (b.y + b.h) * z);
      l.setAttribute('x2', tip.vx * z); l.setAttribute('y2', tip.vy * z);
      l.setAttribute('stroke', s.stroke); l.setAttribute('stroke-width', s.width);
      svg.appendChild(l);
      arrowHead(svg, { vx: b.x, vy: b.y + b.h }, tip, z, s.stroke, s.width);
    }
    const fo = ns('foreignObject');
    fo.setAttribute('x', b.x * z); fo.setAttribute('y', b.y * z);
    fo.setAttribute('width', Math.max(40, b.w * z)); fo.setAttribute('height', Math.max(20, b.h * z));
    fo.setAttribute('class', 'hit');
    fo.setAttribute('data-anno-id', an.id);
    const div = document.createElement('div');
    // A text box is literally text: no frame, no fill, just glyphs on the sheet
    // (which is what save.js writes out, both flattened and as a FreeText).
    // A callout is a different animal — its box is part of the mark, so it keeps
    // the frame and a translucent backing to stay legible over a drawing.
    div.className = 'anno-text' + (an.type === 'callout' ? ' boxed' : '');
    div.style.color = s.stroke;
    div.style.fontFamily = fontById(s.fontFamily).css;
    div.style.fontSize = (s.fontSize * z) + 'px';
    if (an.type === 'callout') div.style.border = `1px solid ${s.stroke}`;
    div.textContent = an.text || '';
    fo.appendChild(div);
    fo.addEventListener('pointerdown', (e) => onTextPointerDown(an, div, e));
    svg.appendChild(fo);
  }

  // Double-click-to-edit is detected manually rather than via the native
  // `dblclick` event: selecting a shape rebuilds the whole SVG (K.select ->
  // K.repositionAll), so the first click of a double-click destroys and
  // replaces this foreignObject. The browser then sees the second click on a
  // different DOM node and never fires `dblclick`. Tracking two quick
  // pointerdowns on the same annotation id (which survives the rebuild) is
  // reliable across that DOM swap.
  let _lastTextClick = { id: null, t: 0 };
  const DBLCLICK_MS = 350;
  function onTextPointerDown(an, div, e) {
    // While the box is being edited, let the browser handle clicks so the
    // caret can be placed and text selected inside the contenteditable div.
    if (div.getAttribute('contenteditable') === 'true') { e.stopPropagation(); return; }
    const now = Date.now();
    if (_lastTextClick.id === an.id && (now - _lastTextClick.t) < DBLCLICK_MS) {
      _lastTextClick = { id: null, t: 0 };
      e.preventDefault(); e.stopPropagation();
      startTextEdit(an);
      return;
    }
    _lastTextClick = { id: an.id, t: now };
    startDrag(an, e);
  }

  function startTextEdit(an) {
    K.repositionAll();
    const svg = findSvgForPage(an.page); if (!svg) return;
    const fo = svg.querySelector(`foreignObject[data-anno-id="${an.id}"]`);
    const div = fo && fo.querySelector('.anno-text');
    if (!div) return;
    div.setAttribute('contenteditable', 'true');
    div.focus();
    const range = document.createRange(); range.selectNodeContents(div);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    function commit() {
      snapshot();
      an.text = div.textContent.trim() || 'Text';
      fitTextHeight(an, div);
      div.removeAttribute('contenteditable');
      div.removeEventListener('blur', commit); div.removeEventListener('keydown', key);
      K.repositionAll();
    }
    function key(ev) { if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey)) { ev.preventDefault(); div.blur(); } }
    div.addEventListener('blur', commit); div.addEventListener('keydown', key);
  }
  // Grow the box down to fit what was typed. The box has no frame now, so
  // nothing on screen would hint that a long note is being clipped — and the
  // export draws every line regardless of the box, so a too-short box makes the
  // screen disagree with the saved file. Height only: the width is the user's.
  function fitTextHeight(an, div) {
    const z = App.state.zoom || 1;
    const need = div.scrollHeight / z;
    const top = Math.min(an.pts[0].vy, an.pts[1].vy);
    const bot = Math.max(an.pts[0].vy, an.pts[1].vy);
    if (!(need > bot - top)) return;
    const i = an.pts[0].vy > an.pts[1].vy ? 0 : 1; // the lower of the two corners
    an.pts[i].vy = top + need;
  }

  function findSvgForPage(page) {
    const pe = App.state.pageEls[page - 1];
    return pe ? pe.holder.querySelector('.markup-svg') : null;
  }

  function drawSelection(svg, an, z) {
    if (an.type === 'note') {
      const box = ns('rect');
      box.setAttribute('x', an.pts[0].vx * z - 3); box.setAttribute('y', an.pts[0].vy * z - 3);
      box.setAttribute('width', NOTE_SIZE * z + 6); box.setAttribute('height', NOTE_SIZE * z + 6);
      box.setAttribute('class', 'sel-box'); box.setAttribute('fill', 'none');
      svg.appendChild(box);
      return; // a note is an icon: it moves, it does not resize
    }
    const b = bbox(an.type === 'callout' ? an.pts.slice(0, 2) : an.pts);
    const box = ns('rect');
    box.setAttribute('x', b.x * z - 3); box.setAttribute('y', b.y * z - 3);
    box.setAttribute('width', b.w * z + 6); box.setAttribute('height', b.h * z + 6);
    box.setAttribute('class', 'sel-box'); box.setAttribute('fill', 'none');
    svg.appendChild(box);
    const h = ns('rect');
    h.setAttribute('x', (b.x + b.w) * z - 4); h.setAttribute('y', (b.y + b.h) * z - 4);
    h.setAttribute('width', 8); h.setAttribute('height', 8);
    h.setAttribute('class', 'handle');
    h.addEventListener('pointerdown', (e) => startResize(an, e));
    svg.appendChild(h);
  }

  function drawPreview(svg, a, z) {
    const s = defaults(a.type);
    const live = a.pts.concat(a.hover && TWO_POINT[a.type] && a.pts.length < 2 ? [a.hover] :
      a.hover && N_POINT[a.type] ? [a.hover] : []);
    const tmp = { type: a.type, pts: live.length >= 2 ? live : a.pts, style: Object.assign({}, s), text: 'Text' };
    if (tmp.pts.length >= (TWO_POINT[a.type] ? 2 : 2)) {
      const g = ns('g'); g.setAttribute('opacity', '0.7'); svg.appendChild(g);
      // reuse drawAnno by temporarily rendering into a sub-group
      const prevSel = App.state.annoSelectedId; App.state.annoSelectedId = null;
      drawAnnoInto(g, tmp, z);
      App.state.annoSelectedId = prevSel;
    }
    // Vertex dots are click-placement feedback; a freehand stroke has hundreds of
    // points, so dotting each one just beads the line — skip them there.
    if (FREEHAND[a.type]) return;
    a.pts.forEach((p) => {
      const c = ns('circle'); c.setAttribute('cx', p.vx * z); c.setAttribute('cy', p.vy * z);
      c.setAttribute('r', 3); c.setAttribute('fill', s.stroke); svg.appendChild(c);
    });
  }
  // draw an annotation into an arbitrary parent (for preview) without hit handlers
  function drawAnnoInto(parent, an, z) {
    const fake = { appendChild: (el) => parent.appendChild(el), querySelector: () => null };
    drawAnno(fake, an, z, false);
  }

  /* ---------------- properties bar ---------------- */
  function syncPropBar() {
    // While a drawing tool is armed the bar describes the NEXT markup, not the one
    // just drawn — finalize() leaves that selected so it can still be nudged or
    // deleted, but the user's next style change is meant for what comes next.
    // Reading the selection here would make the bar show a colour that changing
    // no longer affects (see applyStyle).
    const an = editTarget();
    const s = an ? an.style : defaults(K.tool);
    const set = (id, v) => { const el = App.$(id); if (el) el.value = v; };
    set('#mk-stroke', s.stroke);
    set('#mk-fill', s.fill && s.fill !== 'none' ? s.fill : '#ffffff');
    App.$('#mk-fill-on') && (App.$('#mk-fill-on').checked = !!(s.fill && s.fill !== 'none'));
    set('#mk-width', s.width);
    set('#mk-opacity', Math.round(s.opacity * 100));
    set('#mk-dash', s.dash || 'solid');
    set('#mk-font-family', fontById(s.fontFamily).id);
    set('#mk-font-size', s.fontSize || 14);
    // Font controls are only meaningful for text boxes / callouts — show them
    // when such a box is selected or when the text/callout tool is armed.
    const textCtx = an ? isTextType(an.type) : isTextType(K.tool);
    App.$$('.mk-font-only').forEach((el) => el.classList.toggle('hidden', !textCtx));
    // highlight the preset swatch matching the current line color (if any)
    const cur = String(s.stroke || '').toLowerCase();
    App.$$('#mk-stroke-presets .mk-sw').forEach((b) => b.classList.toggle('active', b.dataset.color.toLowerCase() === cur));
    // Same for the user's own saved colors, and the star that adds to them.
    if (App.FavColors) {
      App.FavColors.refresh();
      App.FavColors.syncStar(App.$('#mk-fav-toggle'), cur);
    }
  }
  K.syncProps = syncPropBar;
  // The markup a style change should edit, or null to edit the defaults instead.
  // Restyling is retroactive only when the user explicitly picked an object with
  // Select; with a tool armed it's prospective, so choosing a colour part-way
  // through highlighting applies to the next highlight rather than recolouring
  // the last one.
  function editTarget() { return K.tool ? null : annoById(App.state.annoSelectedId); }

  // The line color the bar is showing — the selected markup's, or the default
  // the next one will get. Starring and picking a favourite both act on this,
  // so they follow the same selected-vs-armed rule as every other property.
  function currentStroke() {
    const an = editTarget();
    return (an ? an.style : defaults(K.tool)).stroke;
  }

  function applyStyle(patch) {
    const an = editTarget();
    if (an) { snapshot(); Object.assign(an.style, patch); K.repositionAll(); }
    // Update the defaults the next markup of this kind will get — the selected
    // markup's kind when one is selected, otherwise the armed tool's.
    const kind = an ? an.type : K.tool;
    Object.assign(defaults(kind), patch);
    if (App.Prefs) App.Prefs.set(styleKey(kind), App.state[styleKey(kind)]); // persist across restarts
  }

  K.init = function () {
    App.state.annotations = App.state.annotations || [];
    defaults(); defaults('text');
    const wire = (id, ev, fn) => { const el = App.$(id); if (el) el.addEventListener(ev, fn); };
    // syncPropBar() after the style change, not just before: the swatch outline
    // and the favourites star both describe the current colour, and the wheel is
    // a way to change that colour without touching either control.
    wire('#mk-stroke', 'input', (e) => { applyStyle({ stroke: e.target.value }); syncPropBar(); });
    // preset swatches: set the color input + reuse its input handler (above)
    const presets = App.$('#mk-stroke-presets');
    if (presets) presets.querySelectorAll('.mk-sw').forEach((b) => {
      b.addEventListener('click', () => {
        const el = App.$('#mk-stroke');
        el.value = b.dataset.color;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
    // Favourite colors: the same click-to-apply as a preset, but the list is the
    // user's own — the exact codes their plan legend is drawn with.
    if (App.FavColors) {
      App.FavColors.mount(App.$('#mk-fav-strip'), {
        current: () => currentStroke(),
        onPick: (hex) => {
          const el = App.$('#mk-stroke');
          el.value = hex;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      wire('#mk-fav-toggle', 'click', () => { App.FavColors.toggle(currentStroke()); syncPropBar(); });
      wire('#mk-fav-manage', 'click', () => App.FavColors.open(currentStroke()));
    }
    wire('#mk-fill', 'input', (e) => { if (App.$('#mk-fill-on').checked) applyStyle({ fill: e.target.value }); });
    wire('#mk-fill-on', 'change', (e) => applyStyle({ fill: e.target.checked ? App.$('#mk-fill').value : 'none' }));
    wire('#mk-width', 'input', (e) => applyStyle({ width: parseFloat(e.target.value) }));
    wire('#mk-opacity', 'input', (e) => applyStyle({ opacity: App.clamp(parseInt(e.target.value, 10) / 100, 0.1, 1) }));
    wire('#mk-dash', 'change', (e) => applyStyle({ dash: e.target.value === 'solid' ? undefined : e.target.value }));
    wire('#mk-font-family', 'change', (e) => applyStyle({ fontFamily: fontById(e.target.value).id }));
    wire('#mk-font-size', 'input', (e) => applyStyle({ fontSize: App.clamp(parseInt(e.target.value, 10) || 14, 6, 120) }));
    // Snap toggle — persisted; drives snapEnabled().
    const snap = App.$('#mk-snap');
    if (snap) {
      snap.checked = App.Prefs ? App.Prefs.get('snap', true) : true;
      snap.addEventListener('change', (e) => { if (App.Prefs) App.Prefs.set('snap', e.target.checked); });
    }
    syncPropBar();
  };

  /* ---------------- Markups List panel ---------------- */
  const Panel = {};
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  Panel.toggle = function () {
    const p = App.$('#markup-panel');
    const open = p.classList.toggle('hidden');
    document.body.classList.toggle('has-mkpanel', !open);
    if (!p.classList.contains('hidden')) Panel.render();
  };
  // Sort / status-filter state for the list (session only, like the filter box).
  const view = { sort: 'page', dir: 'asc', status: '*' };
  // The markups the list currently shows, in its order. The CSV and the summary
  // export exactly this, so what you filter is what you get.
  Panel.visible = function () {
    const q = ((App.$('#mkp-filter') && App.$('#mkp-filter').value) || '').trim();
    const shown = App.filterMarkups(App.state.annotations, { q, status: view.status });
    return App.sortMarkups(shown, view.sort, view.dir);
  };
  Panel.setView = function (patch) { Object.assign(view, patch || {}); Panel.render(); };

  Panel.render = function () {
    if (App.AnnotImport) App.AnnotImport.renderBanner();
    const list = App.$('#mkp-list'); if (!list) return;
    const all = App.state.annotations;
    const q = ((App.$('#mkp-filter') && App.$('#mkp-filter').value) || '').trim();
    const arr = Panel.visible();
    syncMetaProps();
    list.innerHTML = '';
    if (!all.length) { list.innerHTML = '<div class="mp-empty"><div class="mp-empty-ico">' + App.icon('pencil', 'ico-lg') + '</div>No markups yet.<br>Use the Markup menu to add some.</div>'; return; }
    if (!arr.length) { list.innerHTML = '<div class="mp-empty">No markups match ' + (q ? '“' + esc(q) + '”' : 'this status') + '.</div>'; return; }
    arr.forEach((an) => {
      const row = document.createElement('div');
      // A clickable <div> with no role, no tab stop and no key handler made the
      // whole panel pointer-only. option/listbox rather than button: these are a
      // single-select set, and that is what a screen reader should hear.
      row.className = 'mp-row' + (an.id === App.state.annoSelectedId ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.tabIndex = 0;
      row.setAttribute('aria-selected', an.id === App.state.annoSelectedId ? 'true' : 'false');
      const st = App.markupStatusOf(an);
      const comment = App.markupCommentOf(an);
      row.innerHTML =
        `<span class="mp-swatch" style="background:${esc((an.style && an.style.stroke) || '#999')}"></span>` +
        `<span class="mp-type">${esc(App.markupSubjectOf(an))}</span>` +
        `<span class="mp-val">${comment ? esc(comment) : ''}</span>` +
        (st.id ? `<span class="mp-status mp-status-${esc(st.id)}">${esc(st.label)}</span>` : '') +
        (an.locked ? '<span class="mp-lock" title="Locked">Locked</span>' : '') +
        (an.importedFrom ? `<span class="mp-from" title="Made in another app by ${esc(an.importedFrom)}">From: ${esc(an.importedFrom)}</span>` : '') +
        `<span class="mp-pg">p${an.page}</span>` +
        `<button class="mp-del" title="Delete" aria-label="Delete">${App.icon('trash')}</button>`;
      // A tab stop that does nothing on Enter is worse than no tab stop.
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        row.click();
      });
      row.addEventListener('click', (e) => {
        if (e.target.closest('.mp-del')) { K.remove(an.id); Panel.render(); return; }
        K.select(an.id);
        const pe = App.state.pageEls[an.page - 1];
        if (pe && pe.pageDiv) pe.pageDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      list.appendChild(row);
    });
  };

  // ---- selected markup: subject / status / comment / lock ----
  function syncMetaProps() {
    const box = App.$('#mkp-props'); if (!box) return;
    const an = annoById(App.state.annoSelectedId);
    box.classList.toggle('hidden', !an);
    if (!an) return;
    const active = document.activeElement;
    const set = (id, v) => { const el = App.$(id); if (el && el !== active) el.value = v; };
    set('#mkp-subject', an.subject || '');
    App.$('#mkp-subject').placeholder = App.markupTypeLabel(an.type);
    set('#mkp-status', App.markupStatusOf(an).id);
    set('#mkp-comment', an.comment || '');
    App.$('#mkp-locked').checked = !!an.locked;
    App.$('#mkp-link-edit').classList.toggle('hidden', an.type !== 'link');
    App.$('#mkp-link-go').classList.toggle('hidden', !(an.type === 'link' && an.link));
  }
  // One undo step per field edit: snapshot on the first keystroke, release on
  // blur/change (same idea as the measurement property edits).
  let _metaEditing = false;
  function editMeta(patch, commit) {
    const an = annoById(App.state.annoSelectedId);
    if (!an) return;
    if (an.locked && !('locked' in patch)) { App.toast('This markup is locked. Untick Locked to edit it.', 'info', 3000); syncMetaProps(); return; }
    if (!_metaEditing) { snapshot(); _metaEditing = true; }
    Object.assign(an, patch);
    App.$('#btn-save').disabled = false;
    if (commit) { _metaEditing = false; K.repositionAll(an.page); Panel.render(); }
  }
  K.setMeta = function (id, patch) {
    const an = annoById(id); if (!an) return false;
    snapshot(); Object.assign(an, patch); K.repositionAll(an.page); Panel.render();
    return true;
  };

  Panel.clearAll = async function () {
    if (!App.state.annotations.length) return;
    const locked = App.state.annotations.filter((a) => a.locked).length;
    const ok = await App.confirm(
      'Delete all markups? You can undo this with Ctrl+Z.' + (locked ? ` ${locked} locked markup${locked === 1 ? '' : 's'} will be kept.` : ''),
      { title: 'Clear markups', okLabel: 'Clear all', danger: true });
    if (!ok) return;
    snapshot();
    App.state.annotations = App.state.annotations.filter((a) => a.locked);
    App.state.annoSelectedId = null;
    K.repositionAll(); Panel.render();
  };
  Panel.exportCsv = async function () {
    const arr = Panel.visible();
    if (!arr.length) { App.toast('No markups to export.', 'error'); return; }
    const csv = App.markupRowsToCsv(App.markupRows(arr));
    const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    const res = await window.api.saveTextDialog(`${base}-markups.csv`, csv);
    if (res && res.ok) App.toast(`Saved: ${res.path}`, 'success', 5000);
    else if (res && res.error) App.toast('Could not save CSV: ' + res.error, 'error');
  };

  // Markup Summary as a PDF report (Revu: Batch > Summary > PDF). Landscape
  // Letter, one row per markup with its status and comment, wrapped. Built
  // with pdf-lib in the renderer, so it is the same on every platform.
  Panel.buildSummaryBytes = async function (list) {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const arr = list || Panel.visible();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    // The standard fonts are WinAnsi only; anything outside it would throw and
    // lose the whole report, so it is replaced.
    const clean = (t) => String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
    const W = 792, H = 612, M = 36;
    const cols = [
      { key: 0, label: '#', w: 26 }, { key: 4, label: 'Page', w: 34 }, { key: 1, label: 'Type', w: 78 },
      { key: 2, label: 'Subject', w: 120 }, { key: 3, label: 'Status', w: 70 }, { key: 6, label: 'Comment', w: 300 },
      { key: 8, label: 'Created', w: 92 }
    ];
    const rows = App.markupRows(arr).slice(1);
    const size = 8.5, lh = 11;
    const wrap = (text, width) => {
      const words = clean(text).split(' ');
      const out = []; let line = '';
      words.forEach((w) => {
        const tryLine = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(tryLine, size) <= width - 6 || !line) line = tryLine;
        else { out.push(line); line = w; }
      });
      if (line) out.push(line);
      return out.length ? out : [''];
    };
    let page, y;
    const header = () => {
      page = doc.addPage([W, H]);
      y = H - M;
      page.drawText(clean('Markup Summary - ' + (App.state.fileName || 'document.pdf')), { x: M, y: y - 14, size: 14, font: bold, color: rgb(0.08, 0.32, 0.18) });
      y -= 30;
      const totals = App.markupStatusTotals(arr);
      const tline = `${arr.length} markup${arr.length === 1 ? '' : 's'}  |  ` + Object.keys(totals).map((k) => `${k}: ${totals[k]}`).join('  |  ') +
        `  |  Printed ${App.fmtMarkupDate(Date.now())}`;
      page.drawText(clean(tline), { x: M, y, size: 9, font, color: rgb(0.2, 0.25, 0.3) });
      y -= 18;
      let x = M;
      page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.08, 0.32, 0.18) });
      cols.forEach((c) => { page.drawText(c.label, { x: x + 3, y, size: 9, font: bold, color: rgb(1, 1, 1) }); x += c.w; });
      y -= 18;
    };
    header();
    rows.forEach((r, i) => {
      const cells = cols.map((c) => c.key === 6 ? wrap(r[c.key], c.w) : [clean(r[c.key])]);
      const n = Math.max.apply(null, cells.map((c) => c.length));
      if (y - n * lh < M) header();
      if (i % 2 === 0) page.drawRectangle({ x: M, y: y - (n - 1) * lh - 3, width: W - 2 * M, height: n * lh + 2, color: rgb(0.94, 0.97, 0.95) });
      let x = M;
      cells.forEach((lines, ci) => {
        lines.forEach((ln, li) => {
          let t = ln;
          const maxW = cols[ci].w - 6;
          while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
          page.drawText(t, { x: x + 3, y: y - li * lh, size, font, color: rgb(0.12, 0.16, 0.23) });
        });
        x += cols[ci].w;
      });
      y -= n * lh + 4;
    });
    if (!rows.length) page.drawText('No markups.', { x: M, y, size: 10, font });
    const pages = doc.getPages();
    pages.forEach((pg, i) => pg.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 70, y: M / 2, size: 8, font, color: rgb(0.4, 0.45, 0.5) }));
    return doc.save();
  };
  Panel.exportSummary = async function () {
    const arr = Panel.visible();
    if (!arr.length) { App.toast('No markups to summarize.', 'error'); return; }
    try {
      const bytes = await Panel.buildSummaryBytes(arr);
      const base = (App.state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
      const res = await window.api.savePdfDialog(`${base}-markup-summary.pdf`, bytes);
      if (res && res.ok) App.toast(`Saved: ${res.path}`, 'success', 5000);
      else if (res && res.error) App.toast('Could not save the summary: ' + res.error, 'error');
    } catch (e) {
      App.toast('Could not build the markup summary: ' + (e && e.message), 'error', 7000);
    }
  };
  App.MarkupPanel = Panel;

  // wire panel buttons after DOM is ready (init is called at boot)
  const prevInit = K.init;
  K.init = function () {
    prevInit();
    const b = (id, fn) => { const el = App.$(id); if (el) el.addEventListener('click', fn); };
    b('#mkp-close', Panel.toggle);
    b('#mkp-export', Panel.exportCsv);
    b('#mkp-summary', Panel.exportSummary);
    b('#mkp-clear', Panel.clearAll);
    const filt = App.$('#mkp-filter');
    if (filt) filt.addEventListener('input', Panel.render);
    const sf = App.$('#mkp-status-filter');
    if (sf) sf.addEventListener('change', (e) => Panel.setView({ status: e.target.value }));
    const so = App.$('#mkp-sort');
    if (so) so.addEventListener('change', (e) => Panel.setView({ sort: e.target.value }));
    b('#mkp-sort-dir', (e) => {
      const dir = view.dir === 'asc' ? 'desc' : 'asc';
      e.currentTarget.textContent = dir === 'asc' ? '↓' : '↑';
      e.currentTarget.setAttribute('aria-pressed', dir === 'desc' ? 'true' : 'false');
      Panel.setView({ dir });
    });
    const wireMeta = (id, key, ev) => {
      const el = App.$(id); if (!el) return;
      el.addEventListener(ev, () => editMeta({ [key]: el.value }, false));
      el.addEventListener('change', () => editMeta({ [key]: el.value }, true));
      el.addEventListener('blur', () => { _metaEditing = false; });
    };
    wireMeta('#mkp-subject', 'subject', 'input');
    wireMeta('#mkp-comment', 'comment', 'input');
    const stSel = App.$('#mkp-status');
    if (stSel) stSel.addEventListener('change', () => editMeta({ status: stSel.value }, true));
    const lk = App.$('#mkp-locked');
    if (lk) lk.addEventListener('change', () => editMeta({ locked: lk.checked }, true));
    b('#mkp-link-edit', () => { if (App.state.annoSelectedId != null) K.editLink(App.state.annoSelectedId); });
    b('#mkp-link-go', () => K.followLink(annoById(App.state.annoSelectedId)));
    const chk = App.$('#mkp-annots');
    if (chk) {
      // Restore the persisted editable-vs-flatten choice.
      // Fallback is true, matching App.state — see the note in util.js. A user
      // who has explicitly ticked or unticked the box keeps their own choice;
      // only the never-set fallback moves.
      const saved = App.Prefs ? App.Prefs.get('saveAnnots', true) : true;
      App.state.saveAnnots = saved;
      chk.checked = saved;
      chk.addEventListener('change', (e) => {
        App.state.saveAnnots = e.target.checked;
        if (App.Prefs) App.Prefs.set('saveAnnots', e.target.checked);
      });
    }
  };

  /* ---------------- text markup: highlight / underline / strikeout ---------------- */
  const TEXT_MARKUP = { texthighlight: 'Highlight', underline: 'Underline', strikeout: 'Strikeout', squiggly: 'Squiggly' };
  K.isTextTool = (t) => !!TEXT_MARKUP[t];

  function quadsBBox(quads) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    quads.forEach((q) => { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x + q.w); y1 = Math.max(y1, q.y + q.h); });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function drawTextMarkup(svg, an, z) {
    const color = (an.style && an.style.stroke) || '#ffd400';
    const width = Math.max(1.5, (an.style && an.style.width) || 2);
    const sel = (e) => { e.stopPropagation(); K.select(an.id); };
    (an.quads || []).forEach((q) => {
      if (an.type === 'texthighlight') {
        const r = ns('rect');
        r.setAttribute('x', q.x * z); r.setAttribute('y', q.y * z);
        r.setAttribute('width', q.w * z); r.setAttribute('height', q.h * z);
        r.setAttribute('fill', color); r.setAttribute('opacity', 0.4); r.setAttribute('stroke', 'none');
        r.setAttribute('class', 'hit'); r.addEventListener('pointerdown', sel);
        svg.appendChild(r);
      } else if (an.type === 'squiggly') {
        const path = ns('path');
        path.setAttribute('d', squigglePath(q, z));
        path.setAttribute('fill', 'none'); path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', Math.max(1, width * 0.7));
        path.setAttribute('class', 'hit'); path.addEventListener('pointerdown', sel);
        svg.appendChild(path);
        const hitR = ns('rect');
        hitR.setAttribute('x', q.x * z); hitR.setAttribute('y', (q.y + q.h * 0.7) * z);
        hitR.setAttribute('width', q.w * z); hitR.setAttribute('height', Math.max(6, q.h * 0.3 * z));
        hitR.setAttribute('fill', 'transparent'); hitR.setAttribute('class', 'hit');
        hitR.addEventListener('pointerdown', sel);
        svg.appendChild(hitR);
      } else {
        const yy = (an.type === 'underline' ? q.y + q.h - 1 : q.y + q.h / 2) * z;
        [false, true].forEach((transparent) => {
          const l = ns('line');
          l.setAttribute('x1', q.x * z); l.setAttribute('y1', yy);
          l.setAttribute('x2', (q.x + q.w) * z); l.setAttribute('y2', yy);
          l.setAttribute('stroke', transparent ? 'transparent' : color);
          l.setAttribute('stroke-width', transparent ? 12 : width);
          l.setAttribute('class', 'hit'); l.addEventListener('pointerdown', sel);
          svg.appendChild(l);
        });
      }
    });
  }

  // Wavy underline along the bottom of a text quad. Same wave as save.js writes
  // (K.squigglePoints), so screen and file agree.
  function squigglePoints(q) {
    const amp = Math.max(0.8, q.h * 0.08), period = Math.max(3, q.h * 0.35);
    const base = q.y + q.h - amp - 0.5;
    const out = [];
    const steps = Math.max(2, Math.ceil(q.w / (period / 2)));
    for (let i = 0; i <= steps; i++) {
      const x = q.x + (q.w * i) / steps;
      out.push({ x, y: base + (i % 2 ? amp : -amp) });
    }
    return out;
  }
  K.squigglePoints = squigglePoints;
  function squigglePath(q, z) {
    return squigglePoints(q).map((p, i) => `${i ? 'L' : 'M'}${p.x * z} ${p.y * z}`).join(' ');
  }

  function drawQuadsSel(svg, an, z) {
    const b = quadsBBox(an.quads);
    const box = ns('rect');
    box.setAttribute('x', b.x * z - 2); box.setAttribute('y', b.y * z - 2);
    box.setAttribute('width', b.w * z + 4); box.setAttribute('height', b.h * z + 4);
    box.setAttribute('class', 'sel-box'); box.setAttribute('fill', 'none');
    svg.appendChild(box);
  }

  // Capture the current text selection as scale-1 viewport quads, grouped by page.
  K.captureSelection = function () {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const z = App.state.zoom;
    const byPage = {};
    for (let ri = 0; ri < sel.rangeCount; ri++) {
      const rects = sel.getRangeAt(ri).getClientRects();
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        for (let i = 0; i < App.state.pageEls.length; i++) {
          const pe = App.state.pageEls[i];
          if (!pe) continue;
          const pr = pe.overlay.getBoundingClientRect();
          if (cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom) {
            (byPage[i + 1] = byPage[i + 1] || []).push({
              x: (r.left - pr.left) / z, y: (r.top - pr.top) / z, w: r.width / z, h: r.height / z
            });
            break;
          }
        }
      }
    }
    return Object.keys(byPage).length ? byPage : null;
  };

  // Turn the current (or provided) selection into highlight/underline/strikeout annotations.
  K.applyTextMarkup = function (subtype, byPage) {
    const groups = byPage || K.captureSelection();
    if (!groups) { App.toast('Select some text on the page first.', 'info', 3000); return false; }
    snapshot();
    const base = defaults();
    Object.keys(groups).forEach((page) => {
      App.state.annoSeq = (App.state.annoSeq || 0) + 1;
      App.state.annotations.push({
        id: App.state.annoSeq, page: +page, type: subtype, quads: groups[page],
        style: { stroke: base.stroke, fill: 'none', width: base.width, opacity: 1 },
        createdAt: Date.now()
      });
    });
    const sel = window.getSelection(); if (sel) sel.removeAllRanges();
    K.repositionAll();
    if (App.MarkupPanel) App.MarkupPanel.render();
    return true;
  };

  // Sticky "select text → apply" mode. We deliberately do NOT set body.tool-active
  // (which would put the markup layer over the text layer); the text layer stays
  // selectable and each finished selection is marked up on mouseup.
  K.startTextMarkup = function (subtype) {
    if (K.stop) K.stop();                 // leave any drawing tool
    K.textTool = subtype;
    document.body.classList.add('text-markup');
    App.toast(`${TEXT_MARKUP[subtype]}: select text on the page. Press Esc to stop.`, 'info', 4000);
  };
  K.stopTextMarkup = function () {
    if (!K.textTool) return;
    K.textTool = null;
    document.body.classList.remove('text-markup');
  };

  {
    const prevInitTM = K.init;
    K.init = function () {
      prevInitTM();
      document.addEventListener('mouseup', () => {
        if (!K.textTool) return;
        // Defer so the browser finalizes the selection first.
        setTimeout(() => { if (K.textTool) K.applyTextMarkup(K.textTool); }, 0);
      });
    };
  }

  K.highlightWidth = highlightWidth; // save.js reuses this so on-screen == exported
  K.smoothStroke = smoothStroke;     // save.js reuses this so the exported curve matches the screen
  K.FONTS = FONTS;                   // save.js reuses this so the exported font matches the screen
  K.fontById = fontById;
  K._straighten = straightenActive;  // exposed for the e2e harness (deterministic, no 3s wait)
  App.Markup = K;
})();
