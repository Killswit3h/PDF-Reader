# FieldMark performance and field-usability overhaul — the brief

> Copied verbatim from the maintainer's brief on the first Phase 0 branch so
> future sessions have it. It was written against the repo at v1.25.0
> (pdfjs-dist 3.11.174, pdf-lib 1.17.1, Electron 31, Capacitor 8). File and
> line references are from that commit; re-verify them before editing.
> Progress and the numbers live next to this file: `00-baseline.md` first, then
> one report per phase.

You are the lead engineer on FieldMark (this repo). It is an offline PDF viewer, markup, and measurement tool for a fence, guardrail, and attenuator subcontractor doing FDOT work. Field users are superintendents and crew leads on iPads and Android tablets on the job site; office users run Electron on Mac and Windows. Plan sets are D-size and E-size vector sheets, 20 to 800 pages, dense CAD linework, often with scanned sheets mixed in. The competitor we are measured against is Bluebeam Revu.

Read `CLAUDE.md` first and follow it exactly: every phase is its own branch and draft PR, never merge to `main`, run `/new-feature` for each phase, vanilla JS on the global `App` object, no bundler, no React, no new dependency without a written rejection of the alternative, renderer-only features in `src/renderer/js/` and `src/shared/`, one `window.api` method in both `src/preload.js` and `src/renderer/js/platform-web.js` if you cross the file I/O boundary, and a `SMOKE_*` scenario plus `test/e2e/run.js` assertion for every new renderer behavior. `npm run verify` and `npm run verify:web` are the gates.

Two goals, in this order. First, make the app stay responsive and not lose work on large plan sets on a tablet. Second, make the markup workflow as fast and low-friction as Bluebeam's for a field user. Do not add features outside this brief. `specs/backlog.md`, `docs/feature-research.md`, and `docs/tool-parity.md` already scope redaction, volume measurement, snapshot export, annotation import, session restore, camera scan, the Pages panel, print-preview performance, diameter and chained arcs, bar-scale detection, and the change log. Do not re-plan those. Where this brief touches one of them, link to the backlog entry instead of restating it.

Stop and show me the Phase 0 report before writing any product code. After that, work phase by phase and ask me before any change that replaces PDF.js, changes the sidecar or markup-model schema in `src/shared/markup-model.js`, or adds a dependency over 50 KB gzipped.

## Phase 0: Instrument and baseline

There is no performance fixture, timing assertion, or memory assertion anywhere in the repo. The largest fixture is 12 Letter pages. Build the apparatus first.

1. Extend `test/fixtures/make-fixtures.js` to generate three committed fixtures: `dense-plans.pdf` (120 ANSI D pages, each with 30,000+ vector segments simulating guardrail runs, stationing ticks, and a title block), `scanned-set.pdf` (40 ANSI D pages of 300 DPI raster content), and `heavy-markup.pdf` (one ANSI D page plus a FieldMark sidecar carrying 2,000 markups spread across ink, polyline, cloud, rect, text, and 300 measurements). Keep generation deterministic.
2. Add a `bench/` runner that drives the web build in headless Chromium the way `scripts/verify-web.js` does, plus a `SMOKE_PERF` scenario for Electron, and reports: time to first page paint after open, time from pinch end to sharp re-render at 200% and 400% on `dense-plans.pdf`, longest task during a 3-second synthetic pan (use `PerformanceObserver` with `longtask` and, where supported, `long-animation-frame`), total canvas bytes (sum width × height × 4 over every canvas in the DOM), JS heap where available, and the time for `App.Markup.repositionAll()`, a select, a drag of 60 pointermove events, and an undo on `heavy-markup.pdf`.
3. Run it on desktop Chromium and on an iPad (Capacitor iOS build or Safari against the PWA build) and on one Android tablet. Write the numbers to `docs/perf/00-baseline.md`. Every later PR reports against these numbers in its description.
4. Add `verify:web` and `verify:tools` to `.github/workflows/ci.yml`; they are the only gates that cover the WebView and the export interop contract and they currently run only locally.

### Targets

* First page visible under 1.5 s on a 120 page dense set, warm, on an iPad.
* No long task over 100 ms during pan or pinch. Sharp re-render under 300 ms after a pinch ends at 400%.
* Total canvas memory under 200 MB on desktop and under 100 MB on iOS and Android, and no single canvas over 16.7 megapixels on any WebView.
* Select, drag frame, and undo under 16 ms of main-thread work with 2,000 markups on the page.
* Zero lost markups on app background, tab discard, WebView reload, or crash.

## Phase 1: Stop the tablet from blanking and leaking

