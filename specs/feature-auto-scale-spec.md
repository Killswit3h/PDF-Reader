# Specification — Automatic per-page scale detection

Phase 2 of the build pipeline. Contract for the build and the inspection.
Source brief: `specs/feature-auto-scale-brief.md`.

**Status: awaiting user approval.**

---

## 1. Overview and user value

FieldMark can already hold a different scale for every page and for every region
within a page (`App.state.scales`, `App.state.viewports`). What it cannot do is
*populate* that model without a human typing a ratio or drawing a calibration
line, once per sheet.

This feature reads the scale out of the PDF itself, per page, from two sources:

- **Tier A — embedded measurement metadata.** Pages plotted by a CAD/BIM
  exporter that writes ISO 32000 §12.9 measurement data carry a `/VP` array of
  viewport dictionaries, each with a `/BBox` region and a `/Measure` dictionary
  giving the exact scale for that region. This is authoritative, and it is
  natively multi-scale-per-page.
- **Tier B — the title-block scale note.** The text a human reads
  (`SCALE: 1/4" = 1'-0"`, `1:100`, `1" = 20'`). Covers the majority of real
  files, which carry no embedded metadata.

The user opens a 120-sheet set and the plans, sections and details each arrive
already scaled, with the source of every scale visible and one click from being
overridden. Sheets FieldMark cannot read honestly say so instead of guessing.

### Decisions carried in from Phase 1

| # | Decision |
|---|---|
| D1 | Tiers **A + B** ship in v1. Graphic bar-scale detection (tier C) is deferred to `specs/backlog.md`. |
| D2 | High-confidence detections **auto-apply**; everything else lands in a review list. Provenance is always visible. |
| D3 | Half-size / shrink-to-fit plots are **auto-corrected and labelled**, never silently trusted as written. |
| D4 | Tier A populates **`state.viewports` as real regions**; tier B sets a **single page scale**. |
| D5 | *(resolved by default)* `NTS` / `NOT TO SCALE` / `AS NOTED` / `AS SHOWN` / `VARIES` leave the page **unscaled** and produce an explicit review-list entry stating why. Setting one page scale on an "AS NOTED" detail sheet would be wrong. |
| D6 | *(resolved by default)* A detected imperial architectural ratio produces unit **`ft`**, matching how the note is written and the existing feet-inches formatter (`measure-math.js:35-40`). |

## 2. Scope

### 2.1 In scope

1. Read `/VP` + `/Measure` from every page of the open PDF and turn each viewport into a scaled region in `state.viewports`.
2. Parse title-block scale notes from the PDF text layer into a page scale in `state.scales`.
3. Parse the same notes from OCR results (`state.ocr[page].words`) for scanned sheets, when OCR has already run.
4. Classify each detection as high or low confidence, and auto-apply only high-confidence ones.
5. Detect half-size / reduced plots and apply a corrected factor, clearly labelled.
6. Record provenance (`source`, `confidence`, `halfSize`) on every scale FieldMark sets.
7. A **"Detected" tab** in the existing Scale modal listing every page's detection, its source, and one-click accept / override / clear.
8. Re-run detection on demand for the current page or the whole document.

### 2.2 Out of scope (explicitly)

- **Graphic bar-scale detection** from vector geometry (tier C) — backlog.
- **Triggering OCR.** Detection reads OCR output if it exists; it never starts an OCR run.
- Changing the measurement label format, the on-page measurement rendering, or `scaleFor`'s resolution order.
- Changing the PDF export path (`save.js`). Detected scales export exactly like user-set ones, through the existing `/Measure` writer.
- Any new `window.api` method, any Electron/Capacitor branching, any new npm dependency.
- Writing `/VP` on export.
- Detecting units of *angle*, *slope* or *area* from `/Measure` (`/T`, `/S`, `/A`). Only linear (`/X`) is read.
- Network anything.

### 2.3 Later (backlog)

