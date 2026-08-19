# Tool parity — FieldMark vs Bluebeam Revu and Adobe Acrobat

Status of every shipped tool against the two products construction users compare
us to. Written to answer one question per tool: **does our output survive being
opened in their software?**

The measure of "production ready" for a markup tool is not that it looks right on
our canvas. It is that a PDF we export, opened in Revu or Acrobat, shows the mark
as a *live object* the reviewer can select, recolour, reply to, and include in a
markup list. Anything we draw into the page content stream instead is flattened
pixels — visually identical, permanently dead.

`npm run verify:tools` is the automated gate on this. It drives every tool
through the real renderer, exports, re-parses with PDF.js, and asserts the
annotation subtype each tool produced. The table below is that script's contract.

## Markup tools — export status

Verified by `scripts/verify-tools.js` on the built bundle.

| Tool | PDF subtype exported | Live in Revu / Acrobat |
|---|---|---|
| rect | `Square` | yes |
| ellipse | `Circle` | yes |
| line | `Line` | yes |
| arrow | `Line` + `/LE OpenArrow` | yes |
| polyline | `PolyLine` | yes |
| polygon | `Polygon` | yes |
| cloud | `Polygon` + `/BE` cloudy border | yes |
| ink | `Ink` | yes |
| highlight (freehand) | `Ink`, wide `/BS`, `CA 0.35` | yes |
| text | `FreeText` | yes |
| callout | `FreeText` + `/IT FreeTextCallout` | yes |
| **texthighlight** | **none — flattened** | **no** |
| **underline** | **none — flattened** | **no** |
| **strikeout** | **none — flattened** | **no** |

Eleven of fourteen already round-trip correctly. That is a stronger starting
position than it looks: the shape, freehand and text tools are the ones most used
on plan sheets, and they are already interoperable.

### Gap 1 — quad-based text markups are flattened (highest priority)

`save.js` short-circuits `texthighlight`, `underline` and `strikeout` before the
`writeRealAnnot` path and draws them as rectangles and lines into page content,
regardless of the "save editable annotations" setting.

PDF defines dedicated text-markup subtypes for exactly these three — `/Highlight`,
`/Underline`, `/StrikeOut` (plus `/Squiggly`, which we do not offer) — positioned
by a `/QuadPoints` array rather than a rect. Acrobat and Revu both create and
consume them, and both list them in the markup/comments panel.

Consequence today: a reviewer who highlights text in FieldMark and sends the PDF
to a colleague on Revu gets a yellow box the colleague cannot select, cannot
change, cannot reply to, and which never appears in a markup summary.

**Fix shape.** Add a `writeTextMarkupAnnot` alongside `writeRealAnnot`, emitting
the correct subtype with `/QuadPoints` per quad and a `/Rect` spanning them.
Quad corner order must be upper-left, upper-right, lower-left, lower-right —
what Acrobat writes and what every real viewer expects, notwithstanding the
spec's own wording.

**Do not ship it without an appearance stream.** Text-markup annotations with no
`/AP` rely on the viewer to synthesise one. Acrobat does; many viewers, including
some PDF.js configurations, do not — so a naive implementation risks highlights
that are *invisible* in the very tools we are trying to interoperate with. The
annotation must carry a generated `/AP` form XObject. This is why the change is
specified here rather than implemented blind: it needs visual confirmation in
real Acrobat and real Revu, which requires a desktop session.

### Gap 2 — measurements carry no `/Measure` dictionary

Every measurement (length, perimeter, area, angle, count) is drawn into page
content. Nothing about the scale survives the export.

Revu and Acrobat both persist measurement scale inside the annotation, so a
measurement stays a measurement after a round-trip — the recipient can click it
and see the calibrated value, and can keep measuring on the same scale. PDF
provides `/Measure` (a viewport-level dictionary carrying the unit conversion) for
this.

