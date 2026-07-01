# Measure-by-Scale — Research Report + Build Plan

How Bluebeam Revu structures its measurement tools, and a concrete plan to add
"measure by scale" to **this** app (Electron + PDF.js + pdf-lib). Written to slot
into the existing architecture in `src/renderer/js/` (viewport-point storage,
`viewport.convertToPdfPoint`, overlay `<div>`s, pdf-lib export).

---

## Part A — How Bluebeam Revu is structured (context)

Bluebeam Revu is a Windows-first PDF markup + **measurement/takeoff** + collaboration
tool for construction/AEC. Measurement is not a side feature — it's the axis the
whole product is priced on.

**Editions / tiers (subscription, Revu 21 era):** Basics → Core → Complete → Max,
each bundling Revu desktop + Bluebeam Cloud (web/mobile) + Studio.
- **Basics:** Length + Area measurement only.
- **Core:** full measurement suite incl. Count and multi-scale viewports.
- **Complete:** adds **Dynamic Fill** + **Excel Quantity Link** + batch tools.
- **Max:** adds scripting + AI.
- (Legacy perpetual editions were Standard / CAD / eXtreme; automation lived in eXtreme.)

**Core product concepts (how everything is organized):**
- **Markups** — every annotation/measurement is a PDF annotation.
- **Tool Chest** — reusable custom tools + tool sets (standardize takeoff symbology).
- **Profiles** — saved UI layouts (toolbars/panels/columns) per role.
- **Sets** — many PDFs combined into one navigable package.
- **Markups List** — a live spreadsheet of every annotation (author, status, geometry,
  and measurement columns: Length/Area/Volume/Count/Depth/Slope/Angle). Custom
  columns (e.g. unit price) drive estimating; exports to CSV/XML; feeds Excel.
- **Studio Sessions** (real-time co-markup) and **Studio Projects** (doc management
  with check-in/out + version history).
- **Compare Documents / Overlay Pages**, **OCR**, redaction, stamps, signatures,
  forms, **Batch** tools (Batch Link, Slip Sheet, Sign & Seal).

**Estimator mental model:** open a Set → **calibrate scale per page** → take off
quantities (Area/Length/Volume/Count, aided by Visual Search + Dynamic Fill) →
read totals in the Markups List → Quantity Link to Excel.

> For "measure by scale," the parts that matter are the **scale/calibration model**
> and the **measurement types + their math** (Part B), plus the **Markups List**
> data model as inspiration for how to store/summarize results.

---

## Part B — Measurement + scale, in detail (what to replicate)

### The scale model
Scale is an **equation**: `(length on the drawing) = (length in the real world)`.
The two sides may use different units/systems. Stored **per page** (apply to
current / all / selected / range). Three ways to set it:

1. **Preset** — pick a standard architectural/engineering scale (`1/4" = 1'-0"`, `1:50`).
2. **Custom** — type both sides with independent units; can be saved as a preset.
3. **Calibrate** (recommended) — draw a line over a known dimension, then type its
   real length. This is the robust one because it doesn't trust the PDF's authoring scale.

Extras: **Separate Y scale** (independent X/Y factors for distorted scans),
**precision** (decimal places or fraction denominator), and **Viewports**
(rectangular regions on a page that carry their own scale — multi-scale sheets).

### Measurement types and what each outputs
| Type | Output |
|---|---|
| Length | 2-point distance |
| Polylength / Perimeter | multi-segment total (and per-segment) |
| Area | polygon/rectangle area; supports **cutouts** and **slope** |
| Volume | area × **depth**; also yields **Wall Area** ≈ perimeter × depth |
| Angle | angle from 3 points |
| Radius / Diameter | center+edge, or 3-point |
| Arc | 3-point |
| Count | one symbol per click, running total; legends auto-update |
| Dynamic Fill | auto-detect an enclosed region → area/perimeter (Complete/Max) |

