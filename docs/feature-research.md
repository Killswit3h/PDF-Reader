# New Features — Cross-Platform Research & Build Plan

> **Scope of this doc.** A researched, prioritized menu of features to add next,
> written against the hard constraint that **every feature must ship on Windows,
> macOS *and* Android**. Each candidate is graded for cross-platform feasibility
> and mapped onto the *existing* architecture in `src/renderer/js/` (viewport-point
> storage, `viewport.convertToPdfPoint`, overlay `<div>`s, the pdf-lib export in
> `save.js`, and the `window.api` contract shared by `preload.js` +
> `platform-web.js`). Companion to `docs/measurement-plan.md`.
>
> **Status:** research + plan only. Nothing here is built yet.

---

## Part A — The cross-platform feasibility model (read this first)

The single most important architectural fact for planning features is this:

> **Android runs the desktop renderer verbatim.** `scripts/build-web.js` copies
> `src/renderer/`, `src/shared/`, the fonts, and the vendored PDF.js / pdf-lib /
> signature_pad into a self-contained `www/`, and Capacitor loads it in a
> WebView. The *only* platform-specific layer is file I/O, funnelled through the
> `window.api` surface (Electron IPC in `preload.js`; web/Capacitor shims in
> `src/renderer/js/platform-web.js`).

That yields a clean three-tier rule for "can we ship this everywhere?":

| Tier | What it touches | Cross-platform cost | Ships to all 3? |
|---|---|---|---|
| **A — Renderer-only** | Lives entirely in `src/renderer/js/` + `src/shared/` + `save.js`. No new `window.api` method. Draws on the overlay, computes with the vertices we already store, exports through the corner-mapping we already have. | **Zero per-platform work.** Write once, `build:web` carries it to Android, Electron carries it to Win/macOS. | ✅ Automatically |
| **B — One `window.api` method** | Needs a new capability behind the file-I/O boundary (print, persist a recent-files list, a bigger bundled asset). Add **one** method to *both* `preload.js` (Electron impl) and `platform-web.js` (web/Capacitor impl). | Small, bounded: implement the same method twice, keep the contract identical (the modules never branch on platform — see how `savePdfDialog` is done today). | ✅ With a small adapter |
| **C — Native platform plugin** | Needs a device capability with no web equivalent (camera scan, biometric lock, OS share-target registration). | Per-platform native code; **may not exist on desktop at all.** | ⚠️ Only with a parity plan |

**The planning consequence:** to honor "add it to macOS, Windows *and* Android,"
**lead with Tier A features.** They are the ones where the WebView-parity design
already pays off — you get three platforms for the price of one. Tier B is fine
in moderation. Tier C features must come with an explicit desktop-fallback story
or they quietly become "Android-only," which violates the constraint.

Every recommendation below is labelled **A / B / C** so the constraint is legible
at a glance.

---

## Part B — Feasibility matrix (ranked)

Effort is rough dev-days for a first shippable slice. "Reuses" points at the
existing code the feature extends rather than replaces.

