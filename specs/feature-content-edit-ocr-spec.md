# Spec — OCR + PDF Content Editing

**Phase 2 of the build pipeline.** Contract for
`specs/feature-content-edit-ocr-brief.md`. Every later phase is checked against
this document; code that conflicts with it is wrong.

## 0. Decisions taken at the Phase-1 checkpoint

| # | Question | Decision |
|---|---|---|
| D1 | How should existing content be "edited"? | **Match Acrobat properly: true content-stream rewriting.** The original text operators are genuinely replaced, not covered by a patch. Explicitly accepted as the higher-effort path. |
| D2 | Staging | **Three PRs, in order.** Track A (OCR) is built now; Tracks B and C are specified and planned here, built in later PRs. |
| D3 | OCR asset delivery | **Bundled on every platform** (~10 MB into the .exe, .dmg and .apk). The no-network guarantee stays absolute. |
| D4 | Languages (spec-designer call) | **English only in v1.** Each extra language adds ~2 MB; a picker goes to `specs/backlog.md`. |
| D5 | OCR output (spec-designer call) | **Invisible searchable text layer** (the standard searchable-PDF construction), baked into the document bytes. Recognized words are also retained in app state so Track B can edit them. |
| D6 | Reversibility (spec-designer call) | OCR is a **document transformation**, not a mark: it is baked into the bytes, like the page organizer's rebuild. Existing marks are **preserved** across it. Track B/C content edits **do** ride the editable sidecar. |
| D7 | Regression boundary (spec-designer call) | As enumerated in §7. |

---

## 1. Overview and user value

FieldMark can add new objects to a page but cannot touch what is already there.
This feature closes that gap in three tracks:

- **Track A — OCR.** Run offline text recognition over a scanned PDF so its words
  become real, selectable, copyable and findable text, without changing how the
  page looks.
- **Track B — Text content editing.** Click an existing word or line and retype,
  move or delete it, with the change written into the page's actual content
  stream.
- **Track C — Object/image editing.** Move, resize or delete an image already
  embedded in the page.

Value: a field user can search a scanned drawing, lift text off it, fix a wrong
revision number in a title block, and reposition a logo — offline, on Windows,
macOS and Android, in the app they already use for markup and measurement.

## 2. Scope

### 2.1 In scope — Track A (built in this PR)

1. An offline OCR engine bundled into all three platform builds.
2. A "Recognize Text (OCR)" command with a page-range choice (current page / all
   pages), progress reporting and cancel.
3. Rasterize each selected page at a bounded resolution and recognize its words.
4. Write the recognized words back into the document as an invisible text layer
   positioned over the matching glyphs.
5. Reload the recognized document in place so PDF.js's existing find, text
   selection and copy work on it with no further code.
6. Preserve existing placements, measurements and markups across the OCR rebuild.
7. Skip pages that already contain a text layer, unless the user forces re-OCR.

### 2.2 In scope — Track B (specified here, built in a later PR)

8. Enter a content-edit mode that surfaces every existing text run on the page as
   a selectable object.
9. Retype a run's text, with the change written into the page content stream in
   the run's original font and encoding.
10. Move and delete existing text runs by rewriting/removing their operators.
11. Detect when the original font cannot represent the new characters, substitute
    the nearest available font, and tell the user it happened.
12. Validate every rewritten document by re-parsing it before it is accepted;
    abort to the untouched original if validation fails.

### 2.3 In scope — Track C (specified here, built in a later PR)

13. Surface embedded image XObjects on a page as selectable objects.
14. Move, resize and delete those images by rewriting their placement matrix or
    removing their draw operators.

### 2.4 Out of scope (all tracks)

- Editing arbitrary vector artwork (linework, paths, charts drawn as vectors).
  Only **text runs** and **image XObjects** are addressable.
- Reflowing a paragraph across lines or pages. Edits are scoped to the run/line
  the user selected, exactly as Acrobat scopes them to a detected block.
- Handwriting recognition. OCR targets printed text.
- Any language other than English in v1 (D4).
- OCR of the app's own markup/measurement overlay — OCR reads the source page.
- Editing a document that carries a certified digital signature (see FR-B-13).
- Any network access, at any point, on any platform.

### 2.5 Later (to `specs/backlog.md`)

- Additional OCR languages + a picker.
- Automatic deskew/despeckle preprocessing.
- Paragraph-level reflow.
- Vector-object selection.

---

