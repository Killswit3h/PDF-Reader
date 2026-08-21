# Research brief — Radius measurement (3-Point and Center Radius)

Phase 1. Backlog item: *"Radius measurement — 3-Point and Center Radius"*.
Codebase-first, per CLAUDE.md. No new dependencies; renderer-only.

## What the user asked for

Bluebeam ships two separate tools, and the backlog records both:

- **3-Point Radius** — click one end of the arc, a point along it, then the
  other end. Revu draws a pie-piece and reports the radius.
- **Center Radius** — click the centre, then a point on the circumference.
  Draws a full circle by default, or drag along the arc to draw only a section.

Both must export as calibrated dimension annotations "the way the existing
measure tools now do" — `/Measure` + `/IT`, per `writeMeasureAnnot`.

## How the existing measure system is built

Traced end to end. It is unusually clean and the new tools should not fight it.

**Coordinates.** Everything is stored in scale-1 viewport points, top-left
origin, rendered at `pt * zoom`, exported through `viewport.convertToPdfPoint`.
The radius tools inherit this for free.

**Math is pure and shared.** `src/shared/measure-math.js` exports
`computeValue(type, pts, scale)` taking an explicit `{factor, unit} | null`
rather than reading `App.state`. `measure.js` resolves *which* scale applies
(region beats page, `scaleFor`) and hands off. Geometry primitives live in
`src/shared/geometry.js` (`dist`, `angleAt`, `centroid`, `shoelace`, `polyLen`,
`bbox`). **Radius math belongs in `measure-math.js`/`geometry.js`, unit-tested
in Node** — same precedent as `serializeMarkupModel` in #99.

**Tool state machine** (`measure.js`):
- `M._tool` = armed tool name; `M._active = { tool, page, pts, hover }`.
- `handleClick` pushes a point, then auto-finalizes fixed-arity tools:
  `length` at 2 points, `angle` at 3. Open-ended tools finish on Enter/dbl-click.
- `_commitActive()` has a `need` map (`area` 3, `angle` 3, `count` 1, else 2)
  deciding whether a partial draw is kept or discarded.
- `finalize(a)` builds `{ id, page, type, pts, value, unit, color, width, label }`
  and pushes to `App.state.measurements`.

**Type tables that must all learn the new types** — these are the integration
points, and missing one is the likely bug:

| Table | File | Purpose |
|---|---|---|
| `COLORS` | `measure.js:17` | per-type default draw colour |
| `NEEDS_SCALE` | `measure.js:21` | whether "set a scale" is prompted |
| `LINEAR` | `measure.js:23` | running-length types (segment labels) |
| `need` map | `measure.js` `_commitActive` | minimum points to keep a draw |
| `MAP` | `save.js` `writeMeasureAnnot` | type → `[Subtype, /IT]` |
| `M_COLORS` | `save.js:40` | **duplicate** of `COLORS`, for export |

`COLORS` and `M_COLORS` are duplicated verbatim across two files today. Adding a
type means editing both; they are already out of sync risk.

**Rendering** (`drawMeasurement`, `measure.js:322`) draws `polyline` /
`polygon` only, plus vertex dots, an invisible wide hit-line for dragging, and
drag handles when selected. **There is no arc or curve rendering anywhere in the
measure layer.** This is the single largest piece of new work.

**Export** (`writeMeasureAnnot`) maps type → PDF annotation subtype, builds an
appearance stream from straight `m`/`l` path ops, then attaches `/Measure` (a
rectilinear `/Subtype /RL` dictionary carrying the calibration) and the label.
**The AP builder emits no curve (`c`) operators either.**

**UI registration** is small: a `<button data-mtool="…">` in the measure menu
(`index.html:220-227`) plus an `<svg><use href="#i-…">` icon in the sprite. The
handler is generic — `app.js:677` calls `App.Measure.startTool(b.dataset.mtool)`
for any `data-mtool`, so no new wiring is needed beyond the button and icon.