| # | Feature | Tier | Win | macOS | Android | Effort | Reuses |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| 1 | **Page Organizer** (thumbnail sidebar: reorder / rotate / delete / insert / extract) | **A** | ✅ | ✅ | ✅ | 3–4d | pdf-lib in `save.js`; PDF.js render |
| 2 | **Merge & Split / Extract pages** | **B**¹ | ✅ | ✅ | ✅ | 2–3d | pdf-lib `copyPages`; #1's UI |
| 3 | **Fill interactive form fields (AcroForm)** | **A** | ✅ | ✅ | ✅ | 3–5d | PDF.js annotation layer; pdf-lib `PDFForm` |
| 4 | **Bookmarks / Outline nav + Thumbnail panel** | **A** | ✅ | ✅ | ✅ | 2d | PDF.js `getOutline()` |
| 5 | **Bates / page numbering, headers-footers, watermark** | **A** | ✅ | ✅ | ✅ | 2d | pdf-lib `drawText` loop in `save.js` |
| 6 | **Tool Chest** (save & reuse custom markups/stamps) | **A** | ✅ | ✅ | ✅ | 2–3d | `markup.js` + `App.Prefs` |
| 7 | **Redaction** (rasterize-to-remove; honest about limits) | **A** | ✅ | ✅ | ✅ | 3d | `markup.js` boxes; canvas + pdf-lib |
| 8 | **Volume/Depth · Radius/Diameter · Arc measurements** | **A** | ✅ | ✅ | ✅ | 2–3d | `measure.js` + `src/shared/geometry.js` |
| 9 | **Document Compare / Overlay** | **A** | ✅ | ✅ | ✅ | 3–4d | PDF.js canvas render; pixel diff |
| 10 | **Snapshot / export page(s) or region to PNG** | **A** | ✅ | ✅ | ✅ | 1d | canvas `toDataURL`; `saveBinary` |
| 11 | **Import existing PDF annotations for editing** | **A** | ✅ | ✅ | ✅ | 3–4d | PDF.js `getAnnotations`; `markup.js` |
| 12 | **Print** | **B** | ✅ | ✅ | ✅ | 1–2d | new `window.api.print` |
| 13 | **Recent files / session restore** | **B**² | ✅ | ✅ | ◑ | 1–2d | `App.Prefs`; needs a path on mobile |
| 14 | **OCR → searchable text layer** (tesseract.js, offline) | **B**³ | ✅ | ✅ | ✅ | 4–6d | PDF.js render → canvas; bundle wasm |
| 15 | **Camera "scan to PDF"** | **C** | ◑⁴ | ◑⁴ | ✅ | 3–5d | Capacitor plugin; desktop `getUserMedia` fallback |

¹ Renderer/pdf-lib logic is Tier A; only *multi-file open* wants a small picker
tweak, hence B. ² Full session restore needs a durable file path — desktop has
one, Android's picked-file URIs are ephemeral (◑ = partial). ³ Compute is
renderer-only, but the language data (~10–15 MB) inflates the bundle/APK, so treat
the packaging as adapter work. ⁴ No first-class desktop camera-scan; see Part D
for the parity plan.

---

## Part C — Recommended features (Tier A first; ship to all 3 for free)

These are the highest value-per-effort items **and** they clear the cross-platform
bar automatically because they never leave the renderer.

### 1. Page Organizer — thumbnail sidebar with reorder / rotate / delete / insert / extract  **(A)**
**Why:** it's the single most-requested capability this app lacks versus every
competitor (Acrobat "Organize Pages," Foxit, Xodo). Purely local, purely visual.

**How it slots in:**
- New panel `#pages-panel` (mirror the Markups List panel already in `index.html`).
  Render a thumbnail per page — PDF.js already rasterizes pages; draw each at low
  scale into a small `<canvas>`.
- Model: a `App.state.pageOrder = [origIndex, …]` plus per-entry `{rotate, deleted}`.
  All operations are list edits — no coordinate math.
- **Export in `save.js`:** today `buildBytes()` loads `App.state.pdfBytes` and stamps
  onto the *same* pages. Extend it to first build the output document from
  `pageOrder`: `pdfDoc.copyPages(src, order)` → new doc, apply `setRotation`, then
  run the existing placement/measurement/markup stamping against the reordered
  pages. The corner-mapping (`convertToPdfPoint`) is unchanged; only page identity
  is remapped.
- Drag-to-reorder is DOM drag-and-drop; works with touch on Android via the same
  pointer events the signature pad already handles.

**Cross-platform:** 100% renderer + pdf-lib. Zero `window.api` changes. ✅✅✅

### 2. Merge & Split / Extract  **(B, barely)**
**Why:** natural companion to #1; "combine these three PDFs," "pull pages 4–9 into
a new file."
- **Split/Extract** is pure Tier A: `copyPages(src, subset)` → new `PDFDocument` →
  `savePdfDialog`. Nothing new needed.
- **Merge** needs to *open a second file*. `window.api.openPdfDialog()` already
  exists on all three platforms; call it again to get the second document's bytes,
  `copyPages` from it, append. On desktop you could later add multi-select to the
  Electron dialog; on Android the picker is one-at-a-time, so a "＋ Add file" button
  that appends is the parity-friendly UX. Keep the flow identical on both — no
  branching in the module.

**Cross-platform:** ✅ (merge's only platform seam is the picker, which is already
abstracted).