## 3. Functional requirements (EARS)

### Track A — OCR

- **FR-A-1** (Ubiquitous) The system shall bundle the OCR engine, its WebAssembly
  cores and English language data into the Windows, macOS and Android builds, and
  shall perform recognition entirely on-device.
- **FR-A-2** (Ubiquitous) The system shall never issue a network request as part
  of OCR.
- **FR-A-3** (Event-driven) When the user chooses "Recognize Text (OCR)", the
  system shall present a dialog offering "Current page" or "All pages", a
  "Re-recognize pages that already have text" option (default off), and Start /
  Cancel.
- **FR-A-4** (Event-driven) When the user starts recognition, the system shall
  process the selected pages one at a time, and shall display the current page
  number, the total, and a percentage.
- **FR-A-5** (State-driven) While recognition is running, the system shall keep a
  Cancel control active and shall keep the app responsive.
- **FR-A-6** (Event-driven) When the user cancels, the system shall stop after the
  page in progress and shall leave the document exactly as it was before
  recognition started.
- **FR-A-7** (Ubiquitous) The system shall rasterize each page for recognition at
  no more than 300 DPI and no more than 40 megapixels, reducing the scale as
  needed to stay under both caps.
- **FR-A-8** (Optional) Where a page already yields text from `getTextContent()`
  and the re-recognize option is off, the system shall skip that page and shall
  report it as skipped.
- **FR-A-9** (Event-driven) When recognition of a page completes, the system shall
  discard recognized words whose confidence is below 30%.
- **FR-A-10** (Event-driven) When all selected pages are processed, the system
  shall write each retained word into the document as text drawn in invisible
  text-rendering mode, positioned and sized so that its bounding box matches the
  word's recognized bounding box on the page.
- **FR-A-11** (Ubiquitous) The system shall position OCR text using the same
  scale-1 viewport point space and `convertToPdfPoint` mapping as every other
  export path, so that recognition is correct on rotated pages.
- **FR-A-12** (Event-driven) When the recognized document has been built, the
  system shall reload it into the current tab in place, and shall restore the
  placements, measurements and markups that were present before recognition.
- **FR-A-13** (Event-driven) When recognition finishes, the system shall mark the
  document as having unsaved changes and shall report how many pages were
  recognized and how many were skipped.
- **FR-A-14** (Ubiquitous) The system shall leave the visible appearance of every
  recognized page unchanged.
- **FR-A-15** (If/Then) If the OCR engine fails to initialize, then the system
  shall report that text recognition is unavailable and shall leave the document
  untouched.
- **FR-A-16** (If/Then) If recognition of an individual page throws, then the
  system shall record that page as failed, continue with the remaining pages, and
  report the failure count at the end.
- **FR-A-17** (If/Then) If no document is open, then the OCR command shall be
  disabled.

### Track B — Text content editing (later PR)

- **FR-B-1** (Event-driven) When the user activates content-edit mode, the system
  shall enumerate the current page's text runs and present each as a selectable
  object aligned to its on-page position.
- **FR-B-2** (Event-driven) When the user selects a text run and types, the system
  shall record the replacement text against that run without altering the document
  until the edit is committed.
- **FR-B-3** (Ubiquitous) The system shall apply a committed text edit by
  rewriting the page's content stream so that the original text-showing operator
  emits the replacement string, and shall not draw a covering patch.
- **FR-B-4** (Ubiquitous) The system shall encode replacement text using the
  original run's font encoding, including composite fonts addressed by glyph id.
- **FR-B-5** (If/Then) If the original font cannot represent one or more
  replacement characters, then the system shall substitute the nearest available
  standard font for that run and shall inform the user that the font was
  substituted, naming the run.
- **FR-B-6** (Event-driven) When the user drags a text run, the system shall
  rewrite that run's text matrix so the run is drawn at the new position.
- **FR-B-7** (Event-driven) When the user deletes a text run, the system shall
  remove that run's text-showing operator from the content stream.
- **FR-B-8** (Ubiquitous) The system shall re-parse every rewritten document
  before accepting it, and shall verify that the page count is unchanged and that
  the edited page's text content reflects the edit.
- **FR-B-9** (If/Then) If validation under FR-B-8 fails, then the system shall
  discard the rewritten bytes, keep the original document, and report that the
  edit could not be applied.
- **FR-B-10** (Ubiquitous) The system shall store pending content edits in the
  editable sidecar so they survive a save and reopen as live, re-editable objects.
