# Build Plan — OCR + PDF Content Editing

**Phase 3 of the build pipeline.** Plans `specs/feature-content-edit-ocr-spec.md`.
Buildable scope in this PR: **Track A (OCR)**. Tracks B and C are outlined at the
end for their own later PRs.

## 1. Stack — detected, not chosen

No stack decision to make (per `CLAUDE.md`). Confirmed from `package.json` and the
source tree:

- Vanilla JS on a global `App` object, **no bundler**; modules are ordered
  `<script>` tags in `src/renderer/index.html`.
- PDF.js `3.11.174` (read/render), pdf-lib `1.17.1` (write).
- Electron `31.7.7` desktop; Capacitor `8.4.1` runs the *same* renderer in a
  WebView via `scripts/build-web.js` → `www/`.
- Tests: `vitest` over `src/shared/`, headless-Electron `SMOKE_*` harness,
  headless-Chromium web-parity harness.

New runtime dependencies: `tesseract.js` (`7.x`, Apache-2.0) and its
`tesseract.js-core` WASM peer, both vendored as static assets — **no new
`window.api` method, no new IPC, renderer-only** (NFR-16).

## 2. Architecture

### 2.1 Folder map (Track A)

```
src/renderer/js/ocr.js            NEW  engine lifecycle, page loop, UI driving
src/shared/ocr-layout.js          NEW  pure geometry/sizing math (vitest-tested)
src/renderer/index.html           MOD  <script> tags, OCR menu item, OCR modal
src/renderer/styles.css           MOD  OCR modal + progress styling
src/renderer/js/util.js           MOD  App.state.ocr
src/renderer/js/viewer.js         MOD  reset App.state.ocr in _clearState
src/renderer/js/app.js            MOD  menu wiring, enable/disable with doc state
src/renderer/js/platform-web.js   MOD  window.TESS_VENDOR for the web bundle
scripts/build-web.js              MOD  VENDOR entries + path rewrite + assets
scripts/verify-web.js             MOD  MIME types for .wasm/.gz + an OCR assertion
src/assets/tessdata/              NEW  eng.traineddata.gz (committed, ~2 MB)
src/main.js                       MOD  SMOKE_OCR scenario
test/e2e/run.js                   MOD  SMOKE_OCR assertion
test/unit/ocr-layout.test.js      NEW  vitest over the shared math
package.json                      MOD  dependencies
```

**`src/renderer/js/save.js` is NOT modified in Track A.** See ADR-2 — this is the
single most important regression-safety property of this plan.

### 2.2 Key decisions (ADR-style)

**ADR-1 — Vendor tesseract.js as static assets loaded by `<script>`, exactly like
pdf-lib.**
The renderer has no bundler, so a dependency is consumed by pointing a `<script>`
tag at its UMD build and reading the global it defines. `tesseract.js@7` ships
`dist/tesseract.min.js` (63 KB UMD → `window.Tesseract`) and `dist/worker.min.js`
(111 KB). Electron loads them from `../../node_modules/tesseract.js/dist/`;
`build-web.js` copies them to `www/vendor/tesseract/` and rewrites the path, the
same mechanism already used for pdf-lib, signature_pad and node-forge.
*Alternative rejected:* adding a bundler — a far larger change to a working,
deliberately bundler-free app.

**ADR-2 — OCR builds its own output document; it does not go through
`save.js:buildBytes`.**
`ocr.js` loads `App.state.pdfBytes` with pdf-lib, appends the invisible text
layer, and produces new bytes directly. Routing OCR through `buildBytes` would
flatten the user's live markups into the page as a side effect of running OCR,
and would entangle the feature with the shared save/print/sign path. Keeping OCR
out of `save.js` means **zero risk to save, print, sign, compare and the sidecar
round-trip** — items 1, 2, 9 and 11 of the regression boundary are untouched by
construction.
*Alternative rejected:* extending `buildBytes` with an OCR branch.

**ADR-3 — Recognized bytes are loaded back with `Tabs.replaceActive`, with marks
explicitly preserved.**
The page organizer already rebuilds the current document in place through
`Tabs.replaceActive` (`organize.js:280`), but it *warns that marks are lost*
because `_loadInto` calls `_clearState`. OCR must not lose marks (FR-A-12), so
`ocr.js` captures `App.Save.serializeModel()` before the swap and calls
`App.Viewer._rehydrate(model)` plus an overlay refresh after it. This reuses two
existing, already-tested functions rather than adding a new load path.
*Alternative rejected:* a bespoke "reload preserving state" function in
`viewer.js` — more new surface in the most safety-critical module.

