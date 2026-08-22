# Research Brief — Automatic per-page scale detection

Feature request: *"Is there any way FieldMark can automatically get the scale of a
page, even if a PDF has multiple pages with multiple scales?"*

Phase 1 of the build pipeline. Codebase-first. No design, no code here.

---

## 1. Problem statement

Today every scale in FieldMark is entered by hand. To measure anything the user
must open the Scale modal and either type a ratio (`1/4in = 1ft`) or draw a
calibration line over a known dimension — **once per page**, because
`App.state.scales` is keyed by page number. On a 120-sheet drawing set where the
plans are `1/8" = 1'-0"`, the sections are `1/4" = 1'-0"` and the details are
`1 1/2" = 1'-0"`, that is 120 manual calibrations before the first takeoff, and
every one is a chance to key the wrong number and silently corrupt every
measurement on that sheet.

The scale is almost always *already in the file* — either as machine-readable
measurement metadata written by the CAD/BIM exporter, or as a human-readable
note in the title block ("SCALE: 1/4" = 1'-0""), or as a drawn graphic bar
scale. The feature is to read it instead of asking for it, per page, and to be
honest when it can't.

## 2. Users and jobs to be done

| User | Job |
|---|---|
| Estimator doing takeoff | Open a 100-sheet bid set and start measuring on sheet 47 without stopping to calibrate it first |
| Field superintendent (Android tablet) | Check a dimension on site — calibrating by hand on a touch screen is the worst part of the workflow |
| Anyone opening a mixed set | Have plan sheets, detail sheets and NTS sheets each get the *right* scale, or an honest "unknown", rather than one wrong scale smeared across the document |

The "multiple pages with multiple scales" part of the request is the core of the
job. FieldMark's data model already supports it (see §3); what is missing is the
*population* of that model.

## 3. Existing codebase findings

Stack (confirmed): vanilla JS on a global `App` object, no bundler, PDF.js
`3.11.174` + pdf-lib `1.17.1`, Electron + Capacitor. Both libraries are loaded
as plain globals in `src/renderer/index.html:1040-1042` (`pdfjsLib`,
`window.PDFLib`).

### 3.1 The scale model already supports multiple scales per document

`src/renderer/js/util.js:38-45` — `App.state`:

```js
// Per-page scale: { [page]: { factor, unit, ratioLabel } }
// factor = real-world units per scale-1 viewport point.
scales: {},
// Per-page viewports (regions with their own scale):
// { [page]: [ { id, vx, vy, vw, vh, factor, unit, ratioLabel, label } ] }
viewports: {},
```

**This is the key finding: the model is already per-page, and already supports
multiple scaled *regions* within one page.** Nothing about the data model needs
to change to answer the user's question. The feature is a *producer* for
`state.scales` / `state.viewports`, not a schema change.

Resolution order is settled and must not change — `src/renderer/js/measure.js:70-77`:

```js
function scaleFor(page, pts) {
  const c = centroid(pts);
  const vps = App.state.viewports[page] || [];
  for (const v of vps) {
    if (c.vx >= v.vx && c.vx <= v.vx + v.vw && c.vy >= v.vy && c.vy <= v.vy + v.vh) return v;
  }
  return App.state.scales[page] || null;
}
```

Region beats page; `null` means "(set scale)" is shown instead of a number
(`measure.js:61-63`). `M.scaleFor` is deliberately exported so `save.js` resolves
the identical scale when writing the export (`measure.js:89`, used at
`save.js:652-654`) — a comment there warns that resolving it any other way would
let the exported scale disagree with the on-screen number. **Any auto-detection
must feed `state.scales`/`state.viewports` and let `scaleFor` stay the single
resolver.**

### 3.2 Units and the factor convention

`src/shared/measure-math.js:26-33` — `UNITS` maps a unit to **points per unit**
(despite the key name `perPoint`): `in: 72`, `ft: 864`, `yd: 2592`,
`mm: 72/25.4`, `cm: 72/2.54`, `m: 7200/2.54`.

`measure.js:710-718` shows the exact arithmetic a detected ratio must reproduce:

```js
const drawPts = dv * App.UNITS[du].perPoint;  // drawn length -> points
factor = rv / drawPts;                        // real units per point
ratioLabel = `${dv}${du} = ${rv}${unit}`;
```

`src/shared/measure-math.js:155-157` already notes a helper exists to convert an
"enter scale" ratio into a factor, "handy for tests + presets" — so the pure,
unit-tested home for detection arithmetic is `src/shared/`, consistent with the
repo's convention.

### 3.3 FieldMark already *writes* PDF measurement metadata but never *reads* it

`src/renderer/js/save.js:469-484` writes an ISO 32000 §12.9 `/Measure`
dictionary onto every measurement annotation:

```js
md.set(PDFName.of('Type'), PDFName.of('Measure'));
md.set(PDFName.of('Subtype'), PDFName.of('RL'));   // rectilinear
const perInch = scale.factor * 72;
md.set(PDFName.of('R'), PDFString.of(`1 in = ${(+perInch.toFixed(4))} ${scale.unit}`));
md.set(PDFName.of('X'), mk([numberFormat(ctx, scale.unit, scale.factor)]));
```

and `numberFormat` (`save.js:289-299`) builds the `NumberFormat` dict with
`/U` = unit label and `/C` = user-space-units → unit conversion.

**Reading is the exact inverse of code that already exists in this repo.** The
comment at `save.js:473` even states the equivalence the reader will rely on:
`scale.factor` (real units per scale-1 viewport point) "is real units per PDF
user-space unit, which is exactly the conversion /X wants".

What is *not* present: FieldMark never reads `/VP` (page-level viewport array) or
`/Measure` from an **incoming** file. Confirmed by grep — the only `Measure`
hits in `save.js` are writes, and there are zero `/VP` references anywhere in
`src/`.

- **PDF.js cannot help here.** `grep -c getViewportList node_modules/pdfjs-dist/build/pdf.min.js` → `0`. PDF.js 3.11 exposes no API for page `/VP`.
- **pdf-lib can, using a pattern already in the file.** `save.js:174-180` reaches the raw page dictionary via `page.node.Annots()` / `page.node.set(PDFName.of(...))`. `page.node.get(PDFName.of('VP'))` is the same move. `App.state.pdfBytes` keeps the original bytes (`util.js:16`), so a `PDFDocument.load` is available at any time, not just at save.

### 3.4 Text extraction infrastructure already exists

`src/renderer/js/ocr.js:108-116` already calls `page.getTextContent()` to decide
whether a page has a text layer:

```js
const tc = await page.getTextContent();
return (tc.items || []).some((it) => it && typeof it.str === 'string' && it.str.trim().length > 0);
```

For **vector** PDFs (anything plotted from CAD/Revit) the title-block scale note
is in that text layer with position data — every `item` carries a `transform`
giving its placement. For **scanned** sheets, `App.state.ocr[page].words` already
holds `{text, vx, vy, vw, vh, conf}` in the same scale-1 viewport coordinate
space as everything else (`util.js:67-71`), so an OCR'd sheet can feed the same
parser with no second pipeline.

`src/shared/ocr-layout.js` is the precedent for putting this kind of pure
text/geometry logic in a unit-tested shared module.

### 3.5 Integration points (files that will be touched)

| File | Why |
|---|---|
| `src/shared/` (new module, e.g. `scale-detect.js`) | Pure parsing of scale notes → `{factor, unit, ratioLabel}`; pure `/Measure` → factor arithmetic. Dual Node/browser export like every other shared module. Unit-tested by `npm test`. |
| `src/renderer/js/measure.js` | Owns the scale model and the Scale modal (`M.openScaleModal`, `applyScale`, `M.recomputeAll`). Where detected scales land and where a review UI belongs. |
| `src/renderer/js/viewer.js:545-568` | The open routine — sets `numPages`, `baseViewports`, and calls `Viewer._rehydrate(sidecar.data)`. Detection has to hook after open **without** clobbering a rehydrated sidecar's user scales. |
| `src/renderer/index.html` | Script tag for the new shared module; any new modal/panel markup. |
| `src/main.js` + `test/e2e/run.js` | A new `SMOKE_*` scenario is mandatory per `CLAUDE.md` for a new renderer feature (148 `SMOKE_` references already). |

### 3.6 Page geometry available for validation

`App.state.baseViewports[page-1]` is the PDF.js scale-1 viewport
(`viewer.js:129-130`), giving each page's width/height in PDF points with
`/Rotate` already applied. This is what lets a detector sanity-check a parsed
note against the physical sheet size (see §6, half-size plots).

## 4. Prior art

**Bluebeam Revu** is the direct competitor and does exactly this, in two tiers:

- It **automatically detects viewports created in a CAD or BIM program**, which is what allows multiple scales on the same sheet; measurements pick up the scale of the viewport they land in, and the viewport is highlighted with its scale when you measure in it ([Bluebeam Viewports help](https://support.bluebeam.com/online-help/revu20/Content/RevuHelp/Menus/Window/Panels/Measurements/Defining-Multiple-Scale-Viewports.htm), [DDSCAD](https://ddscad.com/viewports-scales-in-bluebeam-revu/)).
- It exposes a **"Use Embedded Scale"** control, i.e. the file's own metadata is treated as a distinct, trusted source separate from user calibration ([Taradigm](https://www.taradigm.com/how-to-add-remove-and-use-viewports-in-bluebeam-revu-2019/)).

**What to copy:** the two-tier model — trusted embedded metadata first, user
calibration always able to override; and surfacing *which* scale governs a
measurement rather than hiding it.

**What to avoid / the big caveat:** the embedded scale only exists if the PDF was
produced by the Bluebeam plugin for Revit or AutoCAD — *"unlike if you just hit
Print/Plot or CTRL+P"* ([Autodesk forum thread](https://forums.autodesk.com/t5/revit-architecture-forum/embedded-scale-units-in-pdf-exports-missing-feature/td-p/13644739)). In practice most sheets in a bid set have **no** embedded scale. So a
metadata-only feature would fire on a small minority of real files, and the
text-note tier is what makes this useful on the documents users actually get.

Bluebeam's own troubleshooting confirms the failure mode that makes blind trust
dangerous: a PDF plotted with "Shrink to Fit" or a driver/page-scaling setting
comes out **not to scale**, so the title block still says `1/4" = 1'-0"` while the
geometry is not ([Bluebeam: PDF isn't to scale when printing from AutoCAD](https://support.bluebeam.com/revu/troubleshooting/pdf-isnt-to-scale-when-printing-from-autocad.html)). A detector that silently
believes the note will produce confidently wrong takeoffs — worse than no
detection at all. Users also report measurements being off for exactly this
class of reason ([Ascent](https://resources.ascented.com/ascent-blog/if-your-bluebeam-measurements-are-off-this-might-be-why)).

## 5. Recommended building blocks

No new dependencies. `CLAUDE.md` forbids the frontend track from adding any, and
none are needed — every capability required is already loaded.

| Block | Reason | Rejected alternative |
|---|---|---|
| **pdf-lib `page.node.get(PDFName.of('VP'))`** for embedded `/VP` + `/Measure` | Already the repo's way of touching raw page dicts (`save.js:174-180`), and reading `/X`→`/C` is the literal inverse of `save.js:469-484`. Gives exact, per-*region* scales — which is precisely the "multiple scales on one page" case. | PDF.js — has no `/VP` API at all in 3.11 (verified: 0 matches). |
| **PDF.js `page.getTextContent()`** for title-block scale notes | Already used at `ocr.js:111`; items carry position, so a note can be located in the title-block region and its confidence weighted. Covers the majority of real files, which have no embedded scale. | Regex over raw content streams — brittle, no positions, breaks on font subsetting. |
| **Existing `App.state.ocr[page].words`** to extend note-parsing to scans | Same `{text, vx, vy, vw, vh}` shape and same coordinate space; one parser serves vector and scanned sheets. | A second OCR pass dedicated to scale — duplicates the pipeline in `ocr.js`. |
| **A new pure module in `src/shared/`** for note parsing + factor arithmetic | Repo convention (`measure-math.js`, `ocr-layout.js`); gets `npm test` coverage and runs identically on Android via `verify:web`. | Logic inside `measure.js` — untestable without Electron. |
| **`App.state.baseViewports[p-1]`** to validate a parsed note against sheet size | Detects the half-size / shrink-to-fit trap of §4 before a wrong scale reaches a takeoff. | Trusting the note — the documented cause of wrong measurements. |

## 6. Constraints and risks

- **Correctness risk is the dominant one.** A wrong auto-scale is more damaging than no auto-scale: it produces plausible numbers on a bid. Everything about this feature — confidence levels, review step, provenance labelling, honest "unknown" — exists to manage that. This is the single most important input to the spec.
- **Half-size / shrink-to-fit plots.** A `1/4" = 1'-0"` note on a sheet plotted at 50% is off by 2×. Detectable by comparing `baseViewports[p-1]` against standard sheet sizes (ANSI D 22×34, ARCH D 24×36, ANSI B 11×17 …) — an 11×17 page whose note implies a 22×34 sheet is a half-size plot. Needs a spec decision: correct it, flag it, or refuse.
- **`SCALE: AS NOTED` / `AS SHOWN`** is common on detail sheets and explicitly means *this sheet has several scales, per detail*. Setting one page scale there is wrong; this string is a signal to **not** set a page scale. Likewise `NTS` / `NOT TO SCALE`.
- **Must not clobber user work.** `viewer.js:559` rehydrates a sidecar that can already carry user-set scales, and `applyScale`'s "apply to all pages" writes every page (`measure.js:729-732`). Detection must never overwrite a scale the user set or restored. `App.History.snapshot()` (`measure.js:722`) is the existing undo hook.
- **Cross-platform rule.** This is renderer-only + `src/shared/` — it ships to Windows, macOS and Android for free, and needs **no** new `window.api` method. That is the cheap, correct shape; a spec that pushes any of it into `preload.js` would be a mistake.
- **Performance.** A 200-sheet set must not stall on open. `getTextContent()` per page is not free; detection should be lazy/deferred or budgeted rather than blocking the open path at `viewer.js:556`.
- **Scanned sheets** yield nothing until OCR has run. Graceful degradation to today's manual behaviour is required, not optional.
- **Offline.** No network at runtime — no cloud OCR, no lookup service. All tiers above are local.
- **Test environment note:** the `feat/auto-scale` worktree has no `node_modules` (they live in the main checkout). `npm ci` will be needed there before `npm run verify` / `verify:web`.

## 7. Open questions for the Spec Designer

1. **How many tiers ship in v1?** Candidates, in descending reliability: (A) embedded `/VP`+`/Measure` metadata, (B) title-block text-note parsing, (C) graphic bar-scale detection from vector geometry. (C) is materially harder and is a natural `specs/backlog.md` item. Recommendation to confirm with the user: **A + B**.
2. **Automatic or reviewed?** Given §6's correctness risk, does a detected scale apply silently, or land in a per-page review list the user confirms? Recommendation: **apply high-confidence automatically, but always show provenance and make it one click to review/override.**
3. **Provenance in the model.** `{factor, unit, ratioLabel}` has no room to say *where a scale came from*. Adding a `source: 'user'|'embedded'|'note'` (plus confidence) is a small additive change — but the spec must confirm it and confirm the sidecar/round-trip implications.
4. **Half-size plots** — correct automatically, flag, or refuse? (See §6.)
5. **`AS NOTED` / `NTS`** — leave the page unscaled silently, or mark it explicitly as "multiple scales, set per region"?
6. **Region-level detection.** Embedded `/VP` gives per-*region* scales, which map onto `state.viewports`, not `state.scales`. Does v1 populate regions, or collapse a page's viewports to a single page scale when they all agree?
7. **Which unit does a detected imperial architectural ratio produce** — `ft` (matching `1/4" = 1'-0"` as written and the feet-inches formatter at `measure-math.js:35-40`) or `in`? Recommendation: **`ft`**.

---

*Codebase claims are cited to file and line at the state of branch `feat/auto-scale`. External claims are linked inline in §4.*
