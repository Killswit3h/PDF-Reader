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
through the real renderer, exports, re-parses the bytes, and asserts the
annotation each tool produced — subtype, dimension intent, calibration,
appearance stream, and for text markups that the mark actually changes pixels.
The tables below are that script's contract.

## Markup tools — export status

All fourteen export as live annotations when "save editable annotations" is on.
Flattening still happens when the setting is off, unchanged.

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
| texthighlight | `Highlight` + `/QuadPoints` + `/AP` | yes |
| underline | `Underline` + `/QuadPoints` + `/AP` | yes |
| strikeout | `StrikeOut` + `/QuadPoints` + `/AP` | yes |

## Measure tools — export status

| Tool | Subtype | `/IT` | `/Measure` |
|---|---|---|---|
| length | `Line` | `LineDimension` | yes |
| perimeter | `PolyLine` | `PolyLineDimension` | yes |
| continuous | `PolyLine` | `PolyLineDimension` | yes |
| area | `Polygon` | `PolygonDimension` | yes |
| angle | `PolyLine` | — | no — degrees, no scale applies |
| count | `Polygon` | — | no — a tally, no scale applies |

Every measurement carries an `/AP` appearance stream reproducing the strokes and
the rotation-corrected label exactly as the flattened path drew them, so the
visual result is unchanged while the geometry, calibration and value become
machine-readable.

## Closed: quad-based text markups

Highlight, underline and strikeout used to be drawn straight into page content
regardless of the editable-annotations setting. A reviewer who highlighted text
and sent the PDF to a colleague on Revu gave them a coloured box they could not
select, recolour, reply to, or find in a markup summary.

They now export as the three PDF text-markup subtypes Acrobat and Revu create for
the same actions, positioned by `/QuadPoints`. Quad corner order is upper-left,
upper-right, lower-left, lower-right — the order Acrobat writes and every real
viewer expects, whatever the spec's own prose says about counter-clockwise.

**The `/AP` is the load-bearing part.** A text markup with no appearance stream
relies on the viewer to synthesise one. Acrobat does; plenty do not. Shipping
without it would have produced highlights that are *invisible* in some of the
software this exists to interoperate with — which is why it was specified rather
than implemented on the first pass. It is now generated, with highlight fills
under a `Multiply` blend so the text underneath stays readable, and
`verify:tools` renders the exported page with annotations on and off and requires
the pixels inside each markup's rect to differ. A missing or malformed `/AP`
fails the gate instead of shipping an invisible mark.

## Closed: measurements carry their calibration

Measurements used to be drawn into page content with nothing about the scale
surviving. They were pictures of numbers: a Revu user receiving a takeoff could
not verify it, adjust it, extend it, or pull it into a quantity summary.

Each measurement now exports as a dimension annotation carrying a `/Measure`
dictionary (ISO 32000 §12.9) — `/Subtype /RL` rectilinear, an `/R` ratio string,
and `/X` `/D` `/A` number formats. `/X` holds the conversion from PDF user-space
units into the calibrated unit, which is exactly the factor the app already
tracks; `/D` and `/A` then read in those same units.

The scale is resolved through `Measure.scaleFor()`, the same function the
on-screen label uses, so a region scale still beats the page scale and the
exported calibration can never disagree with the number the user is looking at.

## Still open

- **`/Squiggly`.** Acrobat and Revu offer a wavy text underline; we have no such
  tool. Now trivial — same quad path as underline with a different subtype and
  appearance.
- **Per-region scale UI.** Revu supports different scales on different regions of
  one sheet, common when a detail sits on a plan. The plumbing exists —
  `computeValue` takes an explicit scale and `scaleFor` already prefers a region
  — but there is no UI to define regions beyond the existing viewport tool.
- **Volume / depth.** Revu carries a depth on area measurements to produce
  volume. No equivalent here.
- **Quantity export.** `Measure.exportCsv` exists, but there is no export of
  measurement data *into the PDF* as a summary the way Revu produces takeoff
  reports.

## Correctness fixes landed alongside

- `Geom.bbox` and `save.js` derived bounding boxes with `Math.min(...points)`.
  Past ~124,900 points the spread exceeds the engine's argument limit and throws
  `RangeError`. Ink points are throttled to 1.2 units apart, so sustained
  hatching on a large sheet reaches it. In `bbox` that broke drawing; in
  `save.js` it failed the **entire export**, losing the user's work. Both now
  scan with a loop, with a 250k-point regression test.
- `Geom.centroid` returned `{NaN, NaN}` for an empty set, which flowed into
  measurement label placement. Now returns the origin.
- The e2e suite could not run at all on a machine with FieldMark installed and
  open: `main.js` pinned `userData` over the per-spawn `--user-data-dir`, so
  every scenario collided with the installed app's single-instance lock and quit
  with exit 0 and no output. Both are now skipped under `SMOKE_TEST`.

## Verification

```bash
npm run verify        # 307 unit tests + 55 headless-Electron e2e scenarios
npm run verify:web    # the www/ bundle in real Chromium (Android WebView parity)
npm run verify:tools  # per-tool export contract — the tables above
```

## Sources

- [Bluebeam — Takeoffs and Measuring](https://support.bluebeam.com/online-help/revu20/Content/RevuHelp/Unsorted/Takeoffs-and-Measuring--T.htm)
- [Bluebeam — Perimeter measurement](https://support.bluebeam.com/online-help/revu21/Content/RevuHelp/Menus/Tools/Measure/Perimeter--MTV.htm)
- [Adobe — Annotation and drawing markup tools](https://helpx.adobe.com/sg/acrobat/using/commenting-pdfs.html)
- [Mapsoft — PDF annotation types](https://mapsoft.com/posts/pdf-annotations.html)