**ADR-4 — The invisible text layer is written with the standard `Tr 3` + `Tz`
construction.**
For each recognized word: set text render mode 3 (invisible) via pdf-lib's
`setTextRenderingMode(TextRenderingMode.Invisible)`, choose a font size from the
word box height, then set horizontal scaling (`Tz`, pdf-lib's
`setCharacterSqueeze`) to `boxWidth / naturalWidth` so the invisible glyph run
spans exactly the width of the printed word. Without the `Tz` step, selection
highlights and find-match rectangles drift away from the ink they belong to.
Position comes from `viewport.convertToPdfPoint()` on a baseline anchor plus a
`+1pt` direction point for rotation — the identical technique `save.js:257-261`
already uses, which is what makes FR-A-11 (rotated pages) correct for free.
*Alternative rejected:* one `drawText` per line with no `Tz` — cheaper, but
misaligned selection is the top complaint about bad searchable PDFs.

**ADR-5 — The pure math lives in `src/shared/ocr-layout.js` and is unit-tested.**
Repo convention (`geometry.js`, `measure-math.js`, `print-layout.js`): pure logic
goes in `src/shared/` with a dual Node/browser export and vitest coverage, so it
is verified without booting Electron. `ocr-layout.js` owns: the raster-scale
solver for the FR-A-7 DPI/megapixel caps, tesseract-pixel → scale-1-viewport-point
conversion, the baseline anchor, and the `Tz` squeeze factor.

**ADR-6 — Cancel is free because the document is only rebuilt at the very end.**
Recognition accumulates into `App.state.ocr`; nothing touches the document until
every selected page is processed. Cancelling therefore leaves the open document
byte-identical by construction (FR-A-6 / AC-A-4) with no rollback logic.

**ADR-7 — Which core WASM files ship is determined empirically, then pinned.**
`tesseract.js-core@7` publishes `lstm`, `simd-lstm` and `relaxedsimd-lstm`
variants, each in both a single-file `.wasm.js` form and a smaller split
`.js` + `.wasm` pair. Which files tesseract.js actually requests depends on
`wasm-feature-detect` at runtime. Guessing risks a 404 on a user's device — the
worst possible failure for an offline app. Task P-2 therefore runs the engine,
records the exact requests, ships exactly those files, and asserts the total
against NFR-6 (≤ 12 MB). We ship LSTM-only variants (`oem: 1`); the legacy engine
is not used.

### 2.3 Integration contract

There is no server, no API and no auth in this app; the "contract" is the
in-renderer module surface and the asset paths.

**`App.OCR` (new, `src/renderer/js/ocr.js`)**

| Member | Shape | Purpose |
|---|---|---|
| `App.OCR.init()` | `() => void` | Wire the modal's controls. Called from the app boot sequence. |
| `App.OCR.open()` | `() => void` | Show the OCR dialog (FR-A-3). No-op with no document. |
| `App.OCR.run(opts)` | `({ scope:'page'\|'all', force:boolean }) => Promise<{recognized, skipped, failed, empty}>` | The whole run (FR-A-4…A-13). Also the programmatic entry point for `SMOKE_OCR`. |
| `App.OCR.cancel()` | `() => void` | Request stop after the current page (FR-A-6). |
| `App.OCR.isAvailable()` | `() => Promise<boolean>` | Engine assets load (FR-A-15). |
| `App.OCR._buildBytes(doc, ocrState)` | internal | pdf-lib write of the invisible layer; exposed for tests. |

**`App.OcrLayout` (new, `src/shared/ocr-layout.js`)** — pure, no DOM:

| Function | Shape |
|---|---|
| `rasterScale(vpWidth, vpHeight, maxDpi, maxPixels)` | `=> number` — the FR-A-7 solver |
| `wordToViewport(bbox, scale)` | `=> {vx, vy, vw, vh}` — tesseract px → scale-1 pts |
| `baselineY(box)` | `=> number` — baseline anchor within the word box |
| `squeeze(boxWidth, naturalWidth)` | `=> number` — `Tz` percentage |

**`App.state.ocr`** — per the spec's §8 data model. Reset in
`Viewer._clearState`.

**Asset paths.** `ocr.js` resolves a vendor base exactly as `viewer.js:31` does:

```
const TESS = window.TESS_VENDOR || '../../node_modules/tesseract.js/dist/';
const CORE = window.TESS_CORE   || '../../node_modules/tesseract.js-core/';
const LANG = window.TESS_LANG   || '../assets/tessdata/';
```

`platform-web.js` sets all three to their `www/` equivalents, alongside the
existing `window.PDFJS_VENDOR = 'vendor/pdfjs/'` (`platform-web.js:20`).
`corePath` is passed as a **directory**, never a single file — the tesseract.js
docs state that pinning one file causes much slower performance or outright
failure on some devices.

### 2.4 Security boundary

Offline app, no server, no auth. The threat model is local files and the CSP:

