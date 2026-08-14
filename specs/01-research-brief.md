# Research Brief — Viewer UX pass (6 requests)

Phase 1 output. Feature work on an existing codebase, so codebase exploration came first.
Every claim below is grounded in a file path; nothing here is a design decision.

## 1. Problem statement

Six independent complaints about the viewer's day-to-day ergonomics. Four are UI
affordances that don't exist yet (bookmark, page-jump panel, rail size, single
toolbar), one is a behavioural bug (highlighter colour applies retroactively), and
one is a performance problem (print preview on large multi-page plan sets). They
share no feature surface but all live in the renderer, so they ship to Windows,
macOS and Android together.

## 2. Users and jobs to be done

Field/office users reading large construction plan sets. The jobs: get back to a
sheet you were just on, move between sheets without scrolling, keep the drawing
area as large as possible, redline without the UI fighting you, and print a subset
of a big set without the app stalling.

## 3. Existing codebase findings

**Stack** (`package.json`, `CLAUDE.md`): vanilla JS on a global `App` object, no
bundler, no framework. PDF.js for rendering, pdf-lib for export. Electron desktop +
Capacitor Android, which runs the same renderer verbatim. Shared pure logic in
`src/shared/` is unit-tested with vitest; Electron behaviour is covered by a
`SMOKE_*` harness in `src/main.js` asserted by `test/e2e/run.js` (55 scenarios).

**Chrome inventory** (`src/renderer/index.html`) — five distinct bars already exist:

| Element | Line | Role |
|---|---|---|
| `#toolbar` | 22 | Top bar: open, zoom, page nav, save, theme, help |
| `#tool-rail` | 92 | Left rail: Select / Stamp / Take-off / Document groups |
| `#mode-banner` | 192 | Status strip ("Measuring — press Enter…") |
| `#markup-props` | 199 | Markup properties bar (colour, width, opacity, font) |
| `#markup-rail` | 276 | Right-hand icon-only markup strip |

**Panels** all dock right at `width: 340px` / `300px` (`styles.css:1335`, `:610`),
each with a `body.has-*panel` class that pulls `#viewer-wrap`'s `right` in
(`styles.css:615`, `:1341`). There is no left-docked panel precedent.

**Per-request findings:**

1. **Bookmark** — `grep -rni bookmark src test` returns nothing. Entirely new.
   `App.Prefs` (`src/shared/prefs.js`) is a localStorage key/value blob with
   `get/set/merge`; `src/shared/recent-files.js` is the precedent for a
   path-keyed list. `App.Viewer.goToPage(n)` (`viewer.js:679`) is the jump API.
   `App.state.currentPage` holds the current sheet.

2. **Page-jump panel** — `organize.js` already renders exactly this: a lazy
   thumbnail grid via `IntersectionObserver` (`organize.js:117-134`), 120px wide,
   from PDF.js. It is a *reordering* tool, not a navigator. `miniviewer.js`
   is a second, separate thumbnail renderer used by split view. So the thumbnail
   code exists twice already; a third copy would be the wrong move.

3. **Rail size** — `--rail-w: 148px` (`styles/tokens.css:30`), `.rail-btn` height
   `38px` (`styles.css:753`). A collapse toggle already exists and narrows it to
   `56px` icon-only (`styles.css:780-789`), persisted in prefs, desktop-only
   (`min-width: 821px`). Covered by `SMOKE_RAIL`.

4. **Highlighter colour is retroactive — root cause found.**
   `markup.js:119 finalize()` sets `App.state.annoSelectedId = an.id` on every
   newly drawn markup. `markup.js:651 applyStyle()` then does
   `if (an) { Object.assign(an.style, patch) }` *before* updating the defaults —
   so picking a colour while the just-drawn highlight is still selected recolours
   it. This is observed behaviour of the code, not an inference.

5. **Two toolbars — same root cause.**
   `app.js:88 refreshChrome()` shows `#markup-props` when
   `mode === 'markup' || annoSelectedId != null`. `App.setMode` (`app.js:14`)
   already stops the previous tool (`app.js:26-27`) but **never clears
   `annoSelectedId`**. So after drawing a highlight and switching to Measure, the
   markup props bar stays up alongside the measure banner. Escape clears it because
   `app.js:424-430` routes Escape to a deselect. Requests 4 and 5 are one defect.