- Tier C graphic bar-scale detection.
- Learning a per-document correction from the user's first manual calibration and offering it to sibling sheets.
- Reading `/Measure` off incoming *annotations* (as opposed to page `/VP`) to recover a scale from another tool's markup.

## 3. Functional requirements (EARS)

### 3.1 Running detection

- **FR-1** — When a PDF finishes opening, the system shall run scale detection for every page without blocking the viewer.
- **FR-2** — While detection is running, the system shall leave the viewer fully interactive.
- **FR-3** — The system shall run tier A (embedded `/VP`) before tier B (text note) for a given page, and shall not run tier B on a page where tier A produced an applied result.
- **FR-4** — Where a page already has a scale whose `source` is `user` or absent, the system shall not overwrite it, and shall record the detection as an unapplied candidate.
- **FR-5** — When a document is restored from a sidecar carrying user scales, the system shall treat those scales as `source: 'user'` and leave them untouched.
- **FR-6** — When the user invokes "Re-detect", the system shall re-run detection and apply results **including** over scales it previously set itself, but still never over a `user` scale.

### 3.2 Tier A — embedded `/VP` + `/Measure`

- **FR-7** — The system shall read the page dictionary's `/VP` array via pdf-lib from `App.state.pdfBytes`.
- **FR-8** — For each viewport dictionary with a `/Measure` of `/Subtype /RL`, the system shall read `/X[0]` and derive `factor` from its `/C` and `unit` from its `/U`.
- **FR-9** — The system shall map each viewport's `/BBox` from PDF user space into scale-1 viewport points using the page's PDF.js viewport `convertToViewportPoint`, and shall normalise the resulting corners into a top-left-origin rectangle.
- **FR-10** — The system shall normalise `/U` unit labels to the keys of `App.UNITS` (`in`, `ft`, `yd`, `mm`, `cm`, `m`), accepting common spellings (`ft`, `FT`, `feet`, `'`, `m`, `metre`, `meter`, `mm`, …).
- **FR-11** — If a `/U` label cannot be normalised to a known unit, then the system shall reject that viewport and record it as an unreadable candidate rather than guessing a unit.
- **FR-12** — When a page yields one or more valid viewports, the system shall add them to `state.viewports[page]` with `source: 'embedded'`, `confidence: 'high'`, and a `ratioLabel` derived from `/R` when present.
- **FR-13** — When every valid viewport on a page carries the same factor and unit, the system shall additionally set `state.scales[page]` to that scale with `source: 'embedded'`, so measurements outside any viewport box still read correctly.
- **FR-14** — If a viewport's `/BBox` is missing, degenerate, or maps to a zero-area rectangle, then the system shall reject that viewport.
- **FR-14a** *(clarification added during build)* — Where a page already has a scale whose `source` is `user` or absent, the system shall **not** add embedded regions to that page either, and shall record the embedded scale as an unapplied candidate. A region beats the page scale in `measure.js scaleFor`, so adding one over a hand-calibrated page would silently override that calibration for anything drawn inside the box — the precise surprise FR-4 exists to prevent. FR-4 and FR-12 did not say which won; this resolves it in FR-4's favour.

### 3.3 Tier B — title-block scale notes

