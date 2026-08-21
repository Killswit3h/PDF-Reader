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

## Mobile overflow sheet is outside the dropdown registry

`#more-menu` (the `<820px` header overflow sheet) dismisses via its own
`.g-more`-scoped document listener and is not registered with the `Dropdowns`
registry added in `feat/rail-menu-exclusivity`. Opening it therefore does not
close an open rail flyout and vice versa. Pre-existing; no visible overlap on
current layouts because the rail is a bottom bar at that breakpoint. Fold it
into `registerDropdown()` if the two ever collide.

## Radius measurement — 3-Point and Center Radius

Requested alongside the round-trip fix; to match Bluebeam, which ships two
separate tools. 3-Point Radius: click one end of the arc, a point along it, then
the other end; Revu draws a pie-piece and reports the radius. Center Radius:
click the centre then a point on the circumference, drawing a full circle by
default, or drag along the arc to draw only a section. Both should export as
calibrated dimension annotations the way the existing measure tools now do.

## Persist page orientation by baking /Rotate

Rotation is currently not stored anywhere — it is absent from the serialized
model. Decision taken: write `/Rotate` into the PDF page itself rather than
keeping it a view preference, so a corrected sheet opens the same way in every
application and for every recipient. Note this modifies the document, so it
wants a clear, undoable user action rather than silently persisting whatever the
Rotate button was last set to.

## Real PDF bookmarks with a side panel

No outline handling exists today. Decision taken: the real PDF outline, read and
written, not an app-local flag layer — so bookmarks in drawings received from
others are visible, and bookmarks added here travel to Acrobat and Revu.

## Independent per-pane rotation when comparing

Compare currently offers no rotation. Decision taken: each pane rotates on its
own, so a sheet scanned sideways can be aligned against one that was not.

## Zoom anchor accuracy

`Viewer.zoomToAt` already anchors at the cursor, and the Ctrl+wheel binding is
correct; the complaint is that the anchor drifts. Leading hypothesis: the anchor
is computed as `scrollLeft + offset` and scaled by the zoom ratio, which only
holds when content starts at the scroll origin. When a page is narrower than the
viewport pdf.js centres it, and that margin does not scale with zoom. Confirm
against the real viewer before changing the maths.

## Document change log

Requested during the round-trip work; deferred so the data-loss fix ships alone.
Decisions taken:

Scope is marks plus document operations — every markup and measurement added,
moved, restyled or deleted, and page-level events: reorder, rotate, insert,
delete, stamps and watermarks, signatures. Opens and saves are not logged.

Two halves, both required. The native half writes `/CreationDate` and `/M` on
every exported annotation, so Bluebeam and Acrobat show dates in their markup
list and update them when a recipient edits a mark; this is the only part that
survives the file being edited in other software. The FieldMark half is a
detailed panel backed by a record in the sidecar, covering what the native
fields cannot — deletions, before/after values, and document operations that are
not annotations.

No author identity. `/T` is deliberately omitted: the app has no accounts and
adding a name was declined. Consequence to keep in mind — marks made here are
anonymous, while Revu and Acrobat stamp their own user's name on anything they
create or edit, so a recipient's changes are attributable and the originals are
not. Combined with keeping the original file, Compare is the intended way to see
what a recipient altered.

Open question for its spec: the FieldMark half lives in the sidecar, which means
it inherits the sidecar's fragility — another tool rewriting the PDF drops it.
Decide then whether the log should also be exportable to a standalone file.
