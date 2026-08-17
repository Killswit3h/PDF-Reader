# Research Brief — OCR + PDF Content Editing ("edit any word/object/image")

**Phase 1 of the build pipeline.** Feature request, verbatim:

> "I want to be able to grab any PDF and OCR or edit any word/object/image etc to
> move things around, edit them, just like Adobe Acrobat has the option to."

Status: research only. No solution design, no code. Open questions at the end are
for the Spec Designer to resolve with the user.

---

## 1. Problem statement

FieldMark can put *new* things on a page — signatures, dates, text boxes, markups,
measurements, stamps — but it cannot touch what is *already* on the page. Text
that came with the PDF is selectable and copyable but not editable; embedded
images and logos cannot be moved, resized or deleted; and a scanned sheet (a
photo of a drawing, a faxed spec) has no text at all, so Find, copy and select do
nothing on it. The user wants the Acrobat experience: click a word and retype it,
drag a logo somewhere else, and run OCR on a scan so its words become real,
findable, editable text — all of it offline.

## 2. Users and jobs to be done

The app's user is a field/construction professional working on plan sets, specs
and forms, often offline on a laptop or Android tablet.

| Job | Today | Wanted |
|---|---|---|
| Fix a typo or stale value in a title block, revision note, or spec line | Cover it with a white markup rectangle and type a text box on top — two objects, manual alignment | Click the word, retype it |
| Move/remove a logo, detail image or a stamp baked into the sheet | Impossible | Drag it, resize it, delete it |
| Search a scanned drawing for a room number or detail tag | Find returns nothing — no text layer | OCR the page, then Find/select/copy works |
| Reuse text off a scan (paste a spec paragraph into an email) | Retype it by hand | Select and copy after OCR |
| Correct a word on a scanned sheet | Impossible | OCR, then edit the recognized word in place |

## 3. Existing codebase findings

Stack (from `package.json`): vanilla JS on a global `App` object, **no bundler**,
modules loaded as ordered `<script>` tags in `src/renderer/index.html`. PDF.js
`3.11.174` for reading/rendering, `pdf-lib 1.17.1` for writing, Electron `31.7.7`
desktop, Capacitor `8.4.1` Android/iOS. Tests: `vitest` over `src/shared/`, plus a
headless-Electron `SMOKE_*` harness and a headless-Chromium web-parity harness.

### 3.1 The overlay/geometry model — the feature's natural home

`src/renderer/js/viewer.js:328` (`syncPageEls`) attaches a `.markup-layer` div
inside each rendered PDF.js `.page` div. Every interactive object the app owns
lives in that layer. Geometry is stored in **scale-1 viewport points, top-left
origin** and drawn at `pt * App.state.zoom` (`viewer.js:26`, `cssScale()`), then
exported to PDF user space through `viewport.convertToPdfPoint()`
(`src/renderer/js/save.js:6-24`), which handles page `/Rotate` correctly. Page
rotation of the *layer* is a rigid CSS rotation inverted on input by
`Viewer.pointFromEvent` (`viewer.js:559`).

**Consequence: an editable "content object" is the same kind of thing the app
already has.** It needs no new coordinate system.

### 3.2 `placement.js` is a working template for exactly this interaction

`src/renderer/js/placement.js` already implements: a data record in scale-1
viewport points (`{id, type, page, vx, vy, vw, vh, ...}`), rebuild-from-data
rendering (`repositionAll`, `renderOne`), pointer drag (`startDrag:221`), corner
resize (`startResize:254`), inline `contenteditable` text editing
(`startDateEdit:295`), delete button, arrow-key nudge, copy/paste, and
`App.History.snapshot()` undo integration. Moving/resizing/retyping a *content*
object is the same interaction with a different source of truth.

### 3.3 The export path — and the hard limitation

`S.buildBytes()` in `src/renderer/js/save.js:187` loads `App.state.pdfBytes` with
`PDFDocument.load()` and **draws on top of** the existing page
(`page.drawImage`, `page.drawText`, `page.drawRectangle`, `drawSvgPath`). It
never modifies the page's existing content stream.