- **FR-15** — The system shall extract page text via PDF.js `getTextContent()`, and shall fall back to `state.ocr[page].words` when the text layer is empty and OCR results exist.
- **FR-16** — The system shall recognise imperial architectural ratios of the form `<fraction or number>" = <number>'[-<number>"]` (e.g. `1/4" = 1'-0"`, `1 1/2"=1'-0"`, `3/16" = 1'0"`).
- **FR-17** — The system shall recognise imperial engineering ratios of the form `1" = <number>'` (e.g. `1" = 20'`, `1 IN = 40 FT`).
- **FR-18** — The system shall recognise pure ratios of the form `<number>:<number>` (e.g. `1:100`, `1:50`, `1:1250`).
- **FR-19** — The system shall compute `factor` for a parsed ratio as `realValue / (drawnValue * App.UNITS[drawnUnit].perPoint)`, matching `measure.js:710-718` exactly.
- **FR-20** — Where a parsed ratio is imperial, the system shall emit unit `ft`; where it is a pure ratio, the system shall emit unit `mm` when the ratio denominator is 10 or less and `m` otherwise.
- **FR-21** — The system shall recognise the no-scale markers `NTS`, `N.T.S.`, `NOT TO SCALE`, `AS NOTED`, `AS SHOWN`, `SCALE: VARIES`, and shall treat a page carrying one as deliberately unscaled.
- **FR-22** — If a page carries a no-scale marker, then the system shall leave `state.scales[page]` unset and record a review entry naming the marker found.
- **FR-23** — When a page yields exactly one distinct parseable ratio and that ratio is labelled by an adjacent `SCALE` keyword, the system shall classify the detection `high`.
- **FR-24** — When a page yields exactly one distinct parseable ratio with no adjacent `SCALE` keyword, the system shall classify the detection `low`.
- **FR-25** — When a page yields two or more distinct parseable ratios, the system shall classify the detection `low`, apply nothing, and record every candidate in the review entry.
- **FR-26** — When a tier-B detection is classified `high`, the system shall set `state.scales[page]` with `source: 'note'` and the parsed `ratioLabel`.
- **FR-27** — When a tier-B detection is classified `low`, the system shall not set `state.scales[page]` and shall record the candidate for review.

### 3.4 Half-size / reduced plots

- **FR-28** — The system shall compute each page's physical size in inches from `App.state.baseViewports[page-1]`.
- **FR-29** — When a page's size matches a standard sheet size that is exactly half of another standard size (within 2%), and no page in the document matches that full size, the system shall treat the page as a half-size plot.
- **FR-30** — When a tier-B ratio is detected on a half-size page, the system shall apply the parsed factor multiplied by 2, set `halfSize: true`, and set `ratioLabel` to the parsed label suffixed with ` (half-size)`.
- **FR-31** — When any half-size correction is applied, the system shall raise a distinct toast naming the assumption and shall mark that page's review entry as needing confirmation, regardless of confidence.
- **FR-32** — The system shall never apply a half-size correction to a tier-A embedded scale, because embedded metadata already describes the plotted geometry.

### 3.5 Provenance, review and override

- **FR-33** — The system shall record `source` (`'user' | 'embedded' | 'note'`), `confidence` (`'high' | 'low'`), and optional `halfSize` on every scale object it sets.
- **FR-34** — The system shall treat a scale object with no `source` as `source: 'user'` (backward compatibility with existing sidecars).
- **FR-35** — The Scale modal shall present a third tab, "Detected", listing one row per page with the page number, detected scale, source, confidence, and applied/not-applied state.
- **FR-36** — When the user accepts a row in the Detected tab, the system shall apply that candidate to the page as `source: 'note'` or `'embedded'` with `confidence: 'high'`.
- **FR-37** — When the user clears a row in the Detected tab, the system shall remove the detected scale from that page, leaving it unscaled.
- **FR-38** — When the user sets a scale by hand for a page, the system shall mark it `source: 'user'`, which makes it immune to FR-6 re-detection.
- **FR-39** — When any detected scale is applied or cleared, the system shall take an `App.History.snapshot()` first so the change is undoable.
- **FR-40** — When any detected scale is applied or cleared, the system shall call `App.Measure.recomputeAll()` so existing measurements re-read against the new scale.
- **FR-41** — When detection finishes, the system shall raise one summary toast stating how many pages were scaled automatically and how many need review.

### 3.6 Failure and degradation

- **FR-42** — If pdf-lib cannot parse the document for tier A, then the system shall skip tier A for the whole document and continue with tier B.
- **FR-43** — If a single page throws during detection, then the system shall record that page as failed and continue with the remaining pages.
- **FR-44** — If no page yields any detection, then the system shall leave the document exactly as it is today and raise no error.
- **FR-45** — Where a page has no text layer and no OCR results, the system shall record the page as undetectable and suggest OCR in its review entry.