### The calibration math (the important part)
Work entirely in **PDF user-space points** (1 pt = 1/72"). Calibration gives a
**scale factor** = real units per PDF point:

```
scaleFactor = realLength / pdfLength      // pdfLength = distance between the two drawn points, in points
length_real = pdfLength * scaleFactor
area_real   = pdfArea   * scaleFactor²    // squared, because area is 2-D  → unit²
volume_real = area_real * depth
wallArea    ≈ perimeter_real * depth
```
With Separate Y scale, area uses `scaleX * scaleY`.

> Keep this **separate** from any "display PPI" ruler calibration (true-size on
> screen). Page scale governs measurement values and is resolution-independent
> because it lives in PDF points, not screen pixels.

### PDF's native measurement format (for interoperability, optional)
The PDF spec (ISO 32000 §8.7.4 / §12.9) encodes scale via three linked dictionaries
on the page's `/VP` array:
- **Viewport** (`/BBox` region + `/Measure`) — one per scale region.
- **Measure** subtype `/RL` (rectilinear): `/R` = display ratio string (e.g. `"1:100"`),
  `/X` `/Y` = axis number-formats, `/D` distance, `/A` area, `/T` angle, `/O` origin.
- **NumberFormat**: `/U` unit label, `/C` conversion factor, `/F` fraction style,
  `/D` precision, separators/prefix/suffix.

The **real scale lives in `X[0].C`** (real units per point); `/R` is just a label —
keep them in sync. Writing these makes measurements readable in Acrobat, but pdf-lib
has no high-level API for it (low-level `context.obj(...)` only). **For a first
version, a JSON sidecar / custom annotation metadata is far simpler and sufficient;
reserve the spec dictionaries for interop/export later.**

---

## Part C — Build plan for THIS app

The good news: the hard part is already solved here. This app already stores
placements in **scale-1 viewport points** and maps to PDF space via
`viewport.convertToPdfPoint`. Measurement reuses the exact same coordinate
foundation — you're adding an overlay-drawing tool + a scale factor + formulas.

### C.0 What we already have to build on
- `App.state.baseViewports[pageIndex]` — scale-1 `PageViewport` per page (with rotation).
- Per-page overlay `<div>` (`.page-overlay`) sized to `viewport.width*zoom × height*zoom`.
- The convention: store geometry in **scale-1 viewport points**, render at `× zoom`,
  export via `convertToPdfPoint`. Measurement will follow the identical pattern.
- `viewer.js` re-renders overlays on zoom; `placement.js` shows the drag/resize +
  delete pattern to imitate.

### C.1 Data model (add to `App.state`)
```js
// Per-page scale calibration (real units per scale-1 viewport point).
App.state.scales = {};        // { [pageIndex]: { factor, unit, ratioLabel } | null }

// Measurement records — geometry in scale-1 viewport points, top-left origin.
App.state.measurements = [];  // see shape below
App.state.measureSeq = 0;

// A measurement:
// {
//   id, page,                       // 1-based page
//   type: 'length'|'area'|'perimeter'|'angle'|'count',
//   pts: [{vx,vy}, ...],            // vertices in scale-1 viewport points
//   value, unit,                    // computed real-world value + unit ('ft', 'ft²', '°', 'ct')
//   label                           // cached display string, e.g. "24.10 ft"
// }
```
Note the reuse: `vx,vy` are the **same coordinate space** as `placement.js`, so a
measurement at scale-1 points renders at `vx*zoom` and exports with
`convertToPdfPoint(vx, vy)` — no new coordinate logic.

### C.2 New module `src/renderer/js/measure.js`
Responsibilities (mirrors `placement.js` structure):
1. **Modes:** `calibrate`, `measure-length`, `measure-area`, `measure-perimeter`,
   `measure-angle`, `count`. Reuse the existing mode banner + `App.setMode`.
2. **Drawing:** click to add vertices on the page overlay; for length/area draw an
   SVG polyline/polygon into the overlay so it scales cleanly. Double-click / Enter
   closes a polygon; Esc cancels.
3. **Live readout:** while drawing, show the running length/area near the cursor.
4. **Convert on click:** `overlay.getBoundingClientRect()` → `(clientX-left)/zoom` gives
   `vx` (identical to `placement.handleOverlayClick`).

**Math helpers (all in scale-1 points, then × factor):**
```js
const dist = (a,b) => Math.hypot(b.vx-a.vx, b.vy-a.vy);          // in points
function polyLenPts(p){ let s=0; for(let i=0;i<p.length-1;i++) s+=dist(p[i],p[i+1]); return s; }
function shoelacePts(p){ let s=0; for(let i=0;i<p.length;i++){ const j=(i+1)%p.length;
  s += p[i].vx*p[j].vy - p[j].vx*p[i].vy; } return Math.abs(s)/2; }               // points²

function lengthReal(p, sc){ return polyLenPts(p) * sc.factor; }                   // real units
function areaReal(p, sc){ return shoelacePts(p) * sc.factor * sc.factor; }        // real units²
function angleDeg(A,B,C){ const a=Math.atan2(A.vy-B.vy,A.vx-B.vx),
  b=Math.atan2(C.vy-B.vy,C.vx-B.vx); let d=(b-a)*180/Math.PI; d=((d%360)+360)%360;
  return d>180?360-d:d; }
```
Angles are unaffected by scale. (Compute consistently in one space; sign of y is
irrelevant to an unsigned interior angle.)

### C.3 Calibration workflow
1. User picks **Calibrate** → mode `calibrate`, banner "Draw a line of known length."
2. User clicks 2 points → you have `d = dist(p0,p1)` in scale-1 points.
3. Open a small modal (reuse the modal styling): "This line is [___] [unit ▾]"
   (units: in, ft, mm, cm, m, yd). Optionally "apply to: this page / all pages."
4. `factor = realLength / d` (converted so `factor` is **real units per point**);
   store `App.state.scales[page] = { factor, unit, ratioLabel }`. Build
   `ratioLabel` like `1" = X ft` for display.
5. Also allow a **preset/custom** path (dropdown of common scales → precomputed factor).

Guardrails: if a page has no scale and the user starts a measurement, prompt to
calibrate first (Bluebeam shows "Scale Not Set").

### C.4 Rendering (in `viewer.renderAll` → after `Placement.repositionAll`)
Add `Measure.repositionAll()`: for each measurement on a page, draw an SVG overlay
(polyline/polygon + a caption label). Because geometry is in scale-1 points, the
render is `pt * zoom` — same as placements. Re-runs on every zoom change for free.

### C.5 Save / export (extend `save.js` `buildBytes`)
Two options, do the simple one first:
- **V1 (visual flatten):** draw the measurement lines + caption text onto the page
  with pdf-lib using the **existing corner-mapping** (`convertToPdfPoint`) already in
  `save.js`. Lines via `page.drawLine`, captions via `page.drawText`. This "bakes"
  measurements into the PDF like the signatures already are.
- **V2 (interop, later):** additionally write `/VP` + `/Measure` + `/NumberFormat`
  dicts and Line/Polygon measurement annotations so Acrobat/Bluebeam recognize them
  as real measurements. Low-level pdf-lib; validate in Acrobat.

### C.6 A "Measurements" summary panel (optional, Bluebeam's Markups List lite)
A side list of all measurements (page, type, value, unit) with per-type totals and a
**Export CSV** button. This is where the feature becomes genuinely useful for takeoff.

### C.7 Suggested phased delivery
1. **Calibrate + Length** (single 2-point distance, live readout, V1 flatten). Smallest
   vertical slice that proves the scale math end-to-end.
2. **Perimeter + Area** (polyline/polygon, shoelace, unit²).
3. **Angle + Count.**
4. **Measurements summary panel + CSV export.**
5. **Multiple scales per page (viewports)** — hit-test a measurement's centroid against
   viewport rects to pick the governing factor.
6. **Spec-compliant `/Measure` export (V2)** for Acrobat/Bluebeam interop.
7. **Snapping** (endpoints → square cue, on-segment → circle, ortho on Shift). Big
   precision win; add once the basics feel good.

### C.8 Snapping (when you get to it)
Snap the cursor before committing a vertex: nearest existing vertex within ~10 px
(convert to points), else project onto nearby segments; ortho-constrain direction to
0/45/90° while Shift is held. Index vertices in a simple grid if drawings get large.

### Reference implementations worth reading
- **Xatpy/pdf-ruler** — vanilla PDF.js + canvas overlay ruler; closest to this stack.
- Mozilla **pdf.js** `PageViewport` (`convertToPdfPoint` / `convertToViewportPoint`).
- **Apryse** "PDF Measurement Implementation Guide" (calibration + shoelace + `/Measure` serialization).
- **PDF.js Express / Nutrient** measurement docs for the `Scale = [[docVal,unit],[realVal,unit]]` model.

---

## Sources
Bluebeam (official): support.bluebeam.com measurement/calibrate/viewports/markups-list
pages, bluebeam.com/pricing. Spec: ISO 32000-1:2008 §8.7.4 / §12.9 (Adobe's free PDF
32000 copy). Web viewers: Apryse, Nutrient/PSPDFKit, PDF.js Express measurement docs.
OSS: github.com/Xatpy/pdf-ruler, mozilla/pdf.js. (Full URL list captured in the
research notes for this task.)