### 3. Fill interactive form fields (AcroForm)  **(A)**
**Why:** huge real-world value (tax forms, applications, RFIs). Distinct from our
cosmetic text boxes — these are the document's *real* fields.
- **Rendering:** PDF.js (v84+) renders AcroForm widgets into its **annotation
  layer** as real HTML inputs; our vendored 3.11 build supports this. Enable the
  annotation-layer form mode in `viewer.js` and users can type into fields
  natively. PDF.js keeps edits in its `annotationStorage`.
- **Saving:** two paths, both via pdf-lib's `PDFForm`
  (`form.getTextField(name).setText(...)`, checkboxes, radio groups, dropdowns).
  Read PDF.js's `annotationStorage` values, write them into the pdf-lib form, then
  optionally `form.flatten()` to bake them. This runs in `save.js` alongside the
  existing stamping.

**Cross-platform:** the annotation layer and pdf-lib both run in the WebView →
identical on Android. ✅✅✅
**Watch-out:** XFA (LiveCycle dynamic) forms are a separate, harder beast — scope
to AcroForm and detect+message XFA, exactly as we already detect encrypted PDFs.

### 4. Bookmarks / outline navigation + persistent thumbnail rail  **(A)**
**Why:** essential for the "large plan set" use-case the README already sells.
- `pdfDoc.getOutline()` returns the document's bookmark tree; render it as a
  collapsible list that calls the existing page-navigation code on click.
- The thumbnail rail from #1 doubles as a visual navigator.

**Cross-platform:** pure PDF.js API in the renderer. ✅✅✅

### 5. Bates / page numbering, header-footer, watermark  **(A)**
**Why:** legal + construction workflows (Bates stamping is table-stakes for legal;
"CONFIDENTIAL"/"DRAFT" watermarks and sheet-number footers for AEC).
- All are a `for (page of pages) page.drawText(...)` loop in `save.js`, positioned
  with the corner-mapping already there. A small modal picks format
  (`PREFIX-000123`), start number, corner, font size, and page range.
- Watermark = the same `drawText` with rotation + low opacity (or `drawImage` for a
  logo), which the placement export path already supports.

**Cross-platform:** pdf-lib only. ✅✅✅

### 6. Tool Chest — save & reuse custom markups / stamps  **(A)**
**Why:** this is what makes Bluebeam sticky (`docs/measurement-plan.md` Part A).
Once you've styled an arrow or built a "REVISED" stamp, keep it.
- Serialize a markup's shape+style to JSON, store an array in `App.Prefs`
  (localStorage-backed, already cross-platform). A palette in the Markup panel
  re-instantiates a saved tool on click.
- Custom **image stamps**: reuse the signature-creation → PNG pipeline; a stamp is
  just a placement whose PNG is user-supplied/saved.

**Cross-platform:** `App.Prefs` (localStorage) works identically in Electron and
the WebView. ✅✅✅

### 7. Redaction  **(A, with an honesty caveat)**
**Why:** frequently requested; pairs with legal/Bates work.
- **UX:** a redaction tool (reuse `markup.js` rectangle) marks regions; "Apply
  Redactions" on save.
- **The honest engineering reality (researched):** lightweight JS libraries
  (pdf-lib included) can draw an opaque box, **but the underlying text/vector data
  survives in the file and is extractable** — that is *not* true redaction. The
  only reliable removal path without a commercial SDK (Apryse/Nutrient) is to
  **rasterize the affected page**: render the PDF.js page to a canvas, paint the
  redaction rectangles black, and replace the page content with that flattened
  image via pdf-lib (`drawImage` over a blank page of the same size). This
  genuinely removes the data.
- **Trade-off to surface in the UI:** rasterizing loses selectable text and
  inflates size for the redacted pages. Offer it as "Redact (flattens affected
  pages)" and only rasterize pages that actually carry a redaction. Document the
  limitation plainly, the way the README already does for cosmetic signatures.

**Cross-platform:** canvas + pdf-lib, all in the renderer. ✅✅✅

### 8. More measurement types: Volume/Depth, Radius/Diameter, Arc  **(A)**
**Why:** `docs/measurement-plan.md` already lists these as the natural next
measurement increments; the coordinate + scale foundation is done.
- **Volume** = existing area × a depth input → `area_real * depth`; **Wall Area** ≈
  `perimeter_real * depth`. Pure additions to `src/shared/measure-math.js` (unit-
  tested, no Electron) and a depth field in the measurement modal.
- **Radius/Diameter/Arc** = new geometry helpers in `src/shared/geometry.js`
  (2-point radius; 3-point circle/arc), rendered as SVG like the other measures.