1. `src/renderer/js/viewer.js:67-68` computes `maxCanvasPixels` as `min(2^28, 2^26 × dpr²)`, which resolves to 2^28 (about 1 GB per page canvas) on every dpr 2 tablet. WKWebView caps a single canvas near 16.7 MP and has a total canvas budget in the low hundreds of MB; over the cap the canvas silently goes blank. Replace the constant with a probe: allocate a test canvas at candidate sizes at startup, pick the largest that reads back a painted pixel, and cap at 2^24 on `pointer: coarse` regardless. Keep the desktop path as sharp as it is today. Add a SMOKE assertion that the chosen value on a simulated dpr 2 coarse-pointer run is at or below 2^24.
2. `src/renderer/js/tabs.js:178-195` closes a tab without calling `pdfDoc.destroy()` (every other module does, see `compare.js:164`, `overlay.js:218`, `organize.js:55`, `print.js:202`). Destroy the document and null out `pdfBytes` on close.
3. `src/renderer/js/viewer.js:391-395` makes two full copies of the incoming bytes and `App.state.pdfBytes` keeps a third for the document's life; the sidecar open path parses a fourth. Keep one copy. Hand PDF.js a transferable view and let pdf-lib reload from `pdfBytes` only at save time.
4. `src/renderer/js/history.js:27-31` stringifies every placement's base64 signature `dataUrl` into each of up to 60 snapshots per tab. Move image payloads to a side map keyed by content hash and snapshot only the key. Coalesce arrow-key nudges into one snapshot per 500 ms burst.
5. `src/renderer/js/snap.js` retains up to 400,000 vertex objects per harvested page and never evicts across pages. Keep the eight most recently used page grids and drop the rest.
6. `src/renderer/js/placement.js:245-251` and `290-296` register `pointerup` without `pointercancel`, leaking the `pointermove` listener on a cancelled touch. Fix.

## Phase 2: Autosave and recovery

There is no autosave, no crash journal, and no periodic snapshot. `App.state.dirty` only drives a prompt. A backgrounded iPad or an OOM kill loses the day's markups. This is the highest-severity gap in the product.

1. Serialize `App.serializeMarkupModel(App.state)` to IndexedDB (not localStorage; `src/shared/prefs.js:52-63` already shows the quota problem with stamps) keyed by a document fingerprint (file path if present, else a hash of the first 64 KB plus byte length). Write on a 750 ms debounce after any mutation, on `visibilitychange` to hidden, on `pagehide`, and on Capacitor `App.appStateChange` to background. Never block the UI on the write.
2. On open, if a journal exists for the fingerprint and is newer than the file's sidecar, offer a one-tap "Restore 47 unsaved markups from 2:14 PM" banner. Do not silently merge.
3. On the web and Capacitor builds, also cache the last eight opened documents' bytes in OPFS (worker sync access handles) so a set opened once reopens offline and survives a WebView reload. Electron keeps using the file path. Route the storage through one new `window.api` method implemented in both `preload.js` and `platform-web.js`, per `CLAUDE.md`.
4. Show a small pending indicator when the journal is newer than the last save, and keep both the creation time and the last-saved time on the model, the same way Bluebeam's Studio record keeps a creation timestamp separate from the upload timestamp.

## Phase 3: Markup overlay rebuild

`App.Markup.repositionAll()` (`markup.js:376-392`), `App.Measure.repositionAll()` (`measure.js:474-496`), and `App.Placement.repositionAll()` (`placement.js:111-119`) remove the page's SVG and rebuild every element plus every per-element `pointerdown` listener on every `pagerendered`, every `scalechanging` (called synchronously at `viewer.js:126`, not even rAF-coalesced), every select, and every undo. `measure.js:1090-1091` rebuilds every page and the whole panel on a single click. With 2,000 markups this is thousands of DOM nodes and listeners per frame.

1. Keep one persistent `<svg>` per page per layer. Diff by annotation id: create on first sight, update attributes in place on change, remove on delete. Only touch the page that changed; `doReposition` already accepts an `onlyPage` argument, make every caller use it.
2. Delegate `pointerdown` once on each SVG root and resolve the target by `data-id`, replacing the per-element closures at `markup.js:438, 449, 475, 541, 605` and `measure.js:523, 597, 646, 680`.
3. Memoize `smoothStroke` (`markup.js:59-62`, `geometry.js:128-146`) on the annotation object, invalidated when `pts` changes. Today the RDP simplify plus Catmull-Rom resample re-runs for every ink stroke on every redraw.
4. `markup.js:322-326` and `measure.js:1150-1165` rebuild the full candidate vertex array from every markup on the page on every `pointermove` during a drag, then scan it linearly. Build the candidates once at `startDrag`, or better, put markup vertices into the same cell grid `snap.js` already uses and query it. Add a small R-tree or reuse that grid for hit testing so selection does not depend on fat invisible stroke twins alone.
5. Route `scalechanging` through the same rAF coalescer as `pagerendered` (`viewer.js:383-387`).
6. `history.js:40-53` `apply()` calls `rerenderAll()`; make it accept the set of changed pages and rerender only those.
7. Measure before and after on `heavy-markup.pdf`. The pinch-preview architecture in `viewer.js:754-798` (CSS transform during the gesture, one sharp re-render 140 ms after it settles) is correct and stays.

