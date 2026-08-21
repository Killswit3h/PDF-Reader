# Spec — Arc Length measurement

Phase 2. Contract. Follows the radius measurement feature (#100) and reuses its
3-point construction. EARS requirements, Given/When/Then acceptance criteria.

## Goal

An estimator taking off a curved run — guardrail, curb, pipe, fence — gets its
**length along the curve** in calibrated units, so a sheet calling
`PROP. 214 LF OF GUARDRAIL` can be verified rather than trusted.

The radius tools shipped in #100 already trace such an arc correctly; they
report the radius, which is a different quantity and not the one a linear-feet
takeoff needs.

## Decision taken

**A separate tool, not a change to the radius tools.** Each measure tool exports
the geometry whose measurement equals the value it reports, so a recipient's
viewer and FieldMark always agree. Arc Length exports the traced arc (whose
polyline length *is* the arc length); the radius tools keep exporting the radius
segment. Nothing that works today changes.

This is the one case where exporting the tessellated arc — rejected for radius
in `feature-radius-measure-spec.md` FR-13 precisely because it would report the
arc length — is the correct choice, because here the arc length is the point.

## Requirements

**FR-1** — The system shall provide an **Arc Length** measure tool taking three
clicks — one end of the run, a point along it, the other end — finalizing on the
third click, the same construction as 3-Point Radius.

**FR-2** — The system shall report the length **along the arc** between the two
outer points, in the units of the governing scale, resolved region-beats-page
like every other measurement.

**FR-3** — The system shall label the value as a plain distance, with the
feet-inches toggle applying as it does to a length, consistent with FR-7a of the
radius spec.

**FR-4** — When the three points are collinear or near-collinear, the system
shall refuse the measurement and say why, exactly as the radius tools do — no
`Infinity` or `NaN` may reach the model.

**FR-5** — The system shall draw the traced arc as a true curve, unfilled, so
what is measured is what is drawn. No pie wedge: the wedge implies an enclosed
area, and nothing here measures area.

**FR-6** — The measurements panel shall also show the arc's **radius** as
secondary information, so one trace yields both numbers without a second tool.

**FR-7** — The system shall export the measurement as a calibrated dimension
annotation whose recomputed value **equals the reported arc length**, so the
number in Bluebeam matches the number in FieldMark.

> Exported as `PolyLine` with `/IT /PolyLineDimension` over the tessellated arc,
> carrying the usual `/Measure`. A recipient's viewer sums the polyline, which is
> the arc length. Chord tessellation slightly under-measures a curve, so the
> density is chosen to keep that error below display precision — see AC-3.

**FR-8** — An arc length measurement shall survive save and reopen as a live,
editable object, like every other measurement.

## Acceptance criteria

**AC-1 — The length is correct.**
*Given* a calibrated page, *when* three points are clicked on a circle of known
radius spanning a known angle, *then* the reported value equals `r × θ` in the
scale's units, within rounding.

**AC-2 — Collinear input is refused.**
*Given* the Arc Length tool, *when* three collinear points are clicked, *then* no
measurement is created and no non-finite number enters
`App.state.measurements`.

**AC-3 — The exported number equals the reported one.**
*Given* a saved file containing an arc length measurement of value L, *when* the
PDF is parsed, *then* the annotation carries `/Measure`, `/IT
/PolyLineDimension` and an appearance stream, **and** its summed polyline length
times the calibration factor equals L to within **0.01 ft** — below the two
decimals the label displays. Asserted in `verify:tools`.

**AC-4 — Round-trip.**
*Given* a document with an arc length measurement saved and reopened, *then* it
returns editable with its value unchanged.

**AC-5 — Feet-inches applies.**
*Given* a page scaled in feet with the toggle on, *then* the label reads in
architectural feet-inches.

## Error handling

| Condition | Response |
|---|---|
| 3 collinear / near-collinear points | Refuse; explain an arc length needs a curve |
| No scale on the page | `(set scale)` label + existing prompt |
| Vertex dragged into a collinear state | Hold the last valid arc; never write `NaN` |

## Scope boundaries

**In scope:** one new measure type end to end — arm, draw, preview, compute,
render, select, drag, colour/width, panel row with the radius as secondary,
export, round-trip; unit tests; `SMOKE_ARCLEN`; `verify:tools` parity assertion.

**Not in scope:**
- A centre-plus-sweep variant of arc length (the 3-point trace is what a curved
  run on a plan sheet gives you). Backlog if wanted.
- Chaining several arcs into one running total.
- Changing anything about the two radius tools.

## Regression boundary — verified before merge

- `radius3` and `radiusCenter` report, draw and export exactly as they do today,
  including the `verify:tools` value-parity rows passing **unmodified**.
- All six original measure types unchanged.
- The #98 round-trip still restores every measurement type.