- No new `window.api` method; nothing crosses the file-I/O boundary (NFR-16).
- No network call at any point. tesseract.js defaults to a CDN for its worker,
  core and language data — **all three paths must be overridden**, and the
  absence of requests must be asserted, not assumed (NFR-7, AC-A-1).
- CSP must permit WASM. The existing policy is
  `script-src 'self' 'unsafe-eval'`, which already permits WebAssembly
  compilation in Chromium, and `worker-src 'self' blob:` already covers the
  worker. **The policy is therefore expected to need no change**; if it does,
  the only permitted addition is `'wasm-unsafe-eval'` and no remote origin
  (NFR-17).
- Recognized text stays in memory and in the saved file only (NFR-15).

## 3. Work orders

### Track P — Platform / build (do first; the renderer work depends on it)

| # | Task | FRs | Files |
|---|---|---|---|
| P-1 | Add `tesseract.js` + `tesseract.js-core` to `dependencies`; `npm install`; commit the lockfile. | FR-A-1 | `package.json`, `package-lock.json` |
| P-2 | Determine empirically which core files tesseract.js requests (log every fetch during one recognition), ship exactly those, and record the measured total. Assert ≤ 12 MB. | FR-A-1, NFR-6 | build notes in the plan |
| P-3 | Commit `eng.traineddata.gz` (tessdata_fast) to `src/assets/tessdata/`. `src/assets` is already copied wholesale to `www/assets` by `build-web.js:53`, so the web build gets it for free. | FR-A-1 | `src/assets/tessdata/eng.traineddata.gz` |
| P-4 | Add the tesseract files to the `VENDOR` list and add an `index.html` path-rewrite rule for `node_modules/tesseract.js/dist/` → `vendor/tesseract/`. | FR-A-1, NFR-13 | `scripts/build-web.js` |
| P-5 | Set `window.TESS_VENDOR` / `TESS_CORE` / `TESS_LANG` in the web adapter. | NFR-13 | `src/renderer/js/platform-web.js` |
| P-6 | Add `.wasm` and `.gz` to the verify-web static server's MIME map, serving `.gz` as `application/octet-stream` **without** `Content-Encoding: gzip` (the browser would otherwise silently decompress it and tesseract's own gunzip would fail). | AC-A-15 | `scripts/verify-web.js` |
| P-7 | Confirm whether the CSP needs `'wasm-unsafe-eval'`; change it only if proven necessary. | NFR-17 | `src/renderer/index.html` |

### Track F — Renderer / frontend

| # | Task | FRs | Files |
|---|---|---|---|
| F-1 | `src/shared/ocr-layout.js` with the four pure functions, dual Node/browser export per repo convention. | FR-A-7, A-10, A-11 | new |
| F-2 | Vitest coverage for F-1: raster caps at the boundary, viewport conversion, baseline, squeeze. | FR-A-7 | `test/unit/ocr-layout.test.js` |
| F-3 | `App.state.ocr` in `util.js`; reset it in `Viewer._clearState`. | §8 | `util.js`, `viewer.js` |
| F-4 | OCR modal markup (scope radios, force checkbox, progress bar, ARIA live region, Start/Cancel) + a "Recognize Text (OCR)" item in the Document menu, disabled with no document. | FR-A-3, A-17, NFR-10..12 | `index.html`, `app.js` |
| F-5 | Modal styling consistent with existing dialogs, in both themes. | NFR-12 | `styles.css` |
| F-6 | `ocr.js`: engine lifecycle — lazy `createWorker('eng', 1, {workerPath, corePath, langPath})`, reuse across pages, terminate on completion; `isAvailable()`. | FR-A-1, A-15 | new |
| F-7 | `ocr.js`: page loop — text-layer detection and skip, raster at the F-1 scale, recognize, confidence filter, per-page status, progress + cancel checks between pages. | FR-A-4..A-9, A-16 | `ocr.js` |
| F-8 | `ocr.js`: `_buildBytes` — pdf-lib invisible text layer per ADR-4, rotation-safe via `convertToPdfPoint`. | FR-A-10, A-11, A-14 | `ocr.js` |
| F-9 | `ocr.js`: swap in the recognized document via `Tabs.replaceActive`, preserving marks per ADR-3; set dirty; report the summary. | FR-A-12, A-13 | `ocr.js` |
| F-10 | Error paths E1–E7 with the exact user-visible strings from the spec's §5. | FR-A-15, A-16 | `ocr.js` |

### Track S — Security review (reviews as F/P land, not after)

| # | Task | FRs |
|---|---|---|
| S-1 | Verify no `window.api` method was added and nothing new crosses the file-I/O boundary. | NFR-16 |
| S-2 | Prove zero network requests during a full OCR run — assert it in the web harness by failing the run on any non-`localhost` request. | NFR-7, AC-A-1 |
| S-3 | Review the final CSP diff; reject any widening beyond WASM execution. | NFR-17 |
| S-4 | Review asset path construction for traversal/injection (paths are constants, but confirm no user input reaches them). | — |
| S-5 | Confirm recognized text is never written anywhere but the in-memory doc and the user's saved file. | NFR-15 |