## Phase 4: Snap and scale detection off the main thread

`snap.js:65-109` walks the full operator list of a page synchronously with no yield, up to 400,000 vertices, and is triggered from `measure.js:373` on every `handleMove`, so hovering an unharvested dense sheet freezes the UI for seconds.

1. Chunk the walk with the same `yieldToUI` pattern `scaledetect.js:42` already uses, or move the CTM walk into a dedicated worker that receives the operator list and returns typed arrays. Harvest the visible page on tool arm and the neighbors when idle, never from `handleMove`.
2. The CTM tracker handles `save`, `restore`, `transform`, and form XObjects only. Add `setGState` transform handling and skip inside tiling patterns and Type3 glyphs so snap points on form-heavy CAD exports do not land at wrong coordinates.
3. Keep snap to content vector-only and say so in the UI on scanned sheets, as Bluebeam does.

## Phase 5: Touch and pen input

Object drag, resize, and vertex edit already use Pointer Events on `window` and work on touch. Three things do not.

1. Text markup (highlight, underline, strikeout) ends on `document` `mouseup` at `markup.js:945` and never fires on touch. Switch to `pointerup` with a debounced `selectionchange` fallback.
2. Marquee zoom at `viewer.js:290, 302, 310-311` is mouse-only. Convert to Pointer Events. Right-button pan can stay mouse-only.
3. Pinch at `viewer.js:186-211` is raw Touch Events, so it does not work on a Surface or any Windows touchscreen in Electron. Add a Pointer Events path with the same `zoomPreviewBy` and `commitZoomPreview` calls.
4. Pen policy. `e.pointerType` is read in exactly one place (`tabs.js:456`). Implement Bluebeam's tablet rule: when a pen pointer has been seen in the last 2 s, `pointerType === 'pen'` draws and `pointerType === 'touch'` pans and pinches, and a touch `pointerdown` on the markup layer is ignored while a tool is armed. Without a pen, keep today's modal behavior but add a two-finger pan escape while a tool is armed. Map `e.pressure` to ink width within the tool's min/max, and consume `getCoalescedEvents()` on `pointermove` so fast strokes keep their samples. On WKWebView the OS blocks simultaneous pen plus finger input, so never design a gesture that needs both.
5. Ink grouping. Add a preference (default 700 ms) for how long after pen-up the app waits before committing an ink stroke, so multi-stroke handwriting becomes one markup, matching Bluebeam's "delay before markups are applied."
6. Touch targets. `styles.css:1595-1608` sets 40 px under `pointer: coarse` while the comment above it cites 48 px. Raise `.tb-btn`, `.mr-btn`, and the markup rail to 48 px. Selection handles are 8 × 8 SVG units (`markup.js:601-603`) and measure vertex handles r=6 (`measure.js:521`) and do not scale with zoom; size them by `1/zoom` with a 22 px coarse-pointer floor. The 74 px range sliders in `#markup-props` (`styles.css:1731-1743`) are not usable with a gloved finger; replace with stepper buttons plus a numeric field on coarse pointers.
7. Tooltips are gated on `hover` and `pointer: fine` (`tooltip.js`), so the icon-only rail has no labels on a tablet. Long-press shows the tooltip; this is already in `specs/backlog.md`, link to it and implement it here.

## Phase 6: Interop with Bluebeam and Acrobat