- **FR-B-11** (State-driven) While content-edit mode is active, the system shall
  disable the markup, measure and placement tools, and shall restore them on exit.
- **FR-B-12** (Ubiquitous) The system shall register every content edit with the
  existing undo history.
- **FR-B-13** (If/Then) If the open document carries a digital signature, then the
  system shall refuse to enter content-edit mode and shall explain that editing
  would invalidate the signature.

### Track C — Object/image editing (later PR)

- **FR-C-1** (Event-driven) When content-edit mode is active, the system shall
  present each image XObject drawn on the page as a selectable object at its
  on-page position and size.
- **FR-C-2** (Event-driven) When the user moves or resizes an image object, the
  system shall rewrite the transformation matrix that positions that image in the
  content stream.
- **FR-C-3** (Event-driven) When the user deletes an image object, the system
  shall remove its draw operator from the content stream.
- **FR-C-4** (Ubiquitous) Image edits shall be subject to the same validation
  (FR-B-8/9), sidecar persistence (FR-B-10) and undo integration (FR-B-12) as text
  edits.

---

## 4. Acceptance criteria

Keyed to FR numbers. Each is observable by a person or by an automated test.

### Track A

**AC-A-1 (FR-A-1, FR-A-2)**
Given the machine has no network connection,
When the user runs OCR on a scanned PDF,
Then recognition completes successfully and no network request is attempted.

**AC-A-2 (FR-A-3)**
Given a document is open,
When the user chooses "Recognize Text (OCR)",
Then a dialog appears offering "Current page" and "All pages", a
"Re-recognize pages that already have text" checkbox that is unchecked, and
Start and Cancel controls.

**AC-A-3 (FR-A-4, FR-A-5)**
Given recognition is running over a 5-page document,
When page 3 is being processed,
Then the UI shows page 3 of 5 with a percentage, and the Cancel control is
enabled.

**AC-A-4 (FR-A-6)**
Given recognition is running,
When the user clicks Cancel,
Then recognition stops, the open document is byte-identical to what it was before
Start was clicked, and no OCR text layer has been added.

**AC-A-5 (FR-A-8)**
Given a PDF whose pages already contain a text layer,
When the user runs OCR with the re-recognize option off,
Then every page is reported as skipped and the document is unchanged.

**AC-A-6 (FR-A-10, FR-A-14)**
Given a scanned page containing the printed word "DRAWING",
When OCR completes and the document reloads,
Then the page renders visually identically to before, and searching for
"DRAWING" finds a match on that page.

**AC-A-7 (FR-A-10)**
Given OCR has completed on a scanned page,
When the user drags a selection across a recognized word and presses Ctrl/Cmd+C,
Then the recognized text is placed on the clipboard.

**AC-A-8 (FR-A-11)**
Given a scanned page whose `/Rotate` is 90,
When OCR completes,
Then each recognized word's invisible text sits over the glyphs it was
recognized from, within 2 points.

**AC-A-9 (FR-A-12)**
Given a document with one signature placement, one measurement and one markup,
When OCR completes,
Then all three are still present, on the same pages, at the same positions.

**AC-A-10 (FR-A-13)**
Given a 3-page document where 2 pages are scans and 1 already has text,
When OCR completes with the re-recognize option off,
Then the app reports 2 pages recognized and 1 skipped, and the document is marked
as having unsaved changes.

**AC-A-11 (FR-A-7)**
Given a D-size (34x44 in) scanned sheet,
When OCR rasterizes it,
Then the raster is at most 300 DPI and at most 40 megapixels.

**AC-A-12 (FR-A-15)**
Given the OCR engine assets are missing or fail to load,
When the user starts recognition,
Then the app reports that text recognition is unavailable and the document is
unchanged.

**AC-A-13 (FR-A-16)**
Given a 3-page document where page 2 throws during recognition,
When OCR runs over all pages,
Then pages 1 and 3 are recognized, and the result reports 1 failed page.

**AC-A-14 (FR-A-17)**
Given no document is open,
Then the "Recognize Text (OCR)" command is disabled.

**AC-A-15 (FR-A-1, cross-platform)**
Given the web/Android bundle produced by `npm run build:web`,
When it is driven in headless Chromium by `npm run verify:web`,
Then the OCR engine initializes and recognizes a fixture page.

### Track B

