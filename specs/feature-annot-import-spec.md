# Spec: Make other apps' annotations editable

**Phase 2 (spec-designer) · slug `annot-import` · type: feature · status: APPROVED 9/25/2026 (D1-D4 as recommended)**

## Problem

A drawing marked up in Bluebeam, Acrobat or Preview opens in FieldMark with
those marks visible but frozen. A PM cannot move a cloud, fix a typo in a
callout, or delete a stale mark without going back to the other app.

## Goal

On request, turn the supported annotations in the open document into normal
FieldMark markups that can be selected, moved, restyled and deleted, with no
double draw and no duplicate on save.

## Decisions for Pedro (recommended default in bold)

| # | Question | Options |
| --- | --- | --- |
| D1 | When does import run? | **On request: a "Make markups editable" button in the Markups List, shown only when the file has foreign annotations** / automatically on every open |
| D2 | What happens to originals on save? | **Replaced: the edited mark is written back as a FieldMark annotation and the original is removed** / kept alongside (causes duplicates, not recommended) |
| D3 | Foreign measurements (Bluebeam length/area with `/Measure`) | **Stay native, not imported, in v1** / import as plain shapes (loses the takeoff value) |
| D4 | Author name on imported marks | **Kept in the Markups List as read-only "From: Name", not re-exported (FieldMark exports anonymously)** / dropped |

The rest of this spec assumes the bold defaults.

## Functional requirements

**FR-1: Detect.** On open, after the sidecar step, count annotations of the
supported subtypes (FR-3) that are not FieldMark's own (no sidecar ownership).
If the count is above zero, the Markups List shows
"N markups from another app. Make editable" with a button. Nothing changes in
the document until the button is pressed.

**FR-2: Import.** Pressing the button converts every supported annotation on
every page into an entry in `App.state.annotations` (types `rect`, `ellipse`,
`line`/`arrow`, `polyline`, `polygon`, `cloud`, `ink`, `texthighlight`,
`underline`, `strikeout`, `text`, `callout`), keeping stroke color, fill,
width, opacity and `/Contents` as the comment. One undo step reverts the whole
import.

**FR-3: Supported subtypes.** Square, Circle, Line (with `/LE` arrowheads),
PolyLine and Polygon without `/Measure`, Polygon with `/BE` cloud, Ink,
Highlight, Underline, StrikeOut, FreeText (plain text and callout). Anything
else (Stamp, FileAttachment, Link, Widget, Popup, Redact, Sound, measurements,
annotations with `/IRT` replies or a locked `/F` flag) stays native and
untouched.

**FR-4: No double draw.** Each imported original is hidden from the PDF.js
render for the rest of the session, so only the editable copy is visible.

**FR-5: Replace on save.** On save, each imported original is removed from the
page's `/Annots` and the markup is written through the existing
`writeRealAnnot` / `writeTextMarkupAnnot` path (or flattened when editable
annotations are turned off). Non-imported annotations are copied unchanged.
Popups whose parent was imported are removed with it.

**FR-6: Geometry.** All import coordinates go through the page's scale-1
PDF.js viewport `convertToViewportPoint`, the inverse of the export path.
Rotated pages (90/180/270) import in the right place.

**FR-7: Reopen.** A file saved after an import reopens through the normal
sidecar path with every mark editable; the imported marks are not offered for
import a second time.

## Non-goals (v1)

- Importing foreign measurements as FieldMark measurements (backlog).
- Rich text (`/RC`) formatting, dash patterns, reply threads, custom columns.
- Automatic import on open.
- Any change to how FieldMark's own marks save or reopen.

## Acceptance checks

- **Vitest** (`test/unit/annot-import.test.js`): pure mapping in
  `src/shared/` from a PDF.js annotation object plus a viewport transform to a
  markup, for every FR-3 subtype, on 0 and 90 degree pages.
- **`SMOKE_ANNOT_IMPORT`** in `src/main.js`, asserted in `test/e2e/run.js`:
  export marks of every supported type with the sidecar stripped (a foreign
  file stand-in), reopen, import, and check type, page and points within
  0.5 pt; save again and check each page's `/Annots` count equals the markup
  count (no duplicates) and a Stamp annotation survives unchanged.
- `npm run verify` and `npm run verify:web` pass.

## Notes from the build

- **Box tolerance.** FieldMark's own export pads `/Rect` by 2 pt, so a FieldMark
  file whose sidecar was stripped brings Square/Circle back 1 pt larger per side
  and FreeText 2 pt. The smoke check allows 2 pt for those three and 0.5 pt for
  everything else (vertex shapes, quads and the callout tip come back exact).
  Foreign files are read by `/RD` or half the border width, which is what
  Acrobat and Bluebeam write.
- **Callout box without `/RD`.** Acrobat and Bluebeam write `/RD` for callouts, so
  the box is exact. A callout with no `/RD` (FieldMark's own export) gets a box
  covering the whole `/Rect`, leader included; the tip is exact.
- **Exact count (FR-1).** pdf.js does not expose `/Measure` or `/IT`, so the offer
  count is confirmed with a pdf-lib read whenever pdf.js finds any candidates.
  A takeoff file is not offered markups it cannot convert.