## 4. Acceptance criteria

**AC-1 (FR-1, FR-2)** — *Given* a 120-page PDF, *when* the user opens it, *then* the first page is visible and pannable within the normal open time, and detection results appear progressively without the UI freezing.

**AC-2 (FR-3, FR-12, FR-13)** — *Given* a page carrying two `/VP` viewports with different `/Measure` scales, *when* the document is opened, *then* `state.viewports[page]` contains two regions with `source: 'embedded'`, no tier-B parse is attempted for that page, and a measurement drawn inside each region reports the value for that region's scale.

**AC-3 (FR-8, FR-19)** — *Given* a `/Measure` whose `/X[0]` has `/C 0.0833333` and `/U (ft)`, *when* tier A reads it, *then* the resulting scale is `{ factor: 0.0833333, unit: 'ft' }`, and a 120-point line measures 10 ft.

**AC-4 (FR-9)** — *Given* a page with `/Rotate 90` and a `/VP` `/BBox`, *when* the region is mapped, *then* the on-screen region rectangle covers the same drawing area it covers in Acrobat — verified by drawing a measurement inside it and getting the viewport's scale rather than the page's.

**AC-5 (FR-11)** — *Given* a `/Measure` with `/U (furlongs)`, *when* tier A reads it, *then* no scale is applied to that page and the Detected tab shows the page as "unreadable unit: furlongs".

**AC-6 (FR-16, FR-23, FR-26, FR-6)** — *Given* a sheet whose title block reads `SCALE: 1/4" = 1'-0"` and contains no other ratio, *when* the document opens, *then* `state.scales[page]` is `{ factor: 1/18, unit: 'ft', source: 'note', confidence: 'high' }` and a 72-point line measures 4 ft.

**AC-7 (FR-18, FR-20)** — *Given* a sheet reading `SCALE 1:100`, *when* detection runs, *then* the page scale is `{ factor: 100 / (7200/2.54), unit: 'm' }` and a 72-point line measures 2.54 m.

**AC-8 (FR-20)** — *Given* a sheet reading `SCALE 1:5`, *when* detection runs, *then* the emitted unit is `mm`.

**AC-9 (FR-25)** — *Given* a detail sheet carrying `1/4" = 1'-0"`, `1/2" = 1'-0"` and `3" = 1'-0"`, *when* detection runs, *then* no page scale is applied and the Detected tab lists all three candidates for that page.

**AC-10 (FR-21, FR-22)** — *Given* a sheet whose title block reads `SCALE: AS NOTED`, *when* detection runs, *then* the page is left unscaled, measurements on it show `(set scale)`, and the Detected tab explains "sheet declares AS NOTED".

**AC-11 (FR-24, FR-27, FR-36)** — *Given* a sheet containing `1:50` with no `SCALE` keyword nearby, *when* detection runs, *then* nothing is applied and the row appears in the Detected tab; *when* the user clicks Accept on that row, *then* the scale applies and existing measurements on the page recompute.

**AC-12 (FR-29, FR-30, FR-31)** — *Given* a document whose every page is 11×17in and whose title blocks read `SCALE: 1/4" = 1'-0"`, *when* detection runs, *then* the applied factor is `2/18` (double the written ratio), `ratioLabel` ends with `(half-size)`, a toast names the half-size assumption, and every such page is flagged for confirmation in the Detected tab.

**AC-13 (FR-29)** — *Given* a mixed document containing both 22×34in and 11×17in pages, *when* detection runs, *then* the 11×17 pages are **not** treated as half-size plots.

**AC-14 (FR-32)** — *Given* an 11×17in page carrying embedded `/VP` metadata, *when* detection runs, *then* the embedded factor is applied unmodified with no half-size correction.

**AC-15 (FR-4, FR-5, FR-38)** — *Given* a page the user has already calibrated by hand, *when* detection runs (on open or via Re-detect), *then* the user's scale is unchanged and the detection appears as an unapplied candidate in the Detected tab.

