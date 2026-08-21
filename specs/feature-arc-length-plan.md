# Build plan — Arc Length measurement

Phase 3. Implements `feature-arc-length-spec.md`. Renderer-only, no new
dependencies, following the radius feature's shape exactly — most of the
machinery it needs already exists.

## What is genuinely new

Almost nothing structural. `circumcircle`, `arcSpanThrough`, `arcToBezier`,
`arcPoints` and the arc renderer all shipped in #100. The new work is:

1. One more type threaded through the same tables.
2. The arc-length arithmetic (`r × θ`).
3. **Tessellation density** — the one place this feature can be quietly wrong.
4. Exporting `/Vertices` instead of `/L`.

## The one real engineering decision: how finely to tessellate

A polyline through points on a curve is always **shorter** than the curve. Over
`N` segments spanning `θ`, the exported polyline measures
`2Nr·sin(θ/2N)` against a true arc of `rθ` — a relative shortfall of
approximately `δ²/24`, where `δ = θ/N` is the per-segment angle.

That matters because FR-7 promises the recipient's number matches ours. Working
it backwards for the worst realistic case — a 200 ft run displayed to two
decimals, so the error budget is 0.01 ft, i.e. 5×10⁻⁵ relative:

| δ per segment | relative error | on a 214 ft arc |
|---|---|---|
| 5° | 3.2×10⁻⁴ | 0.069 ft — **visible at 2 dp** |
| 2° | 5.1×10⁻⁵ | 0.011 ft — borderline |
| **1°** | **1.3×10⁻⁵** | **0.003 ft — safe** |

So: **δ = 1°**, clamped to at least 24 segments (so a short arc is still smooth)
and at most 720 (so a full sweep cannot bloat the file unboundedly). A 292°
cul-de-sac run becomes ~292 vertices, which is unremarkable for a PDF.

`arcTessellationSegments(theta)` goes in `src/shared/geometry.js` as a pure
function with the error bound in its comment, and is unit-tested — the numbers
above are the reason it exists, and they should not have to be re-derived.

## Integration contract

### `src/shared/geometry.js`
- `arcTessellationSegments(theta)` → segment count per the rule above.

### `src/shared/measure-math.js`
- `circleOf` and `arcSpanOf` accept `arcLength`, treating it exactly as
  `radius3` (same 3-point construction).
- `computeValue`: `arcLength` → `c.r * Math.abs(a1 - a0) * scale.factor`, and a
  `null` value when the circle is degenerate, never `NaN`.
- `fmtMeasure`: falls through to the length branch — a plain distance, per FR-3.

### `src/renderer/js/measure.js`
- `COLORS`, `NEEDS_SCALE`, `CAP` (3), `TYPE_LABEL` (`arc length`).
- A new `ARC` membership alongside `RADIUS` so the shared arc drawing is reused
  with **no pie and no fill** (FR-5). The dashed radius spoke is also dropped:
  the radius is not what this tool measures, and drawing it would invite reading
  the wrong number off the sheet.
- Panel row shows the radius as secondary text (FR-6).
- `finalize` guard and the live "in line — no arc" readout are inherited by
  adding `arcLength` to the existing membership checks.

### `src/renderer/js/save.js`
- `MAP`: `arcLength` → `['PolyLine', 'PolyLineDimension']`.
- `M_COLORS`: add it (the duplication already noted in the backlog).
- In the radius branch, `arcLength` sets `P` to the **tessellated arc points**
  rather than the radius spoke, so the existing
  `else set('Vertices', numArr(flat))` path exports them unchanged, and
  `shapePts` is the same array. The appearance stream keeps drawing the smooth
  Bézier curve — tessellation is for the measurement geometry only.

### `src/renderer/index.html`
- One `<button data-mtool="arcLength">` and one sprite icon. No handler wiring.

## Work order

| # | Task | FRs |
|---|---|---|
| 1 | `arcTessellationSegments` + unit tests for the error bound | FR-7 |
| 2 | `computeValue` / `circleOf` / `arcSpanOf` for `arcLength` + unit tests | FR-2, FR-3, FR-4 |
| 3 | Type tables, arc drawing without pie or spoke, panel radius | FR-1, FR-5, FR-6 |
| 4 | Export as `PolyLineDimension` over the tessellated arc | FR-7 |
| 5 | Button + icon | FR-1 |
| 6 | Tests: `SMOKE_ARCLEN`, `verify:tools` parity assertion | AC-1..5 |

## Risk

Low. The only shared-code edit is one more branch in `writeMeasureAnnot`'s
already-split `P`/`shapePts` handling, which #100 introduced and which is a
no-op for every other type.

The real risk is silent under-measurement from too-coarse tessellation, which is
why AC-3 asserts the exported value by number rather than checking that a
`PolyLine` merely exists.

## Test plan

**Unit** — `arcTessellationSegments` (clamps, and that δ stays ≤1°);
`computeValue` for a quarter, half and 292° arc of known radius; degenerate
input → `null`; label formats as a length.

**`SMOKE_ARCLEN`** in `src/main.js` + `test/e2e/run.js`: a known arc's value,
collinear refusal with no non-finite numbers, feet-inches label, a real curve
drawn, and round-trip.

**`verify:tools`** — add an `arcLength` row and assert **AC-3**: sum the exported
`/Vertices` polyline, apply the calibration, and check it equals the reported arc
length within 0.01 ft.

**Regression** — the two `verify:tools` radius parity rows must pass unmodified.

**Gates** — `npm run verify`, `verify:web`, `verify:tools`.

## Branching

Fresh from `origin/main` (currently `b4ccc61`, v1.23.0), branch
`feat/arc-length`. Draft PR on PASS.
