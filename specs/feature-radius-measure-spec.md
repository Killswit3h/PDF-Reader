# Spec — Radius measurement (3-Point and Center Radius)

Phase 2. The contract. Requirements are EARS-format; acceptance criteria are
Given/When/Then. Anything not written here is out of scope.

## Goal

An estimator measuring a curved feature — a cul-de-sac, a curb return, a tank —
gets its radius the way Bluebeam gives it: pick three points along the arc, or
pick the centre and one point on it. The number reads in the page's calibrated
units, the shape draws as a true curve, and the measurement survives save and
reopen like every other measurement.

## Decisions taken (open questions from Phase 1, resolved)

- **3-Point Radius draws Revu's filled pie-piece**, not a bare arc — the backlog
  cites Revu's behaviour explicitly and the fill makes the swept region legible
  on a dense drawing.
- **Center Radius draws a full circle by default**; dragging along the arc draws
  only that section. Also Revu's behaviour, per the backlog.
- **Export reports the radius itself, not the drawn curve.** The annotation's
  measurement geometry is the radius segment (centre -> circumference); the arc
  or pie is drawn in the appearance stream. Decided by the repo owner: the value
  must be identical in FieldMark and in the recipient's viewer. See FR-13.

## Requirements

### The tools

**FR-1** — The system shall provide two new measure tools, **3-Point Radius**
(`radius3`) and **Center Radius** (`radiusCenter`), armed from the Measure menu
the same way every existing measure tool is.

**FR-2** — When the 3-Point Radius tool is armed, the system shall take three
clicks — one end of the arc, a point along it, the other end — and finalize the
measurement automatically on the third click, the way `angle` finalizes on its
third point.

**FR-3** — When the Center Radius tool is armed, the system shall take the first
click as the centre and the second as a point on the circumference, and finalize
on the second click.

**FR-4** — Where the user drags along the arc during a Center Radius draw rather
than clicking, the system shall draw only the swept section; a click without a
drag shall produce a full circle.

**FR-5** — While either tool has an incomplete draw, the system shall show a live
preview that updates with the pointer, consistent with the existing tools.

### The value

**FR-6** — The system shall report the **radius** as the measurement's value, in
the units of the governing scale, resolved region-beats-page through the same
`scaleFor` path every other measurement uses.

**FR-7** — The system shall format the radius with the active display options, so
the feet-inches toggle applies to it exactly as it applies to a length.

**FR-8** — Where no scale is set for the page, the system shall show the existing
`(set scale)` cue and prompt to set one, rather than showing a number in points.

### Degenerate geometry

**FR-9** — When the three points of a 3-Point Radius are collinear or
near-collinear, the system shall refuse to create the measurement and tell the
user why, rather than producing an infinite or `NaN` radius.

> A circumcircle through collinear points does not exist; the determinant goes
> to zero. Unguarded this writes `Infinity`/`NaN` into the model, which then
> corrupts the saved sidecar and the exported annotation. This is the one
> failure mode of this feature that can damage a file.

**FR-10** — When a Center Radius draw has a zero-length radius (both clicks on
the same point), the system shall discard the draw rather than storing a
degenerate measurement.

### Drawing

**FR-11** — The system shall draw both measurements as true curves, with no
visible faceting at any supported zoom level.

**FR-12** — When a radius measurement is selected, the system shall offer drag
handles on its defining points, and moving a handle shall redefine the circle
and update the reported radius live — the behaviour existing measurements have.

### Export

**FR-13** — The system shall export both types as calibrated dimension
annotations whose measured value **equals the radius**, so the number shown in
Bluebeam or Acrobat is the same number FieldMark shows.