**AC-16 (FR-39)** — *Given* a detected scale has just been applied, *when* the user presses undo, *then* the page returns to its previous scale and the measurement labels revert with it.

**AC-17 (FR-40)** — *Given* measurements already drawn on a page with no scale, *when* a detected scale is applied to that page, *then* every one of those measurements changes from `(set scale)` to a real value without being redrawn.

**AC-18 (FR-43)** — *Given* a 50-page document where page 12 is malformed enough to throw during detection, *when* detection runs, *then* pages 1-11 and 13-50 still receive their detections and page 12 shows as failed.

**AC-19 (FR-44)** — *Given* a scanned PDF with no text layer and no OCR run, *when* it is opened, *then* no scale is set, no error is raised, and the Detected tab suggests running OCR (FR-45).

**AC-20 (regression)** — *Given* any document, *when* the user sets a scale via Enter-scale or Calibrate-by-drawing, and via "Apply to: All pages", *then* the behaviour is byte-for-byte what it is on `main` today, and the exported PDF's `/Measure` dictionaries are unchanged.

**AC-21 (regression)** — *Given* a document with user-drawn region viewports, *when* a measurement is drawn inside one, *then* `scaleFor` still resolves region-over-page exactly as today, and `save.js` writes the same governing scale it displays.

## 5. Error handling

| Condition | System response |
|---|---|
| `pdfBytes` absent or pdf-lib `load` throws | Skip tier A document-wide; run tier B; no toast (silent degradation). FR-42 |
| Encrypted document pdf-lib refuses | Same as above — tier A skipped, tier B still runs off PDF.js text. |
| Page dict has no `/VP` | Not an error. Fall through to tier B. |
| `/VP` present but no `/Measure`, or `/Subtype` ≠ `/RL` | Reject that viewport, continue with the rest. |
| `/X` missing, empty, or `/C` non-finite or ≤ 0 | Reject that viewport (FR-14 class). Record "unreadable measurement". |
| `/U` unit unrecognised | Reject, record `unreadable unit: <label>`. Never guess. FR-11 |
| `/BBox` missing / degenerate / zero-area | Reject that viewport. FR-14 |
| `getTextContent()` throws on a page | Record page as failed, continue. FR-43 |
| Page has no text and no OCR | Record undetectable, suggest OCR. FR-45 |
| Ratio parses to a non-finite or ≤ 0 factor | Discard the candidate; treat as no match. |
| Ratio implies an absurd factor (< 1e-6 or > 1e6 real units per point) | Discard as a false positive (guards against parsing a revision number as a ratio). |
| Two or more distinct ratios on one page | Apply nothing, list all. FR-25 |
| No-scale marker present | Leave unscaled with an explicit reason. FR-22 |
| Half-size inferred | Apply doubled factor, label, toast, flag for confirmation. FR-30, FR-31 |
| Page already `source: 'user'` | Never overwrite; list as unapplied candidate. FR-4 |
| Detection runs on a document that is closed mid-run | Abort quietly; no toast, no state writes against the new document. |
| Re-detect invoked while detection already running | Ignore the second invocation; keep the first running. |

## 6. Non-functional requirements