**Cross-platform:** shared pure logic + renderer overlay. ✅✅✅ (and the shared
math gets unit tests for free, matching the existing `test/unit/` suites).

### 9. Document Compare / Overlay  **(A)**
**Why:** "what changed between Rev C and Rev D" is a daily AEC question; Bluebeam's
Compare/Overlay is a headline feature.
- Open a second document (same picker as merge). Render matching pages to two
  canvases at equal scale; produce a **pixel diff** (additions in one color,
  deletions in another) or an **overlay** (each revision tinted, drawn with
  `mix-blend-mode`). Both are canvas operations in the renderer.
- Export the diff as a flattened image page (reuses #10's canvas→PNG→pdf-lib path).

**Cross-platform:** canvas math only. ✅✅✅

### 10. Snapshot / export page or region to PNG  **(A)**
**Why:** small, cheap, universally useful ("grab this detail as an image").
- Marquee a region (or a whole page) → read pixels from the PDF.js canvas →
  `canvas.toDataURL()` → hand bytes to `window.api.savePdfDialog`-style save. The
  `saveBinary` path in `platform-web.js` already writes arbitrary bytes + opens the
  Android share sheet; desktop already has the file dialog.

**Cross-platform:** ✅✅✅ (uses the existing binary-save contract as-is).

### 11. Import existing annotations for in-app editing  **(A)**
**Why:** the README explicitly flags this as *planned* ("importing them for in-app
editing is planned"). Today we display+preserve foreign annotations but can't edit
them.
- `page.getAnnotations()` in PDF.js yields the annotation dicts; map the supported
  subtypes (Square/Circle/Line/PolyLine/Polygon/Ink/FreeText — the exact set
  `save.js` already *writes*) into `App.state.annotations`, then let the existing
  markup editor own them. On save they round-trip through the same
  `writeRealAnnot` path.

**Cross-platform:** PDF.js + existing markup engine. ✅✅✅

---

## Part D — Tier B & C: possible everywhere, but mind the seams

### Print  **(B)** — recommended, low risk
Add `window.api.print()`:
- **Electron:** `webContents.print()` (or print-to-PDF) from the main process.
- **Android/web:** `window.print()` in the WebView triggers the Android system
  print dialog (which can save-as-PDF or hit a networked printer).
One method, two impls, identical call site. ✅

### OCR → searchable text layer (tesseract.js, fully offline)  **(B)** — high value, size cost
- **Feasibility (researched):** tesseract.js is Tesseract compiled to WASM and runs
  entirely client-side in a Web Worker — no server, works offline, which fits this
  app's "no network at runtime" promise. Pipeline: PDF.js renders each page to a
  canvas at 2–3× → tesseract recognizes → write an **invisible text layer** back
  over the page image via pdf-lib so the output PDF becomes searchable/selectable.
- **Why it's Tier B not A:** the English trained-data alone is ~10–15 MB and must be
  **bundled** (the runtime-offline rule forbids fetching it on demand). That grows
  the installer and especially the **APK**. Mitigate: ship English only by default,
  make extra languages an optional download *before* first offline use, and gate
  the feature behind an explicit "Run OCR" action (it's CPU-heavy, seconds/page).
- **Cross-platform:** the WASM + worker run in the WebView, so Android works too —
  just slower on low-end devices. Verify on a real device; consider a page-range
  limit on mobile. ✅ (with the size caveat called out honestly).
- **Limitations to state in-app:** great on clean printed text, weak on
  handwriting/tables/low-quality scans.

### Recent files / session restore  **(B, partial on Android)**
- Desktop keeps a real file path, so "reopen last / recent list / restore markups"
  is straightforward via `App.Prefs`.
- On Android, a picked file's `content://` URI is **not durably re-openable**, so
  "recent files" degrades to "recent + re-pick." Ship the desktop version fully and
  the Android version as a most-recent-name hint. Mark the difference in the UI
  rather than pretending parity. ◑

### Camera "scan to PDF"  **(C)** — the one that breaks parity; here's the fix
- **Mobile:** a Capacitor document-scanner plugin (e.g. `@capgo/capacitor-document-
  scanner`, or Scanbot/Docutain SDKs) gives native edge-detection, perspective
  correction, and direct **PDF export**, fully offline. This is a genuinely great
  Android feature.
- **The parity problem:** there is **no equivalent native desktop scan**. If we ship
  it mobile-only, it violates "add it to macOS, Windows and Android."
- **Parity plan:** on desktop, back the same "Scan" button with `getUserMedia`
  (webcam capture → the *same* perspective-correct-and-embed code path that turns an
  image into a PDF page). Webcam scanning is lower quality than a phone camera, but
  it keeps the feature present and functional on all three platforms behind one
  button. Where a desktop truly has no camera, the button falls back to "Import
  image as page" (Tier A: image → pdf-lib page). Decide explicitly before building
  whether webcam-scan quality is worth it, or whether to scope this **mobile-first,
  desktop = import-image** and say so.

---

## Part E — Deliberately *not* recommended (and why)

- **True content/text editing** (retype the document's body text) — requires font
  subsetting, reflow, and glyph substitution far beyond pdf-lib; this is where
  commercial engines earn their license. Out of scope, same conclusion the README
  already reaches for exotic rendering.
- **Certificate-based (PKI/PAdES) digital signatures** — the README already, and
  correctly, scopes the app to *cosmetic* signatures. Real PKI needs a crypto
  signing stack and key management; keep it out unless it becomes a hard
  requirement.
- **Real-time cloud co-markup (Bluebeam Studio-style)** — needs a backend and a
  network, directly contradicting the "offline, no cloud, no telemetry" promise.
  Skip, or make it an explicit, separate, opt-in product direction.

---

## Part F — Suggested roadmap (each phase ships to all three platforms)

Ordered by value-per-effort with the cross-platform constraint kept green
throughout (every phase below is Tier A or a bounded Tier B):

1. **Organize + Combine** — Page Organizer (#1) then Merge/Split (#2). Biggest
   visible gap closed; unlocks the export-remap path in `save.js` that later
   features reuse.
2. **Fill forms (#3)** — highest standalone utility; distinguishes us from
   view-only readers.
3. **Navigate big sets** — Outline + thumbnail rail (#4); tiny effort, leans into
   the "large plan set" positioning.
4. **Stamp & number** — Bates/watermark (#5) + Tool Chest (#6); legal/AEC stickiness.
5. **Measure more** — Volume/Radius/Arc (#8); pure shared-logic add with free unit
   tests.
6. **Print (#12)** — the one broadly-expected Tier B capability still missing.
7. **Redaction (#7)** and **Compare/Overlay (#9)** — higher-effort but strong
   differentiators; both stay in the renderer.
8. **OCR (#14)** — schedule after the packaging question (bundle size / optional
   language data) is decided.
9. **Scan-to-PDF (#15)** — last, and only with the Part D parity plan agreed, so it
   doesn't become Android-only.

Every phase is independently shippable, adds unit/e2e coverage in the same shape as
the existing suites, and — by construction — reaches Windows, macOS and Android from
a single renderer implementation.

---

## Sources

Cross-platform architecture facts are drawn from this repo (`README.md`,
`scripts/build-web.js`, `src/renderer/js/platform-web.js`, `src/preload.js`,
`src/renderer/js/save.js`) and `docs/measurement-plan.md`.

Capability research (web):
- **tesseract.js / offline browser OCR** — naptha/tesseract.js (GitHub); Transloadit
  "Integrating OCR in the browser with tesseract.js"; DEV "OCR in the Browser".
- **pdf-lib page ops & forms** — pdf-lib.js.org (docs + `PDFForm`).
- **PDF.js AcroForm / annotation layer** — mozilla/pdf.js issue #7613; Mozilla
  Attack & Defense "Implementing form filling and accessibility in the Firefox PDF
  viewer" (AcroForm in v84, JS in v88, XFA in v93).
- **Redaction (true removal vs. masking)** — Nutrient and Apryse redaction guides;
  Syncfusion "PDF Redaction in JavaScript" (rasterization trade-offs).
- **Capacitor camera → PDF scanning** — Cap-go/capacitor-document-scanner (GitHub);
  Scanbot and Docutain Capacitor SDK docs (offline scan + PDF export).
- **Competitive feature landscape** — Foxit / Xodo / PDF Expert comparisons
  (Capterra, G2, Slashdot); Bluebeam Revu (per `docs/measurement-plan.md`).
</content>
</invoke>
