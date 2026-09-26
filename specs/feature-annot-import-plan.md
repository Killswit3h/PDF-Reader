# Plan: Make other apps' annotations editable

**Phase 3 (dev-project-manager) · slug `annot-import` · branch `feat/annot-import`**

Stack as detected: vanilla JS on the global `App`, PDF.js 3.11 + pdf-lib, no new
dependencies. Renderer-only, so it ships to Windows, macOS and Android unchanged.

## Approach

Removing each converted original from the **working document** is the single
fix for double draw (FR-4), duplicate on save (FR-5) and reopen (FR-7): save.js
and the sidecar base both build from `App.state.pdfBytes`, so neither changes.
PDF.js 3.11 only honours per-annotation `noView` in `ENABLE_STORAGE` mode, which
would break interactive forms, so hiding at render time was ruled out.

## Tasks

| # | File | Change | FR |
|---|------|--------|----|
| 1 | `src/shared/annot-import.js` (new) | Pure mapping: descriptor + `toVP` -> markups; importable filter; colour and `/DA` parsing | FR-3, FR-6 |
| 2 | `src/renderer/js/annotimport.js` (new) | pdf-lib read of `/Annots`, strip originals (+ their popups), in-place document swap keeping marks/view/form values, `scan`, `importAll`, `sync` for undo | FR-1, 2, 4, 5 |
| 3 | `history.js` | `annotImportIds` in the snapshot; `sync()` after undo/redo | FR-2 |
| 4 | `tabs.js`, `viewer.js` | Per-document state fields; scan after open | FR-1, FR-7 |
| 5 | `index.html`, `styles.css`, `markup.js`, `app.js` | "Make editable" banner in the Markups List; read-only "From:" in rows (D4) | FR-1, D4 |
| 6 | `test/unit/annot-import.test.js` | Mapping for every subtype, 0 and 90 degree pages | acceptance |
| 7 | `src/main.js` `SMOKE_ANNOT_IMPORT`, `test/e2e/run.js` | Export, strip sidecar, add Stamp, reopen, import, undo/redo, save, reopen | acceptance |