- **NFR-1 (performance, open path)** — Detection must not delay the point at which page 1 is interactive. Tier A is one pdf-lib document parse; tier B runs chunked in the background, yielding to the event loop at least once per page.
- **NFR-2 (performance, budget)** — A 200-page text-layer document completes full detection in under 30 s in the background, with no single synchronous block over 50 ms.
- **NFR-3 (memory)** — Detection holds no more than one page's text content at a time; extracted text is discarded after parsing.
- **NFR-4 (cross-platform)** — All logic lives in `src/renderer/js/` and `src/shared/`. No new `window.api` method, no platform branch. Must behave identically under `npm run verify:web` (the Android WebView engine).
- **NFR-5 (purity/testability)** — All parsing and arithmetic lives in a new pure module under `src/shared/` with the repo's dual Node/browser export, and is covered by `npm test` (vitest). The renderer module holds only PDF/DOM access and state writes.
- **NFR-6 (accessibility, WCAG AA)** — The Detected tab is keyboard-navigable, its rows are a real list with accessible names, Accept/Clear are real buttons with labels, and the toast uses the existing `aria-live` conventions (`util.js:104-113`).
- **NFR-7 (no new dependencies)** — Zero additions to `package.json`.
- **NFR-8 (offline)** — No network access at any point.
- **NFR-9 (security)** — All parsed values are treated as untrusted input from an arbitrary file: numeric bounds enforced (see §5), unit labels matched against an allowlist not interpolated, no regex vulnerable to catastrophic backtracking on adversarial text, and no parsed string reaches `innerHTML` without escaping.
- **NFR-10 (test coverage)** — A new `SMOKE_*` scenario in `src/main.js` with a matching assertion in `test/e2e/run.js`, per `CLAUDE.md`.

## 7. Data model sketch

Additive only. No existing field changes meaning; no migration.

```js
// state.scales[page] — unchanged shape plus provenance
{
  factor: Number,        // real units per scale-1 viewport point   (existing)
  unit: String,          // key of App.UNITS                        (existing)
  ratioLabel: String,    // human label, e.g. "1/4in = 1ft"         (existing)
  source: 'user' | 'embedded' | 'note',   // NEW; absent === 'user' (FR-34)
  confidence: 'high' | 'low',             // NEW; absent for user scales
  halfSize: true                          // NEW; only when FR-30 fired
}

// state.viewports[page][i] — unchanged shape plus provenance
{ id, vx, vy, vw, vh, factor, unit, ratioLabel, label,
  source: 'user' | 'embedded' }           // NEW

// state.scaleDetect — NEW, transient, not persisted to the sidecar
{
  status: 'idle' | 'running' | 'done',
  pages: {
    [page]: {
      state: 'applied' | 'review' | 'none' | 'failed' | 'undetectable',
      source: 'embedded' | 'note' | null,
      candidates: [ { factor, unit, ratioLabel, confidence } ],
      reason: String   // e.g. "sheet declares AS NOTED", "unreadable unit: furlongs"
    }
  }
}
```

**Persistence:** `state.scaleDetect` is derived and is **not** written to the
sidecar. `source` / `confidence` / `halfSize` on a scale **are** persisted with
that scale, so a reopened document knows which scales were the user's.

**Relationships:** a page has at most one page scale and any number of region
viewports. `measure.js:scaleFor` remains the sole resolver: region containing
the measurement's centroid wins, else page scale, else `null`. This feature adds
producers only; it does not touch the resolver.

## 8. Regression boundary — what must not change

These are verified in Phase 5 as named checks, not assumed:

1. `scaleFor`'s region-over-page resolution order (`measure.js:70-77`).
2. Enter-scale and Calibrate-by-drawing, including "Apply to: All pages".
3. `save.js`'s `/Measure` export — same dictionaries, same values, for a user-set scale.
4. Sidecar save/restore of user scales and region viewports.
5. Measurement label formatting, including feet-inches mode.
6. Undo/redo across scale changes.
7. OCR: detection must not start, cancel, or alter an OCR run.
8. Open-path timing for a document with no detectable scale.

## 9. Residual risk (accepted)

Half-size inference (FR-29) is a heuristic: an 11×17 sheet genuinely drawn at
`1/4" = 1'-0"` full-size would be doubled incorrectly. Per D3 the user chose
auto-correction over flag-only, so this is mitigated rather than eliminated —
by the whole-document check in FR-29 (a mixed set never triggers it), the
mandatory toast and review flag in FR-31, the `(half-size)` label, and undo via
FR-39. A user who disagrees clears the row in the Detected tab.

---

*Every FR is testable, and every FR that a user can observe has an AC keyed to
it. Requirements with no AC (FR-3, FR-33, FR-34, FR-42) are structural and are
verified by unit test or code inspection.*
