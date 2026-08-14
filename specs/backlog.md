# Backlog

Deferred from the 2026-08-14 viewer UX pipeline run. Scope was split at the Phase 1
checkpoint: the defect pair plus the rail shipped first; these three follow in a
second run.

**These decisions are already made — run 2 should not re-ask them.**

## 1. Bookmark the current page (original request 1)

Button in the **top bar** (`#toolbar`), per the original request.

Decided: **many bookmarks per document, keyed by file path**, persisted in
`App.Prefs` following the `src/shared/recent-files.js` precedent, surviving restart.
The top-bar button toggles a bookmark on the current page; the panel below lists them
for jumping.

Open for run 2: behaviour on Save As, on a file reopened from a different path, and
across the multiple tabs `tabs.js` supports.

Building blocks: `App.Viewer.goToPage(n)` (`viewer.js:679`), `App.state.currentPage`.

## 2. Page-jump thumbnail panel (original request 2)

Decided: **one new left-docked panel with two tabs — Pages and Bookmarks** — so
requests 1 and 2 are a single surface, matching Bluebeam/Acrobat. Adds a new **Pages
group to the left rail** (there is no Pages button today; page operations currently
live under Document ▸ Organize Pages…).

Notes for run 2:
- This is a **new layout convention**: every existing panel docks right at 300–340px
  with a `body.has-*panel` class pulling `#viewer-wrap`'s `right` in
  (`styles.css:610`, `:1335`, `:615`). A left panel must also cooperate with
  `--rail-w`, `body.has-split`, and the mobile bottom bar below 821px.
- **Do not write a third thumbnail renderer.** `organize.js:117-153` already has the
  lazy `IntersectionObserver` grid, and `miniviewer.js` has a second one. Extract or
  reuse.
- It competes for the same screen edge as the now-narrower 124px rail.

## 3. Print preview performance on large plan sets (original request 6)

Symptom: a big multi-page plan with many small drawings stalls the whole app when
the print preview opens.

Four candidate costs found in Phase 1, in likely order — **measure before
optimising**, so the spec can carry a real target number:

1. `app.js:180` calls `App.Print.preview(bytes)` with the **fully exported** bytes,
   so the entire pdf-lib bake runs before the modal can open. Most likely culprit.
2. `print.js:172-191` builds one tile + canvas per page up front — 200 canvases for
   a 200-sheet set before anything renders.
3. **No concurrency cap**: `onVisible` (`print.js:102`) calls `renderThumb` for every
   intersecting tile at once, and `rootMargin: '300px'` over a grid of small tiles
   can put dozens of dense sheets into simultaneous main-thread render.
4. `cleanup()` (`print.js:200`) destroys the doc but never `.cancel()`s in-flight
   PDF.js render tasks.

Recommended building block: a small promise queue capping concurrent `renderThumb`
calls. Rejected: web workers — PDF.js canvas rendering needs the main thread here.

## Not requested, noticed during Phase 1

- **Thumbnail rendering is duplicated** between `organize.js` and `miniviewer.js`.
  A third copy is pending in item 2 above. Worth one extraction.
- `test/unit/pdf-sign.test.js` fails to load: `node-forge` is declared in
  `package.json` but missing from `node_modules`. Pre-existing, unrelated to this
  work, fixed by `npm install`.
