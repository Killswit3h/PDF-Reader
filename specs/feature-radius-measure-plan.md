# Build plan — Radius measurement (3-Point and Center Radius)

Phase 3. Implements `feature-radius-measure-spec.md`. No stack decision: vanilla
JS on the global `App` object, no bundler, renderer-only, no new dependencies,
per CLAUDE.md. Two new measure types following every existing convention.

## Shape of the change

Two new types, `radius3` and `radiusCenter`, threaded through the same six type
tables every existing measure type already lives in. The genuinely new work is
narrow:

1. **Circumcircle math** — new, pure, unit-tested.
2. **Curve rendering** — the measure layer has never drawn an arc.
3. **Curve in the appearance stream** — the AP builder has never emitted a
   curve operator.
4. **Decoupling drawn shape from measured geometry** — the crux of FR-13.

Everything else (arming, preview, finalize, select, drag, panel, colour/width,
round-trip) is inherited by adding the types to the existing tables.

## Integration contract

### `src/shared/geometry.js` — new pure helpers

- `circumcircle(a, b, c)` → `{ vx, vy, r }` or **`null` when degenerate**.
  Collinearity is detected on the cross-product determinant against a relative
  epsilon, not an absolute one, so it behaves the same on a 1:20 detail and a
  1:2000 key sheet. Returning `null` rather than throwing is what lets FR-9 be a
  clean refusal at the call site.
- `arcToBezier(c, r, a0, a1)` → cubic segments, each spanning at most 90°.
  Used by the export appearance stream. PDF has no arc operator; `c` is the
  standard approximation and keeps the file small.
- `arcPoints(c, r, a0, a1, n)` → sampled points. Used **only** for bounding-box
  math, not for drawing.

### `src/shared/measure-math.js` — `computeValue`

Add both types before the `!scale` guard is applied the same way as length:

- `radiusCenter` → `dist(pts[0], pts[1]) * scale.factor`
- `radius3` → `circumcircle(...).r * scale.factor`, and `{ value: null }` if the
  circumcircle is null, so an impossible circle can never produce a number.

`fmtMeasure` needs a `radius` branch that formats like a length (so FR-7's
feet-inches toggle applies for free) and prefixes `R `.

### `src/renderer/js/measure.js`

- `COLORS`: `radius3`, `radiusCenter` (distinct hues, not colliding with the six).
- `NEEDS_SCALE`: both true.
- `LINEAR`: **neither** — a radius is not a running polyline length, and adding
  it would draw per-segment leg labels that mean nothing.
- `_commitActive` `need` map: `radius3` 3, `radiusCenter` 2.
- `handleClick`: auto-finalize `radius3` on the 3rd point and `radiusCenter` on
  the 2nd, mirroring how `angle` and `length` already terminate.
- `finalize`: for `radius3`, refuse and toast when `circumcircle` is null
  (FR-9); for `radiusCenter`, discard a zero-length draw (FR-10).
- `drawMeasurement`: new branch drawing an SVG `<path>` with the `A` arc command
  — a true curve at any zoom, satisfying FR-11 without tessellating on screen.
  Pie for `radius3` (`M centre L p0 A … Z`, filled like `area`), circle or
  section for `radiusCenter`. Reuse the existing `m-shape` / `m-fill` / `m-hit`
  classes so selection, dragging and styling come along unchanged.
- `drawPreview`: live arc while drawing (FR-5).
- Handles: `vhandle` on the defining points (FR-12).
- `liveRecompute` during a vertex drag: when the drag passes through a collinear
  state, **hold the last valid circle** rather than writing `NaN` (error table).

### `src/renderer/js/save.js` — the FR-13 crux

`writeMeasureAnnot` currently derives three things from one array `P`: the
appearance-stream path, the `/Rect` bounding box, and the measurement geometry
(`/L` or `/Vertices`). For radius these must come apart:

| Output | Radius source |
|---|---|
| Appearance path | the arc/pie, via `arcToBezier` → `c` operators |
| `/Rect` bbox | `arcPoints` extremes + label anchor (must contain the curve) |
| `/L` | **centre → circumference point** — the radius segment |
| `/IT` | `LineDimension`, with `Subtype` `Line` |
| `/Measure` | unchanged; the existing RL dictionary |

The bbox loop changes from scanning `P` to scanning an explicit `shapePts` list,
which is `P` for every existing type and the sampled arc for radius. **That is
the only change to shared export behaviour, and it is a no-op for the six
existing types** — same input, same output.