Consequence: our measurements are pictures of numbers. A Revu user receiving our
takeoff cannot verify, adjust, or extend it, and cannot pull it into a quantity
summary. For a takeoff product this is the difference between "a PDF with
numbers on it" and "a takeoff."

**Fix shape.** Emit measurements as `Line` / `PolyLine` / `Polygon` annotations
carrying `/IT` (`LineDimension`, `PolyLineDimension`, `PolygonDimension`), an
`/RC` rich-content label, and a page `/VP` viewport whose `/Measure` dictionary
encodes the calibration we already hold in `App.state` scale. Count tools map to
individual stamp-like annotations grouped by a shared subject.

This is the single highest-value item in this document for a construction
audience, and the largest. It should be its own spec and its own branch.

### Gap 3 — no `/Squiggly`

Acrobat and Revu offer a squiggly (wavy) text underline; we do not. Low priority,
trivial once Gap 1's quad infrastructure exists — it is the same code path with a
different subtype name.

## Measure tools — behavioural parity

Calibration in Revu follows a pattern we already match: pick two points whose real
distance is known, type that distance, and the scale applies to subsequent
measurements. Our `calibrate` tool and `ratioToFactor` implement the same model,
and `measure-math.js` keeps the arithmetic pure and unit-tested.

Where we are already good:

- **Feet-inches formatting.** `formatFeetInches` rounds in exact 1/denominator
  ticks and carries into feet, so 11.99" rolls to the next foot instead of
  printing as 11 63/64". Fractions reduce (8/16 → 1/2). This matches architectural
  convention and is covered by 11 tests.
- **Per-segment breakdown.** `segmentLengths` returns each leg of a polyline and
  closes the loop for areas, so the parts sum to the perimeter.
- **Scale-independent tools.** Angle and count correctly ignore scale.

Where the gap is behavioural rather than structural:

- **Per-region scale.** Revu supports different scales on different regions of one
  sheet (common when a detail sits on a plan). The code already threads a
  `scale` argument through `computeValue` rather than reading global state,
  specifically so page-vs-region resolution is possible — the plumbing is there,
  the UI is what is missing.
- **Volume / depth.** Revu carries a depth on area measurements to produce volume.
  We have no equivalent.
- **Quantity export.** Revu exports takeoff quantities to CSV/Excel. We have no
  export of measurement data at all — only the visual.

## Correctness fixes already landed on this branch

- `Geom.bbox` and `save.js` derived bounding boxes with `Math.min(...points)`.
  Past ~124,900 points the spread exceeds the engine's argument limit and throws
  `RangeError`. Ink points are throttled to 1.2 units apart, so sustained
  hatching on a large sheet reaches it. In `bbox` that broke drawing; in `save.js`
  it failed the **entire export**, losing the user's work. Both now scan with a
  loop, with a 250k-point regression test.
- `Geom.centroid` returned `{NaN, NaN}` for an empty set, which flowed into
  measurement label placement. Now returns the origin.

## Suggested order of work

1. **Gap 1** (text markups as real annotations, with `/AP`) — contained, high
   visible payoff, unblocks Gap 3.
2. **Gap 2** (measurement annotations with `/Measure`) — largest, and the one
   that makes takeoffs genuinely interoperable.
3. Per-region scale UI, then volume, then quantity export.

## Sources

- [Bluebeam — Takeoffs and Measuring](https://support.bluebeam.com/online-help/revu20/Content/RevuHelp/Unsorted/Takeoffs-and-Measuring--T.htm)
- [Bluebeam — Perimeter measurement](https://support.bluebeam.com/online-help/revu21/Content/RevuHelp/Menus/Tools/Measure/Perimeter--MTV.htm)
- [Adobe — Annotation and drawing markup tools](https://helpx.adobe.com/sg/acrobat/using/commenting-pdfs.html)
- [Mapsoft — PDF annotation types](https://mapsoft.com/posts/pdf-annotations.html)