### Track T — Test / verification

| # | Task | FRs |
|---|---|---|
| T-1 | `SMOKE_OCR` in `src/main.js`: build a synthetic "scan" in-renderer (draw a word to a canvas, embed the PNG in a one-page pdf-lib PDF), load it, run `App.OCR.run`, and emit JSON with the recognized word, the mark-preservation result, and the skip behaviour. Hermetic — needs no fixture file. | AC-A-6, A-9 |
| T-2 | Matching assertion in `test/e2e/run.js`. | NFR-14 |
| T-3 | OCR assertion in `scripts/verify-web.js` (engine initializes and recognizes in Chromium). | AC-A-15, NFR-13 |
| T-4 | Manual/scripted check of the rotated-page case (AC-A-8) and the D-size raster cap (AC-A-11). | AC-A-8, A-11 |

## 4. Build sequence

1. **P-1 → P-3** (dependencies + language data on disk). Blocks everything.
2. **F-1 + F-2** in parallel with **P-4 → P-6** — the shared math has no dependency
   on the vendoring, and the vendoring has none on the renderer.
3. **F-3 → F-6** (state, UI, engine lifecycle). **P-2 and P-7 are answered here**,
   the first time the engine actually runs.
4. **F-7 → F-9** (the recognition pipeline and the document swap). Sequential —
   each builds on the last.
5. **F-10** error paths.
6. **T-1 → T-3** coverage. **S-1 → S-5** review this and the preceding steps.
7. **T-4** and the full gate: `npm run verify` + `npm run verify:web`.

Commits: one Conventional Commit per completed work-order task, referencing its FR
numbers, per `.claude/skills/git-workflow/`. Branch `feat/ocr-text-recognition`
off `main`. **Never merged locally** — per `CLAUDE.md`, inspection PASS means open
a **draft PR** and stop.

## 5. Definition of done — Track A

- Every FR-A-1…A-17 is claimed by implemented code.
- Every AC-A-1…A-15 passes.
- `npm test`, `npm run test:e2e` and `npm run verify:web` are green.
- `SMOKE_OCR` exists in `src/main.js` with an assertion in `test/e2e/run.js`.
- The §7 regression boundary is exercised and unchanged — cheap here, because
  `save.js` is untouched (ADR-2).
- Added bundle size measured and ≤ 12 MB.
- Zero network requests proven, not assumed.
- A draft PR is open; nothing is merged to `main`.

## 6. Tracks B and C — outline for later PRs

Not built in this PR. Recorded so the sequencing decision is explicit.

**Track B — text content editing (`feat/content-edit-text`).** The engineering
core is a content-stream reader/writer, which should live in
`src/shared/content-stream.js` so it is vitest-testable without Electron:

1. **Decode.** Reach the page content stream through pdf-lib
   (`page.node.Contents()`), inflating Flate streams. Concatenate a page's
   multiple streams in order.
2. **Tokenize.** A PDF operator tokenizer producing an editable operator list,
   tracking text state (`Tf`, `Tm`, `Td`, `TD`, `T*`, `TL`, `Tc`, `Tw`, `Tz`,
   `Ts`, `Tr`) across `BT`/`ET`.
3. **Correspond.** Map each PDF.js `getTextContent()` item to its originating
   text-showing operator (`Tj`, `TJ`, `'`, `"`) by ordinal position within the
   page. This correspondence is the crux of the track and needs its own test
   matrix across simple fonts, Type0/Identity-H, and multi-stream pages.
4. **Re-encode.** Write the replacement string in the run's own font encoding —
   single-byte for simple fonts, glyph ids for composite ones. Where a needed
   glyph is absent from an embedded subset, fall back to a substituted standard
   font for that run and surface it to the user (FR-B-5), which is what Acrobat
   itself does when the original font is unavailable.
5. **Validate.** Re-parse the rewritten document with PDF.js and confirm the edit
   before accepting it; on any failure keep the original untouched (FR-B-8/9).
   This is the safety net that makes stream rewriting acceptable to ship.

Risk note carried forward from the brief: step 3 is where real-world PDFs will
fight back (marked content, Type3 fonts, nested form XObjects). The validation
gate in step 5 is what keeps a failure non-destructive.

**Track C — image/object editing (`feat/content-edit-objects`).** Builds directly
on the same tokenizer: locate `Do` operators for image XObjects and the `cm`
matrix preceding each, and rewrite that matrix to move/resize, or drop the
operator to delete. Smaller than Track B because there is no font or encoding
problem — which is why it is sequenced last rather than first.