**AC-B-1 (FR-B-1)**
Given a PDF whose page contains the text "REV. 3",
When the user activates content-edit mode,
Then a selectable object appears over "REV. 3" aligned to those glyphs.

**AC-B-2 (FR-B-3)**
Given the user has replaced "REV. 3" with "REV. 4" and committed,
When the saved file is re-parsed,
Then its extracted text contains "REV. 4" and does not contain "REV. 3".

**AC-B-3 (FR-B-3, no-patch guarantee)**
Given the edit in AC-B-2,
When the saved page's content stream is inspected,
Then no rectangle-fill operator has been added over the edited run.

**AC-B-4 (FR-B-5)**
Given a run set in a subset font lacking the glyph for a typed character,
When the edit is committed,
Then the run renders in a substituted standard font and the user is told which
run was substituted.

**AC-B-5 (FR-B-7)**
Given a page with a text run,
When the user deletes that run and saves,
Then the re-parsed page's text no longer contains that run's string, and the
page's other text is unchanged.

**AC-B-6 (FR-B-9)**
Given a content-stream rewrite that produces an unparseable document,
When the edit is committed,
Then the original document is retained unchanged and the user is told the edit
could not be applied.

**AC-B-7 (FR-B-10)**
Given a committed text edit,
When the document is saved and reopened in FieldMark,
Then the edit is present and the run is still selectable and re-editable.

**AC-B-8 (FR-B-13)**
Given a digitally signed document,
When the user tries to enter content-edit mode,
Then entry is refused with an explanation that editing would invalidate the
signature.

### Track C

**AC-C-1 (FR-C-1, FR-C-2)**
Given a page with an embedded logo image,
When the user drags it 100 points right and saves,
Then the re-parsed page draws that image 100 points further right, and no second
copy of the image exists.

**AC-C-2 (FR-C-3)**
Given a page with an embedded image,
When the user deletes it and saves,
Then the re-parsed page does not draw that image.

---

## 5. Error handling

| # | Condition | User-visible behavior | Document state |
|---|---|---|---|
| E1 | OCR engine assets missing / fail to load | Toast: "Text recognition is unavailable in this build." | Unchanged |
| E2 | OCR worker crashes mid-run | Toast naming the failed page; run continues | Pages already recognized are kept; failed page skipped |
| E3 | User cancels OCR | Toast: "Recognition cancelled." | Byte-identical to pre-run |
| E4 | Page too large to rasterize even at the floor scale | That page reported as failed | Other pages still recognized |
| E5 | OCR returns zero words above threshold for a page | Page reported as "no text found" | No text layer added for that page |
| E6 | OCR run on a document with no pages / no document open | Command disabled | Unchanged |
| E7 | Out of memory during rasterization | Toast: "This page is too large to recognize on this device." | Unchanged for that page |
| E8 | Save fails after OCR | Existing save error path (`save.js`) | OCR text remains in memory, still unsaved |
| E9 | Content stream cannot be decoded (Track B/C) | Toast: "This page's content cannot be edited." Runs not offered as editable | Unchanged |
| E10 | Rewritten document fails re-parse validation (Track B/C) | Toast: "That edit could not be applied safely." | Original retained |
| E11 | Font cannot encode replacement characters (Track B) | Toast naming the run and the substituted font | Edit applied with substitution |
| E12 | Content edit attempted on a signed document (Track B/C) | Toast explaining signature invalidation; mode not entered | Unchanged |
| E13 | Encrypted / password-protected PDF | Existing open-time error path | Never opened |

---

## 6. Non-functional requirements

**Performance**
- NFR-1: OCR of a single US-Letter 200 DPI scanned page shall complete in ≤ 20 s
  on a current desktop (Apple Silicon / modern x64) and ≤ 60 s on a mid-range
  Android tablet.
- NFR-2: Progress shall update at least once per second while recognition runs.
- NFR-3: Recognition shall run off the main thread; the UI shall remain
  interactive (scroll, zoom, cancel) throughout.
- NFR-4: Peak additional memory during recognition of one page shall stay under
  1 GB, enforced via the FR-A-7 raster caps.
- NFR-5: Entering content-edit mode (Track B) on a page with ≤ 500 text runs shall
  present the editable objects within 1 s.