**pdf-lib cannot remove or rewrite existing page content.** It has no content-stream
parser; the community answer is to decompress the stream by hand and edit it
(see [pdf-lib discussion #1627](https://github.com/Hopding/pdf-lib/discussions/1627)).
Doing that correctly requires handling `Tj`/`TJ`/`'`/`"` operators, subset fonts
with custom `/Encoding` and CMaps, kerning arrays, and re-embedding a font that
has the new glyphs. That is a project, not a task.

**Therefore "editing" existing content must be patch-and-redraw**: cover the
original region with a rectangle filled to match the page background, then draw
the replacement text/image at its new position. This is the only approach
available within the repo's existing dependencies, and — see §4 — it is broadly
what non-Acrobat tools ship.

### 3.4 What PDF.js already gives us (confirmed in the installed version)

- `page.getTextContent()` → `{ items: [{ str, dir, transform:[a,b,c,d,e,f], width,
  height, fontName, hasEOL }], styles: { [fontName]: { fontFamily, ascent,
  descent, vertical } } }` — verified in
  `node_modules/pdfjs-dist/types/src/display/api.d.ts:253-300`. The `transform`
  matrix gives each run's exact position and size in viewport space; `styles`
  gives the font family. This is enough to draw a selectable box over every text
  run on a page.
- `page.getOperatorList()` → `{ fnArray, argsArray }` with `OPS.paintImageXObject`
  / `OPS.paintInlineImageXObject` preceded by the CTM, and `page.objs.get(name)`
  for the decoded bitmap. This is enough to locate and lift embedded images.
- The text layer is already rendered and selectable (`textLayerMode: 1`,
  `viewer.js:77`), and `src/renderer/js/textcopy.js` already reads selections out
  of `.textLayer`.

### 3.5 The editable round-trip already exists and should carry content edits

On save, `save.js:444-460` attaches a JSON model of every mark
(`S.serializeModel`) plus a pristine copy of the base PDF, under the names in
`App.SIDECAR` (`src/renderer/js/util.js:11`). On open, `Viewer._readSidecar` /
`Viewer._rehydrate` (`viewer.js:402-433`) reopen the pristine base and restore the
marks as live objects. **Content edits should ride this same mechanism** — a new
array in the model — so an edited word stays editable after save→reopen instead
of being permanently burned in. `Viewer._clearState` (`viewer.js:518`) is where a
new state array must also be reset.

### 3.6 Cross-platform + build integration points

Per `CLAUDE.md`, Android runs the desktop renderer verbatim. `scripts/build-web.js`
copies `src/renderer/` + `src/shared/` into `www/` and has an explicit `VENDOR`
allow-list of library files to copy (`build-web.js:56-64`) plus path-rewrite
regexes for `index.html` (`build-web.js:86-92`). **Any new vendored library must
be added to `VENDOR` and given a rewrite rule, or the Android/web build silently
ships a broken feature.**

CSP (`src/renderer/index.html:7`):
`script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data:;`
`'unsafe-eval'` permits WebAssembly compilation in Chromium, and `worker-src`
already allows `blob:`, so a WASM OCR engine in a worker is compatible in
principle — **must be verified on the real Android WebView, not assumed.**

### 3.7 Files this feature will touch (predicted)

| File | Why |
|---|---|
| `src/renderer/js/` (new module(s), e.g. `content.js`, `ocr.js`) | The feature itself |
| `src/renderer/index.html` | Script tags, tool-rail entry, any modal |
| `src/renderer/styles.css` | Content-object chrome (selection box, handles) |
| `src/renderer/js/util.js` | New `App.state` arrays + sequence counters |
| `src/renderer/js/viewer.js` | `_clearState`, `_rehydrate`, overlay refresh hookup |
| `src/renderer/js/save.js` | Patch + redraw on export; serialize into the sidecar model |
| `src/renderer/js/app.js` | Mode wiring, toolbar/keyboard |
| `scripts/build-web.js` | `VENDOR` entries + path rewrites for the OCR assets |
| `src/main.js` + `test/e2e/run.js` | New `SMOKE_*` scenarios (repo rule) |
| `package.json` | New dependency (OCR engine + core + language data) |

**Not touched / must not regress:** `measure.js`, `markup.js`, `organize.js`,
`docstamp.js`, `digisign.js`, `compare.js`, `overlay.js`, `print.js`, tabs, and the
existing save/round-trip behaviour.

## 4. Prior art

**Adobe Acrobat** splits this into two distinct tools, and it is worth copying the
split: *Scan & OCR* ("Recognize Text") converts a scan into searchable text, and
*Edit PDF* reconstructs text into editable blocks. Acrobat is explicit that
editing is best-effort and that the original font must be installed or embedded,
otherwise it substitutes — and it can only reflow within the block it detected
([Adobe: change, replace, or delete text](https://helpx.adobe.com/lv/acrobat/using/edit-pdfs-new-experience.html)).
Even the reference implementation is not "edit any word freely".

**What users complain about in that class of tool** (and what to avoid): text
reflowing unpredictably and destroying layout; the replacement font not matching
so the fix is visibly a patch; edits silently failing on scanned pages; and the
tool re-saving the whole document in a way that breaks signatures.

**Non-Acrobat JS/desktop tools** overwhelmingly do *not* rewrite content streams.
The common shipped model is: locate the region, white/背景-patch it, draw
replacement content on top. Libraries in the JS ecosystem (`pdf-lib`,
`pdfkit`) offer no content-stream editing at all; the ones that do
(commercial: IronPDF, Syncfusion, iText) are server-side, licensed, and not
options for an offline MIT Electron/Capacitor app.

**What to copy:**
- Acrobat's two-tool split (OCR ≠ Edit) — they have different failure modes and
  different UI.
- Acrobat's honesty: show the user when a font could not be matched.
- OCR producing an *invisible* text layer over the scan (render mode `Tr 3`), the
  standard "searchable PDF" construction, so Find/copy work without changing how
  the page looks.

**What to avoid:**
- Promising Word-like reflow. Scope to the run/line that was clicked.
- Patching with hardcoded white. On a coloured or scanned background that leaves a
  visible white scar — sample the actual local background instead.
- Burning edits in irreversibly. Ride the existing sidecar so they stay editable.

## 5. Recommended building blocks

| Need | Recommendation | Why | Rejected alternative |
|---|---|---|---|
| OCR engine | **tesseract.js** (`7.0.0`) + `tesseract.js-core` (`6.1.2`), fully self-hosted | The only mature, offline, permissive-licence (Apache-2.0) OCR that runs in both Electron and an Android WebView. WASM + worker, matches the existing CSP. | Cloud OCR (Google/Azure/AWS) — violates the project's absolute no-network rule. |
| Language data | `tessdata_fast` `eng.traineddata`, gzipped | ~4.1 MB raw / ~2 MB gzipped, vs. the `best` set which is several times larger for accuracy that does not pay off on drawings. tesseract.js resolves `langPath + lang + '.traineddata.gz'`. | `tessdata_best` — too large for an APK for marginal gain. |
| Text/object discovery | **PDF.js `getTextContent()` + `getOperatorList()`** — already a dependency | Zero new dependencies; gives exact transforms; already loaded and warm. | Writing a content-stream parser — large, fragile, out of scope (see §3.3). |
| Rendering the editable object | **The existing `.markup-layer` + `placement.js` interaction pattern** | Drag/resize/inline-edit/undo/rotation-safety already solved and tested. | A new canvas-based editor — duplicates solved problems, breaks rotation handling. |
| Export | **pdf-lib patch rectangle + `drawText`/`drawImage`**, in `save.js` | Only mechanism available; already the path every other feature uses. | Content-stream rewriting — see §3.3. |
| Persistence | **The existing `App.SIDECAR` round-trip** | Keeps edits live across save→reopen, consistent with every other mark. | A separate file — breaks the single-file offline model. |

**Offline wiring for tesseract.js** (from the
[local-installation doc](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)):
`createWorker(lang, oem, { workerPath, corePath, langPath })`. `corePath` must be a
**directory** (not a file) containing the core `.wasm.js` variants so the library
can pick SIMD vs non-SIMD per device; pointing it at a single file is documented
as causing much slower performance or outright failure on some devices. Measured
sizes: `tesseract-core-simd-lstm.wasm.js` ≈ **3.95 MB**; shipping the LSTM
SIMD + non-SIMD pair ≈ **8 MB**, plus ≈ **2 MB** of gzipped English data →
**≈ 10 MB added to the desktop installers and the APK.**

## 6. Constraints and risks

| # | Risk | Severity | Notes |
|---|---|---|---|
| R1 | **"Edit any word" is not achievable as literally stated.** Content streams cannot be rewritten with the current toolchain; edits are patch-and-redraw. | **High — scope-defining** | Must be stated plainly in the spec so the delivered feature is not mis-sold. Acrobat itself is best-effort (§4). |
| R2 | Patch colour on non-white backgrounds leaves a visible scar. | High | Mitigation: sample the rendered page canvas around the run's bbox and fill with the sampled background. Fails on gradients/patterns/linework running through the text — must be an accepted, documented limitation. |
| R3 | Font matching. The original is usually a subset-embedded font; pdf-lib can only redraw in an embedded or standard font. Replacement text will not be pixel-identical. | High | Mitigation: map the PDF.js `styles[].fontFamily` to the nearest of the three standard families already supported in `save.js:202`. Tell the user when a substitution happened. |
| R4 | +10 MB to installers and APK. | Medium | Non-negotiable for true offline OCR. Options: bundle always, or make the OCR pack an optional download (breaks "offline" on first use). **User decision.** |
| R5 | OCR speed/memory on an Android tablet. A D-size sheet at OCR-grade DPI is a very large bitmap; WASM has a memory ceiling. | Medium | Mitigation: cap the render DPI, OCR one page at a time, run in a worker, show progress and allow cancel. Needs measurement on a real device. |
| R6 | Regression risk to the save path. `save.js:buildBytes` is shared by save, print, sign and compare. | Medium | Content-edit drawing must be additive and skipped entirely when there are no content edits. Signing (`opts.noSidecar`) must stay correct. |
| R7 | Vector "objects" (linework, a logo drawn as paths) are not addressable the way text runs and image XObjects are. | Medium | Honest scope: v1 addresses **text runs** and **image XObjects**. Arbitrary vector art is out. |
| R8 | Android WebView WASM under the app's CSP is unverified. | Medium | Must be proven by the web-parity harness (`npm run verify:web`) plus a real-device check before the feature is called done. |
| R9 | Editing content on a digitally-signed document invalidates the signature. | Low | The app already produces flattened, no-sidecar output when signing (`save.js:187`). Content editing must be blocked or warned on a signed doc. |
| R10 | Scope size. Realistically three features (OCR, text edit, object edit) in one request. | High | Should be staged; one PR per track, in dependency order. |

## 7. Open questions for the Spec Designer

1. **Scope staging (R10).** Ship as three sequential PRs — (A) OCR → searchable
   text layer, (B) edit/move/delete existing text runs, (C) move/resize/delete
   embedded images — or attempt one large PR? *Recommendation: three, in that
   order; A is independently valuable and is the prerequisite for editing scans.*
2. **The R1 tradeoff.** Confirm the user accepts patch-and-redraw semantics
   (edited text is a patch over the original, best-effort font match, may show on
   coloured backgrounds) as the definition of "edit". This is the single most
   important thing to get agreed before any code.
3. **OCR asset delivery (R4).** Bundle ~10 MB into every installer/APK, or make it
   an optional one-time download?
4. **Languages.** English only for v1, or a language picker?
5. **OCR output.** Invisible searchable text layer only, or also convert the
   recognized words into editable content objects immediately?
6. **Destructive vs. reversible.** Should content edits ride the sidecar and stay
   editable forever (consistent with the rest of the app), or be permanently
   flattened on save? *Recommendation: sidecar, consistent with every other mark.*
7. **Regression boundary.** Confirm the untouched list in §3.7 is complete.

---

*Sources:*
[tesseract.js local installation](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md) ·
[tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md) ·
[pdf-lib — modifying existing content](https://github.com/Hopding/pdf-lib/discussions/1627) ·
[Adobe Acrobat — change, replace, or delete text](https://helpx.adobe.com/lv/acrobat/using/edit-pdfs-new-experience.html)