1. `save.js:81-170` `writeRealAnnot` writes rect, ellipse, line, arrow, polyline, polygon, cloud, ink, highlight, text, and callout with no `/AP` appearance stream, while `writeTextMarkupAnnot` (`save.js:249-253`) and `writeMeasureAnnot` (`save.js:444-449`) already generate one. `docs/tool-parity.md:70-78` states the standard and then eleven types miss it. Generate a form XObject `/AP` per subtype and extend `scripts/verify-tools.js` so the pixel-change assertion covers all fourteen types, not only text markups. Acrobat and Revu synthesize appearances for these subtypes, so today's files work in them, but many mobile and embedded viewers render nothing.
2. Add a private key on every annotation dictionary carrying FieldMark's own fields (subject, status, pay item, station, custom fields, measurement scale source) next to a document-level schema entry, the same shape Bluebeam uses for `/BSIColumnData`. Keep the standard keys valid so other viewers still render the markup. Preserve unknown keys on import so a round trip through Revu does not strip Bluebeam's data.
3. Sidecar cost. `save.js:891-909` embeds a full pristine copy of the base PDF in every save, roughly doubling an 80 MB plan set and forcing two full parses on reopen (`tabs.js:107-111`). When `saveAnnots` is on and there are no flattened placements, the output already is the editable document; skip the base attachment in that case. Coordinate this with the annotation-import item in `docs/feature-research.md` (#11), which is the long-term replacement for the sidecar.
4. Statuses. Add a `status` field to the markup model (Accepted, Rejected, Completed, Cancelled, None, plus custom) and write it as `/State` and `/StateModel` per ISO 32000 so Revu's Markups List picks it up. This is a schema change; ask me first.
5. Author. `specs/backlog.md:134-138` records the decision not to write `/T`. Leave that decision alone.

## Phase 7: Field workflow parity

1. Markups list. `markup.js:745-805` has filter, delete, and CSV but no status, author, sort, grouping, or totals. Make it a dockable panel with columns for page, subject, status, date, comments, and measurement value, sortable, with grouping and subtotals on measurement columns when sorted by subject (the Measurements panel at `measure.js:1063-1080` already computes totals per unit; reuse that). Tapping a row jumps to and selects the markup. One-tap status change on a selected markup.
2. Tool chest. `toolchest.js` stores tools in localStorage as a flat list with no sets, no import/export, and stamps as base64 that will hit the quota. Add named tool sets, JSON export and import through one `window.api` method, number keys 1 to 9 bound to the first nine tools of the active set on desktop, and move stamp images to IndexedDB with the tool holding a reference.
3. Sheet navigation. Detect the sheet number from a user-selected title block region on page one, apply the region to every page (text layer on vector sheets, the existing OCR on scans), and use the result as page labels in thumbnails, the page input, search, and bookmarks. This is Bluebeam's AutoMark. Depends on the Pages panel in `specs/backlog.md`; build the Pages panel first per that entry and do not write a fourth thumbnail renderer (organize.js, miniviewer.js, and print.js already have three).
4. Split view. `splitview.js` has a read-only right pane with no synchronized scroll. Add sync by page index and by current page, the two Bluebeam modes.
5. Dark mode for the sheet. Invert the page ground and recolor vector content by flipping lightness while keeping hue, leave embedded images alone. A CSS filter on the canvas with `mix-blend-mode` exclusion for image regions is acceptable as a first pass; measure its cost on the dense fixture.
6. Photos on markups. Attach a camera or library photo to a markup on Capacitor builds, store it beside the model, show it in the list, include it in the CSV and summary exports.
7. Spaces. Named polygons (station ranges, structure numbers) on a hidden layer; a markup inside is auto-tagged and the list gets a Space column. Optional, last.

## Phase 8: Compare, overlay, OCR, and search

1. `compare.js` and `overlay.js` render at a fixed 900 px width (about 40 DPI on a D sheet) and diff on the main thread with no alignment. Render at the viewer's current scale capped by the Phase 1 canvas budget, move the pixel loop to a worker, and add two-point manual alignment per layer.
2. `ocr.js` runs one Tesseract worker with no ETA and re-saves the whole document through pdf-lib at the end. Pool up to four workers where `crossOriginIsolated` allows it (Electron and Capacitor can; GitHub Pages cannot, see `specs/backlog.md:233-238`), show pages done and an ETA, OCR the title block region first so sheet numbers arrive before body text, and let the user cancel with partial results kept.
3. Search. `PDFFindController` re-walks every page's text on each query. Build a per-page text index once per document in a worker and store it with the OPFS cache from Phase 2 so sheet-number search on an 800 page set is instant and works from the first character.

## Working rules

* One branch and one draft PR per phase with before and after numbers from `bench/` in the description.
* Unit tests in `src/shared/` for every new pure function (coordinate transforms at 0/90/180/270, snap grid eviction, journal serialization, tool set import/export, `/AP` stream generation), and a `SMOKE_*` scenario for every renderer change.
* Keep every new behavior behind a preference flag until it beats the baseline on both desktop and a tablet.
* Copy this brief to `docs/perf/BRIEF.md` on the first branch so future sessions have it, and keep `docs/measurement-plan.md`'s status header current (Phase 6 there has shipped in `save.js:469-484` but the doc still says deferred).

Stop after Phase 0 and show me the baseline numbers.