## The hard finding: PDF has no radius dimension type

This is the constraint that should shape the spec, and it is worth deciding
deliberately rather than discovering during the build.

The PDF measurement vocabulary in use here is `LineDimension`,
`PolyLineDimension`, `PolygonDimension`. **There is no `RadiusDimension`.**
Acrobat and Bluebeam do not have one either — Revu stores its radius
measurements as ordinary polygon/polyline geometry with its own private keys
carrying the radius semantics.

That leaves a real trade-off:

1. **Tessellate the arc/circle into vertices** and export as
   `Polygon`/`PolygonDimension` (the pie) or `PolyLine`/`PolyLineDimension`
   (a bare arc), carrying the usual `/Measure`. Interops with everything, and
   the drawn shape is exactly right.
   *Cost:* a recipient's viewer that recomputes the value from the geometry will
   report the **arc length or polygon area, not the radius**. Our own `/AP`
   label will read the correct radius, and reopening in FieldMark restores the
   true radius from the sidecar — but the other viewer's own measurement panel
   will disagree with the printed label.

2. **Export as `/Circle`** (an ellipse annotation). Visually correct for the
   full-circle case, but `/Circle` is not a dimension annotation, cannot carry
   a meaningful `/IT`, and would drop out of a recipient's measurement list
   entirely. Worse for the stated goal.

Option 1 is the recommendation. The disagreement in (1) is inherent to the
format, not to our implementation, and the spec should state it plainly rather
than let a user discover it in Bluebeam. It also matches the existing
`angle` precedent, which is deliberately exported with **no** `/Measure`
because degrees are scale-free — there is prior art here for "export the
geometry honestly, and don't claim a `/Measure` the format cannot express."

An arc also needs Bézier `c` operators in the appearance stream, which the AP
builder does not emit today; a tessellated polyline sidesteps that too, at some
cost in file size (a 64-segment arc is 64 vertices).

## Geometry required

Both are small, pure, and unit-testable:

- **Circumcircle of 3 points** (3-Point Radius): centre = intersection of the
  perpendicular bisectors; radius = distance to any of the three. **Degenerate
  case: three collinear points have no circumcircle** (infinite radius) — the
  determinant goes to zero and must be guarded, or the tool divides by ~0 and
  produces `Infinity`/`NaN` coordinates that would corrupt the saved model.
- **Centre + circumference point** (Center Radius): radius is just `dist`.
  The arc extent for the drag-a-section variant is two angles.

## Regression surface

Neighbouring behaviour that must still pass, since the radius tools touch shared
code paths:

- `length`, `continuous`, `perimeter`, `area`, `angle`, `count` all still draw,
  finalize, compute and export unchanged.
- Calibration (`calibrate`), scale regions (`viewport`), and region-beats-page
  resolution via `scaleFor`.
- Drag (`startMeasureDrag`) and vertex drag (`startVertexDrag` + `liveRecompute`
  + `snapDragPoint`) — a radius shape's vertices redefine its circle, so the
  generic recompute must not produce nonsense mid-drag.
- The measurements panel, per-measurement colour/width editing, the feet-inches
  toggle, and the round-trip sidecar (a radius measurement must survive
  save/reopen as an editable object, per #98).
- `verify:tools` currently asserts 3 measurement subtypes export correctly; it
  must keep passing and should grow to cover the new ones.

## Recommendation into Phase 2

Two new types, `radius3` and `radiusCenter`, following every existing
convention: pure math in `src/shared`, the six type tables updated together,
tessellated export as dimension annotations with the format limitation stated
in the spec, a `SMOKE_*` scenario, and Node unit tests for the circumcircle
including the collinear guard.

Open for the spec to decide: whether the 3-point tool draws Revu's filled
pie-piece or just the arc, and whether Center Radius defaults to a full circle
(Revu's behaviour) or requires the drag.
