# Research brief — Page bookmarks

Phase 1. Backlog items 1 ("Bookmark the current page") and 10 ("Real PDF
bookmarks with a side panel"), which recorded **contradictory** decisions —
app-local prefs in the older one, the real PDF outline in the newer. Resolved by
the repo owner: **real PDF bookmarks**, so they travel with the file and
bookmarks in received drawings are visible.

## What the user asked for

> a button next to the rotate button that allows you to click while you are on a
> specific page — highlights itself while you are on that page, then dims when
> you move to the next page. And also have a shelf that you can view all the
> bookmarked pages.

Simpler UI than backlog item 2's left-docked Pages+Bookmarks panel. That panel
is **not** in scope here; a dropdown shelf off the button is.

## What exists

**Nothing.** `grep` for outline handling returns only CSS `outline:` properties.
No read, no write, no state, no UI.

## Reading — well supported

pdf.js exposes everything needed:
- `doc.getOutline()` → a **nested tree**: `{ title, bold, italic, color, dest,
  url, items[] }`. Note `items` — an outline is a tree, not a list.
- `doc.getDestination(name)` resolves a named destination.
- `doc.getPageIndex(ref)` maps a destination's page ref to a 0-based index.

A destination is either a name (string) needing `getDestination`, or an explicit
array whose first element is the page ref. Both forms occur in the wild, so both
must be handled to read a client's drawing correctly.

## Writing — must be built by hand

`pdf-lib` has **no outline API**. `PDFDocument` exposes `catalog`
(`PDFCatalog`), so `/Outlines` has to be assembled from `PDFDict` / `PDFArray` /
`PDFRef` directly — the same technique `save.js` already uses for annotations,
so there is precedent in this codebase rather than new ground.

The `/Outlines` tree needs `/First`, `/Last`, `/Count`, and each item needs
`/Title`, `/Parent`, `/Dest`, and `/Prev` + `/Next` sibling links. Page refs come
from `pdfDoc.getPage(i).ref`.

## Three traps this feature can fall into

**1. The round-trip base swap — the #98 trap again.** On save, the flattened
output gets the marks; a *pristine base* is attached as the sidecar. On reopen,
`Tabs.open` swaps that base in as the working document. Bookmarks written only
into the exported document would therefore be **visible in Acrobat but gone when
reopened in FieldMark** — the exact shape of the bug fixed in #98. The outline
must be written into the base copy as well.

**2. Flattening someone else's outline.** A drawing set received from a client
may carry a real nested outline with meaningful titles. If bookmarks are modelled
as a flat list of page numbers and the outline is rewritten from it on save, that
structure is destroyed silently. Given this project's standing position on not
losing what the user did not ask to lose, the existing tree should be
**preserved**, with our own entries tagged by a private key (a non-standard key
in an outline item dict is ignored by other viewers) so repeated saves neither
duplicate nor clobber.

**3. Real bookmarks only exist once saved.** Unlike an app-local flag, a bookmark
is not durable until the file is written. Toggling one must mark the document
dirty so the existing unsaved-changes prompt covers it.

## Integration points

| Need | Where |
|---|---|
| Button beside Rotate | `index.html:155` (`#btn-rotate`, `.tb-btn icon`) |
| Lit/dim state | `.tb-btn.armed` already exists (`styles.css:78`) |
| Page-change hook | `viewer.js:112` — `eventBus.on('pagechanging')` |
| Shelf flyout | `registerDropdown()` in `app.js`, which the rail/menu exclusivity registry already governs |
| Per-document state | `tabs.js` `freshState()` — bookmarks are per tab |
| Survives reopen | `src/shared/markup-model.js` + the outline in the base |

## Open for the spec

- Titles for our entries. A bare `Page 12` is honest but unhelpful next to a real
  sheet list. Sheet numbers are not reliably extractable, so `Page N` is the
  safe default with renaming left to a follow-up.
- Whether the shelf lists only our bookmarks or the document's whole outline.
  Showing everything is more useful on a received drawing and costs nothing,
  since the tree is read anyway.