6. **Print preview performance** — `print.js` already lazy-renders thumbnails
   (`print.js:168`, `IntersectionObserver`, `rootMargin: '300px'`). Four
   candidate costs, in likely order:
   - `app.js:180` calls `App.Print.preview(bytes)` with the **fully exported**
     bytes — the entire pdf-lib bake runs before the modal can open.
   - `buildGrid` creates one tile + canvas per page up front (`print.js:172-191`);
     a 200-sheet set is 200 canvases before anything renders.
   - **No concurrency cap**: `onVisible` (`print.js:102`) calls `renderThumb` for
     every intersecting tile at once. With `rootMargin: 300px` over a grid of small
     tiles, dozens of dense plan sheets can render simultaneously on the main thread.
   - `cleanup()` (`print.js:200`) destroys the doc but does not `.cancel()`
     in-flight PDF.js render tasks.

**Regression surface (smoke scenarios that touch this work):** `SMOKE_MKPRESET`
(clicks a colour preset with nothing selected and asserts `App.state.annoStyle.stroke`
— survives a prospective-colour fix), `SMOKE_MCOLOR`, `SMOKE_RAIL`,
`SMOKE_PRINTPREVIEW`, `SMOKE_ORGANIZE`, `SMOKE_MARKUP`, `SMOKE_SELECT`.

## 4. Prior art

Bluebeam Revu and Adobe Acrobat both dock a page-thumbnail navigator on the **left**
and put bookmarks in the same left panel as a sibling tab — which matches request 2's
"on the left hand side" and suggests bookmarks and thumbnails may want to share one
panel rather than being two features. Both also treat a style change as prospective
when a drawing tool is armed and retroactive only when an object is explicitly
selected, which is exactly the distinction request 4 is asking for.

## 5. Recommended building blocks

Everything needed is already in the repo; **no new dependency is warranted**.

- Thumbnails: extract the lazy-render pattern already in `organize.js:117-153`
  rather than writing a third one. Rejected: a new thumbnail library — the app is
  offline-only and PDF.js already renders.
- Persistence: `App.Prefs` keyed by file path, following `recent-files.js`.
  Rejected: a new store — would need a `window.api` method on both platforms,
  violating the cross-platform rule for no gain.
- Print throughput: a small promise queue capping concurrent `renderThumb` calls.
  Rejected: web workers — PDF.js canvas rendering needs the main thread here.

## 6. Constraints and risks

- **Cross-platform rule** (`CLAUDE.md`): all six are renderer-only (Tier A). None
  needs a new `window.api` method. This must stay true.
- A left-docked panel is a **new layout convention** — every existing panel docks
  right. It will interact with `--rail-w`, split view (`body.has-split`), and the
  mobile bottom-bar layout below 821px.
- Requests 3 and 2 fight each other: a narrower rail plus a new left panel both
  consume horizontal space on the same edge.
- Changing selection-after-draw (request 4/5) touches the most-used code path in
  the app. It is also what makes "draw then immediately nudge/delete" work, so
  removing it outright would be a regression of its own.
- Print work is a **performance** change with no visible output, so it needs a
  before/after measurement to prove anything, and none exists today.

## 7. Open questions for the Spec Designer

1. **"Under the pages button"** — there is no Pages button. Today it is Document ▸
   Organize Pages…. Should the panel be a new top-level Pages rail group, a second
   item in the Document menu, or should bookmarks + thumbnails share one left panel
   (the Bluebeam/Acrobat pattern)?
2. **Bookmark semantics** — one bookmark per document or many? Keyed by file path?
   What happens on Save As, on a document opened from a different path, and across
   the multiple tabs `tabs.js` supports?
3. **"Smaller" rail** — narrower (`--rail-w` below 148px), shorter buttons (below
   38px), or default to the existing collapsed 56px state? A collapse toggle
   already ships.
4. **Retroactive colour** — three candidate fixes: (a) stop auto-selecting on
   finalize, (b) keep selection but make `applyStyle` prospective while a markup
   tool is armed, (c) clear selection on tool switch only. (b) fixes request 4
   without losing draw-then-nudge; (c) alone fixes request 5 but not 4.
5. **Print** — is the stall in the pdf-lib export or the thumbnail render? Should be
   measured before anything is optimised, so the spec can carry a real target
   number instead of "faster".
6. **Scope** — six requests is a large single build. Is this one pipeline run, or
   should the defect pair (4+5) ship first as a fix and the rest follow?
