# Research Brief — Performance apparatus and baseline (Phase 0)

**Phase 1 (deep-researcher) · feature slug: `perf-phase0`**

The maintainer's full brief is `docs/perf/BRIEF.md`. This document covers only
Phase 0: build the measuring apparatus, take the baseline, wire the two missing
gates into CI. No product code changes.

## 1. What exists today

- **Fixtures.** `test/fixtures/make-fixtures.js` builds five PDFs, all US Letter
  or a handful of ANSI D pages with a title and a box. The largest is `big.pdf`
  at 12 Letter pages. Generation is not byte-deterministic: pdf-lib stamps the
  current date on every save.
- **Harnesses.** Three already drive the real renderer:
  - `test/e2e/run.js` spawns Electron per scenario with a `SMOKE_*` env var;
    `src/main.js` runs `webContents.executeJavaScript` and prints `[tag] {json}`.
  - `scripts/verify-web.js` serves `www/` and drives it in headless Chromium
    via `playwright-core` (an optional, `--no-save` harness dependency;
    `findChromium()` looks in `/opt/pw-browsers` first).
  - `scripts/verify-tools.js` does the same for the export contract.
- **No timing or memory assertion anywhere**, and no `bench/` directory.
- **CI (`.github/workflows/ci.yml`)** runs `npm test` on three OSes,
  `verify:pwa`, and the Electron e2e suite under Xvfb. `verify:web` runs only
  inside `android.yml`; `verify:tools` runs nowhere in CI.

## 2. The measurement points the probe needs

| Metric | Hook in the code |
|---|---|
| First page paint | `App.Viewer.load()` → `Tabs.open()` → PDF.js `pagerendered` on the event bus (`viewer.js`, `eventBus.on('pagerendered')`). `Viewer.init()` runs synchronously inside `load()`, so the bus exists immediately. |
| Pinch end → sharp | `Viewer.zoomPreviewBy()` rides a CSS transform; `Viewer.commitZoomPreview()` sets the real scale (`viewer.js`, "Smooth (preview) zoom"). Sharpness = `PDFPageView.renderingState === FINISHED (3)` polled per frame. |
| Long tasks during pan | `PerformanceObserver` `longtask` (Chromium, Electron) and `long-animation-frame` (Chromium 123+); Safari supports neither, so rAF frame gaps are recorded as the portable proxy. |
| Canvas bytes | Every `<canvas>` in the DOM, `width × height × 4`. PDF.js keeps its page canvases in the DOM under `#viewer .page`. |
| JS heap | `performance.memory` (Chromium/Electron only). |
| Markup ops | `App.Markup.repositionAll()`, `App.Markup.select(id)`, `App.History.undo()` are public. A drag goes through the real pointer path: `pointerdown` on the annotation's `.hit` SVG element (`markup.js` `startDrag`), `pointermove`/`pointerup` on `window`. The move handler defers the redraw to `K.scheduleReposition` (rAF), so main-thread work per move = synchronous handler + the rAF callback it scheduled. |

## 3. Fixture design constraints

- **Repo size.** 120 D sheets × 30k unique inline segments ≈ 40 MB compressed
  (measured: 337 KB/page for random segments, 144 KB/page for structured
  ones). PDF.js re-parses a form XObject on every page that references it
  (`PartialEvaluator.buildFormXObject` has no cross-page cache), so shared form
  XObjects placed with per-page transforms give the same per-page render and
  operator-list cost at ~25 KB/page. The stationing, labels and title block
  stay unique inline content. Result: 3.0 MB.
- **Scans.** 300 DPI on a D sheet is 6600 × 10200 px. 1-bit DeviceGray with
  deflate: ~100 KB/page for realistic sparse linework plus speckle. Each page
  gets its own image XObject so PDF.js's global image cache cannot share one
  decode. Result: 4.3 MB for 40 pages.
- **Sidecar.** `save.js` attaches `pdfsigner-model.json` (the
  `serializeMarkupModel` output) and `pdfsigner-base.pdf`; `tabs.js` reopens
  the base and applies the model. The heavy fixture uses the real
  `serializeMarkupModel` from `src/shared/markup-model.js` so it tracks the
  contract. Annotation and measurement shapes copied from `finalize()` in
  `markup.js` and `measure.js`; values from `App.computeValue`.
- **Determinism.** Seeded mulberry32 for every coordinate; pinned document
  and attachment dates. Verified: two consecutive generations produce
  identical SHA-256s.

## 4. Device runs

No iPad or Android tablet is reachable from this session. The apparatus
therefore includes `bench/serve.js`: serves the web build on the LAN with the
probe and a one-tap panel injected (same-origin, so the app's CSP is untouched)
and receives the result over POST. The tablet rows of the baseline stay
"pending device run" until the maintainer runs it; the desktop Chromium run also
has a `--tablet` shape (1024 × 1366, dpr 2, touch) that reproduces the canvas
budget a dpr 2 tablet would request, which is the mechanism Phase 1 targets.

## 5. Out of scope for Phase 0

Every product change in `docs/perf/BRIEF.md` Phases 1–8. The scanned-set fixture
is generated and committed but not yet driven by the probe (nothing in Phase 0's
metric list uses it; Phase 1's canvas budget and Phase 8's OCR/compare work do).