> **How, and why this way.** PDF has no radius dimension type — Acrobat and
> Bluebeam have none either. But a viewer recomputes a measurement from the
> annotation's *geometry*, and that geometry is ours to choose. So the exported
> geometry is the **radius segment** (centre to a point on the circumference) as
> a `Line` with `/IT /LineDimension`, carrying the usual `/Measure`; the arc or
> pie the user drew is rendered in the appearance stream. The recipient's viewer
> measures the radius segment against the same calibration and arrives at the
> same value. This reuses two paths already proven in this codebase: the
> `length` tool exports `Line`/`LineDimension`, and every measure type already
> ships a custom `/AP`.
>
> Two accepted consequences, neither a number mismatch:
> 1. The recipient's viewer labels it a length/distance measurement, not a
>    radius — PDF has no radius type to name. The value is correct.
> 2. If the recipient *edits* the annotation in their viewer, it may regenerate
>    the appearance from the line geometry and replace the arc with a plain
>    line. The value stays correct; only the drawing degrades, and only on
>    deliberate edit.
>
> Rejected: exporting the tessellated arc as the geometry (the recipient would
> read the arc length or enclosed area — a different number from ours, which is
> the outcome this requirement exists to prevent), and `/Circle` (not a
> dimension annotation; drops out of the recipient's measurement list).

**FR-14** — The exported appearance shall render the same shape and the same
label text the user sees on screen.

**FR-15** — A radius measurement shall survive save and reopen as a live,
editable object, through the round-trip sidecar, like every other measurement.

## Acceptance criteria

**AC-1 — 3-point radius is correct.**
*Given* a page calibrated at a known scale, *when* the user clicks three points
lying on a circle of known radius, *then* the reported value equals that radius
in the scale's units, within rounding.

**AC-2 — Centre radius is correct.**
*Given* a calibrated page, *when* the user clicks a centre and a point at a known
distance, *then* the reported value equals that distance in the scale's units.

**AC-3 — Collinear input is refused.**
*Given* the 3-Point Radius tool, *when* the user clicks three points on a
straight line, *then* no measurement is created and the user is told why, and
`App.state.measurements` gains no entry containing `Infinity` or `NaN`.

**AC-4 — Full circle vs section.**
*Given* the Center Radius tool, *when* the user clicks twice without dragging,
*then* a full circle is drawn; *when* the user drags along the arc, *then* only
the swept section is drawn.

**AC-5 — Feet-inches applies.**
*Given* a page scaled in feet and the feet-inches toggle on, *when* a radius
measurement exists, *then* its label reads in feet-inches notation.

**AC-6 — The exported number equals the radius.**
*Given* a page calibrated at a known scale and a radius measurement of known
radius R, *when* the saved PDF is parsed, *then* the annotation carries a
`/Measure` dictionary, an `/IT`, and an appearance stream, **and** the length of
its measurement geometry multiplied by the calibration factor equals R — the
same value FieldMark displays. This is asserted in `verify:tools`, so a drift
between the two sides fails the gate rather than shipping.

**AC-7 — Round-trip.**
*Given* a document with both radius types saved and reopened, *then* both return
as editable measurements with their radii unchanged.

**AC-8 — No scale set.**
*Given* an uncalibrated page, *when* a radius measurement is drawn, *then* its
label reads `(set scale)` and the existing prompt appears.

## Error handling

| Condition | Response | Surface |
|---|---|---|
| 3 collinear / near-collinear points | Refuse; explain a radius needs a curve | Toast, draw discarded |
| Centre and edge click identical | Discard silently, like any too-short draw | None |
| No scale on the page | `(set scale)` label + existing prompt | Existing toast |
| Vertex dragged into a collinear state | Keep the last valid circle; do not write `NaN` | Live preview holds |
| Export of a degenerate measurement | Cannot occur — FR-9/FR-10 prevent storing one | — |

## Scope boundaries

**In scope:** two new measure types end to end — arm, draw, preview, compute,
render, select, drag, edit colour/width, panel row, export, round-trip; radius
math in `src/shared` with Node unit tests; a `SMOKE_*` scenario; `verify:tools`
coverage.

**Explicitly not in scope:**
- Diameter as a separate tool or a radius/diameter display toggle.
- Arc *length* as a measurement (a different quantity; backlog if wanted).
- Snapping a radius to detected drawing geometry beyond the existing vertex snap.
- Any change to how the six existing measure types compute, draw or export.
- Making the recipient's viewer *name* the measurement "Radius". PDF has no such
  type; FR-13 guarantees the value matches, not the type label.
- Preserving the arc drawing if a recipient deliberately edits the annotation in
  another viewer (it may regenerate the appearance from the line geometry).

## Regression boundary — verified before merge

- `length`, `continuous`, `perimeter`, `area`, `angle`, `count` draw, finalize,
  compute, render and export **unchanged**.
- Calibration, scale regions, and region-beats-page resolution unchanged.
- Measurement drag, vertex drag, live recompute and vertex snapping unchanged
  for existing types.
- The measurements panel, per-measurement colour/width, and the feet-inches
  toggle behave as before.
- The #98 round-trip still restores every existing measurement type.
- `npm run verify`, `verify:web`, `verify:tools` all green; the existing 3
  measurement subtype assertions in `verify:tools` still pass.