**Size**
- NFR-6: The bundled OCR assets shall add no more than 15 MB to any platform
  build. **Measured at implementation: 14.3 MB** — 12 MB of WASM cores, 2.1 MB of
  English language data, 0.2 MB of library.

  *Revised from an estimated 12 MB.* Tesseract selects one of three LSTM cores at
  runtime from the device's SIMD support (relaxed-SIMD, SIMD, or plain), and
  requests it by name. Shipping only the two modern variants would save 3.7 MB but
  404 on exactly the older Android hardware least able to recover from it — the
  worst outcome for an app whose promise is that it works offline. All three ship.

**Correctness / safety**
- NFR-7: No code path in this feature shall make a network request.
- NFR-8: OCR shall not alter the rendered appearance of any page (FR-A-14).
- NFR-9: A content-stream rewrite shall never produce a document that fails to
  re-parse (enforced by FR-B-8/9).

**Accessibility (WCAG AA baseline, consistent with the existing app)**
- NFR-10: The OCR dialog shall be keyboard-navigable, shall trap focus while open,
  and shall close on Escape.
- NFR-11: Progress shall be exposed to assistive technology via an ARIA live
  region.
- NFR-12: All new controls shall have accessible names and meet 4.5:1 contrast in
  both light and dark themes.

**Platform support**
- NFR-13: The feature shall work identically on Windows and macOS (Electron) and
  in the Android WebView (Capacitor), from one renderer implementation, per the
  cross-platform rule in `CLAUDE.md`.
- NFR-14: Coverage shall include a new `SMOKE_*` scenario in `src/main.js` with a
  matching assertion in `test/e2e/run.js`, plus web-parity coverage via
  `npm run verify:web`.

**Security** (offline app, no server, no auth — the threat model is local files)
- NFR-15: Recognized text shall never leave the device.
- NFR-16: The feature shall add no new method to the `window.api` file-I/O
  contract; it is renderer-only.
- NFR-17: The CSP shall not be loosened beyond what WebAssembly execution
  requires, and shall not be widened to permit any remote origin.

---

## 7. Regression boundary — what must NOT change

Verified working after this change:

1. Open / save / Save As / save-before-close, including the overwrite confirm.
2. The editable sidecar round-trip (`SMOKE_RT`): marks survive save → reopen.
3. Signature, initials and date placement; drag, resize, nudge, duplicate.
4. Markup tools: all shapes, freehand, text boxes, text markups, the markup rail,
   styling and presets, undo/redo.
5. Measurement: all types, per-page scale, viewports, snapping, the panel, CSV.
6. Page organizer: reorder, rotate, delete, insert, merge, extract.
7. Document stamps: Bates numbering, header/footer, watermark.
8. Compare and Overlay.
9. Digital signing — including that signed output stays flattened and
   sidecar-free.
10. Tabs: open, switch, reorder, tear-off, side-by-side split.
11. Print and print preview.
12. Find, text selection and select-to-copy on documents that already have text.
13. Zoom (wheel, pinch, marquee, fit-width), rotation, and overlay alignment at
    every rotation.
14. The welcome tour and first-run behavior.
15. Android/web parity: `npm run verify:web` stays green.

---

## 8. Data model sketch

**`App.state.ocr`** — recognition results, keyed by page number. Transient; used
to build the text layer and, later, to seed Track B editing on scans.

```
ocr: {
  [pageNumber]: {
    status: 'pending' | 'done' | 'skipped' | 'failed' | 'empty',
    dpi: number,
    words: [ { text, vx, vy, vw, vh, conf } ]   // scale-1 viewport points
  }
}
```

`vx/vy/vw/vh` are in scale-1 viewport points, top-left origin — the same space as
placements, measurements and markups, so the existing `convertToPdfPoint` export
mapping applies unchanged.

**`App.state.contentEdits`** (Track B/C) — pending edits against existing page
content. Serialized into the sidecar model alongside `placements`,
`measurements` and `annotations`.

```
contentEdits: [
  {
    id, page,
    kind: 'text' | 'image',
    ref: { streamIndex, opIndex },      // locates the operator to rewrite
    origin: { vx, vy, vw, vh },         // where it is now
    op: 'replace' | 'move' | 'resize' | 'delete',
    text?: string,                      // replace
    dx?, dy?, sw?, sh?,                 // move / resize
    fontSubstituted?: boolean
  }
]
```

Relationships: an `ocr` entry belongs to one page and produces invisible text
baked into the document bytes. A `contentEdit` belongs to one page and one
content-stream operator, and is applied at export time by the content-stream
rewriter. Both use the app's single geometry convention (scale-1 viewport points,
top-left origin).