- `MAP`: `radius3` and `radiusCenter` → `['Line', 'LineDimension']`.
- `M_COLORS`: both, mirroring `measure.js` `COLORS`.

> `COLORS` and `M_COLORS` are duplicated verbatim across two files. This plan
> edits both rather than refactoring mid-feature; a backlog note records the
> duplication so a later change fixes it deliberately.

### `src/renderer/index.html`

Two `<button data-mtool="radius3">` / `data-mtool="radiusCenter"` entries in the
measure menu, plus two `<symbol id="i-radius3">` / `#i-radius-center` sprite
icons. No handler wiring: `app.js:677` already dispatches any `data-mtool` to
`App.Measure.startTool`.

## Work order

| # | Task | FRs |
|---|---|---|
| 1 | `circumcircle` + `arcToBezier` + `arcPoints` in shared geometry, with unit tests | FR-9 |
| 2 | `computeValue` + `fmtMeasure` radius branches, with unit tests | FR-6, FR-7, FR-8 |
| 3 | Type tables + `handleClick` arity + `finalize` guards | FR-1, FR-2, FR-3, FR-9, FR-10 |
| 4 | Arc rendering: shape, preview, handles | FR-5, FR-11, FR-12 |
| 5 | Center Radius drag-for-section | FR-4 |
| 6 | Export: decouple shape/bbox/geometry; `/L` = radius segment | FR-13, FR-14 |
| 7 | Menu buttons + sprite icons | FR-1 |
| 8 | Tests: unit, `SMOKE_RADIUS`, `verify:tools` value-parity assertion | AC-1..8 |

Tasks 1–2 are pure and land first; everything after depends on them. Task 6 is
the one with cross-type risk and gets the regression run.

## Risk — task 6 touches shared export code

Changing the bbox source in `writeMeasureAnnot` is the only edit that runs for
existing measure types. It must be provably a no-op for them: `shapePts` is
assigned `P` on every path except radius. `verify:tools` already asserts
`length`, `perimeter` and `area` export with the right `/IT`, `/Measure` and
appearance stream, and those assertions must pass **unmodified**.

Secondary risk: `/Rect` too small clips the drawn arc in other viewers. The
bbox is computed from sampled arc points rather than the two `/L` endpoints
precisely to avoid this, and the existing generous `pad` is kept.

## Test plan

**Unit** (`test/unit/`, vitest over `src/shared`) — the real safety net here,
since the math is where a radius silently goes wrong:
- `circumcircle`: a known circle recovered exactly; collinear → `null`;
  near-collinear at a realistic drawing tolerance → `null`; point order
  independence.
- `arcToBezier`: segment count for arcs above and below 90°; endpoints land on
  the circle.
- `computeValue`: both types against known radii; `null` scale → `null` value;
  degenerate `radius3` → `null` value rather than `NaN`.
- `fmtMeasure`: radius formats as a length and honours feet-inches.

**New `SMOKE_RADIUS`** in `src/main.js` with assertions in `test/e2e/run.js`:
- AC-1/AC-2: draw both against a known scale, assert the reported radii.
- AC-3: three collinear clicks create no measurement and leave no `NaN` in
  `App.state.measurements`.
- AC-4: click-only gives a full circle; a drag gives a section.
- AC-7: save, reopen, both return editable with radii unchanged (drives
  `App.Viewer.load`, the tab path fixed in #98).

**`verify:tools`** — add both types to the matrix and assert **AC-6**: parse the
saved PDF, take the `/L` length, multiply by the calibration factor, and check
it equals the radius FieldMark reported. This is the assertion that makes FR-13
a guarantee rather than an intention.

**Gates** — `npm run verify`, `verify:web`, `verify:tools`.

## Regression boundary — verified before the PR

- All six existing measure types draw, finalize, compute, render and export
  unchanged; the existing `verify:tools` subtype assertions pass unmodified.
- Calibration, scale regions, region-beats-page resolution unchanged.
- Measurement drag, vertex drag, snapping, panel, colour/width, feet-inches
  toggle unchanged.
- The #98 round-trip still restores every existing measurement type.

## Branching

Fresh from `origin/main` (currently `72f4af4`) per CLAUDE.md, branch
`feat/radius-measure`. Specs committed first, then one Conventional Commit per
work-order task referencing its FRs. Draft PR on inspection PASS; the maintainer
merges.
