# Build plan — Page bookmarks

Phase 3. Implements `feature-bookmarks-spec.md`. Renderer-only, no new
dependencies. `pdf-lib` has no outline API, so the `/Outlines` tree is assembled
from `PDFDict` / `PDFArray` / `PDFRef` the same way `save.js` already assembles
annotations.

## Shape of the change

A new `src/renderer/js/bookmarks.js` module owning read, write and UI, plus five
small edits elsewhere. Keeping the outline logic in one file matters: it is the
only place in the app that touches the document catalog.

## Integration contract

### `src/shared/outline.js` — new, pure, unit-tested

The tree arithmetic, kept out of the renderer so Node can test it. This is where
FR-11 is actually enforced.

- `flattenOutline(nodes, resolvePage)` → `[{ title, page, mine, path }]`, walking
  `items` recursively. Used to build the shelf.
- `toggleBookmark(list, page)` → a new list with our entry for `page` added or
  removed, leaving every foreign entry untouched.
- `mergeOutline(originalTree, ourPages)` → the tree to write: the original with
  its structure, titles and destinations intact, our tagged entries reconciled
  against `ourPages`. **The function AC-6 rests on.**

### `src/renderer/js/bookmarks.js` — new

- `Bookmarks.read(doc)` — `doc.getOutline()`, resolving each `dest` to a page
  (string → `getDestination`, array → first element → `getPageIndex`). Wrapped
  so an unreadable outline yields an empty shelf rather than blocking the open
  (error table).
- `Bookmarks.toggle()` — toggles `App.state.currentPage`, sets `state.dirty`
  (FR-13), refreshes button and shelf.
- `Bookmarks.isBookmarked(page)`, `Bookmarks.refreshButton()`.
- `Bookmarks.renderShelf()` — list rows, click → `App.Viewer.goToPage(n)`
  (`viewer.js:679`), empty-state text.
- `Bookmarks.writeOutline(pdfDoc, list)` — builds `/Outlines` on
  `pdfDoc.catalog`: `/First`, `/Last`, `/Count`, and per item `/Title`,
  `/Parent`, `/Dest [pageRef /Fit]`, `/Prev`, `/Next`. Our entries carry a
  private `/FieldMark true` so a later save can tell them apart. Page refs from
  `pdfDoc.getPage(i).ref`.

### `src/renderer/js/save.js`
- Call `Bookmarks.writeOutline` on `pdfDoc` **and on `baseDoc`** inside the
  sidecar block. Writing only the first is the #98 failure repeated — visible in
  Acrobat, gone on reopen here (FR-12).
- On failure, warn as the sidecar failure does rather than failing the save.

### `src/renderer/js/tabs.js`
- `freshState()` gains `bookmarks: []`; `Tabs.open` populates it from
  `Bookmarks.read(doc)` after the sidecar swap, so the base's outline is read,
  not the flattened copy's.

### `src/renderer/js/viewer.js`
- `eventBus.on('pagechanging')` (line 112) also calls
  `Bookmarks.refreshButton()` — this is FR-3.

### `src/renderer/index.html` + `styles.css`
- `<button id="btn-bookmark" class="tb-btn icon" data-overflow disabled>` right
  after `#btn-rotate` (line 155), plus a sprite icon and a shelf flyout
  registered through the existing `registerDropdown()` so the rail/menu
  exclusivity registry governs it. `.tb-btn.armed` already provides the lit
  state; no new state styling needed.

## Work order

| # | Task | FRs |
|---|---|---|
| 1 | `src/shared/outline.js` + unit tests, incl. the preserve-foreign-entries case | FR-11 |
| 2 | `Bookmarks.read` — both destination forms, unreadable outline tolerated | FR-9, FR-8 |
| 3 | Button, lit/dim state, page-change hook, dirty | FR-1..FR-4, FR-13 |
| 4 | Shelf: list, navigate, empty state | FR-5..FR-7 |
| 5 | `writeOutline` into output **and** base | FR-10, FR-12 |
| 6 | Per-tab state | FR-14 |
| 7 | Tests: unit, `SMOKE_BOOKMARK`, `verify:tools` outline assertion | AC-1..8 |

Task 1 lands first; everything else depends on its shape.

## Risk

**The catalog is shared ground.** `/Outlines` sits beside `/AcroForm`,
`/Names` (the sidecar attachments) and `/Pages`. A malformed tree — a broken
`/Prev`/`/Next` chain or a wrong `/Count` — can make a viewer reject the
document, not merely show no bookmarks. Mitigations: the tree is built by a pure
function that is unit-tested independently of pdf-lib; `verify:tools` reparses
the saved file and asserts the annotations, `/Measure` data and attachments are
all still intact afterwards.

**Second risk: writing the base.** It is easy to write the outline into the
exported document and forget the sidecar base, which produces a bug that passes
every check in another viewer and fails only on reopening here. AC-7 exists for
exactly that and drives the real tab open path.

## Test plan

**Unit** (`test/unit/outline.test.js`) — `flattenOutline` over a nested tree
including an unresolvable entry; `toggleBookmark` add/remove; and `mergeOutline`
proving foreign entries keep title, nesting and destination while ours are
added, removed and **not duplicated across repeated saves**.

**`SMOKE_BOOKMARK`** in `src/main.js` + `test/e2e/run.js`: toggle on page 3 and
assert the button state and dirty flag; move to page 4 and assert it dims; shelf
lists and navigates; save, reparse the bytes and confirm the `/Outlines` entry
resolves to the right page; reopen through `App.Viewer.load` and confirm the
bookmark is still there (AC-7).

**`verify:tools`** — assert the saved file still carries its annotations,
`/Measure` dictionaries and sidecar attachments with an outline present, so the
catalog write is proven not to disturb them.

**Gates** — `npm run verify`, `verify:web`, `verify:tools`.

## Branching

Fresh from `origin/main` (currently `194ef43`), branch `feat/bookmarks`. Draft PR
on PASS.
