# Brief: Import other apps' PDF annotations as editable markups

**Phase 1 (deep-researcher) · slug `annot-import` · type: feature**

## What already works on main (v1.26.0)

- **FieldMark's own marks round-trip.** Save embeds a marks model plus a pristine
  base (`App.SIDECAR.MODEL` / `App.SIDECAR.BASE`). On open, `Viewer._loadInto`
  (`src/renderer/js/viewer.js`) reads the sidecar, reopens the base, and
  `_rehydrate` restores every mark as a live object (PR #98, v1.12.0).
- **Marks are saved as real PDF annotations** by default (`saveAnnots`, pref on)
  through `writeRealAnnot` / `writeTextMarkupAnnot` (`src/renderer/js/save.js`),
  and measurements carry a `/Measure` dictionary.
- **Other apps' annotations** (Bluebeam, Acrobat, Preview) are drawn by PDF.js
  from their appearance streams and kept untouched on save. They cannot be
  selected, moved, restyled or deleted in FieldMark.

## The gap

Only annotations made outside FieldMark, or FieldMark marks whose sidecar was
stripped by another app's re-save, are still stuck to the page. That is item 11
in `docs/feature-research.md`.

## Prior art: archived draft

`origin/archive/phase-2-4-interop-import:src/renderer/js/interop.js` has
`App.Interop.importFrom(pdfjsDoc)`: walk `page.getAnnotations()`, map
Square, Circle, Line, PolyLine, Polygon, Ink, Highlight, Underline, StrikeOut
and FreeText into `App.state.annotations` with `viewport.convertToViewportPoint`
on a scale-1 viewport. It is portable as-is for geometry. It never solved two
problems, and they are why this needs a spec:

1. **Double draw.** The original annotation stays in the page, so PDF.js paints
   it and the overlay paints the editable copy on top. Moving the copy leaves
   the original behind.
2. **Duplicate on save.** `writeRealAnnot` appends a new annotation while the
   original is still in `/Annots`, so the saved file holds both. In flatten mode
   the original stays live and the copy is burned in.

Both are fixed only by removing each imported original from the working
document (the pdf-lib copy used for save, and the PDF.js render). That is the
"originals get replaced" decision.

## What gets lost when an original is replaced

FieldMark's model has no place for: Bluebeam custom columns and subjects,
reply threads (`/IRT`), review state history, author (`/T`, FieldMark exports
anonymously by design), `/Measure` on a foreign measurement (becomes a plain
shape unless mapped to a FieldMark measurement), cloud intensity, dash
patterns, stamps, file attachments, sound, redact, and rich-text formatting in
FreeText (`/RC`). Anything unmapped must stay a native, untouched annotation.

## Coordinates

All import geometry goes through the page's scale-1 PDF.js viewport
(`convertToViewportPoint`), the exact inverse of the export path, so rotated
pages are handled without a hand-rolled Y-flip.
