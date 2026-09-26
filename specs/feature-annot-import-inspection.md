# Inspection: Make other apps' annotations editable

**Phase 5 (inspector) · slug `annot-import` · 9/25/2026 · verdict: PASS**

## Gates

| Gate | Result |
|------|--------|
| `npm test` | 25 files, 580 tests pass (16 new in `annot-import.test.js`) |
| `npm run test:e2e` | 74/74 pass, including the new `annotation import` scenario. One earlier full run had the `tooltips` scenario fail once; it passed alone and on the full rerun, and it touches nothing this change does. |
| `npm run verify:web` | PASS |

## SMOKE_ANNOT_IMPORT result (sample.pdf)

13 markups exported with no sidecar, plus a calibrated length (`/Measure`) and a
native Stamp.

- Offered 13, not 14: the takeoff line is excluded (D3).
- Converted 13, every type and page correct. Largest error: rect/ellipse 1 pt,
  text 2 pt (FieldMark's `/Rect` padding, see spec notes); all others 0.
- After import pdf.js draws only `Line` (takeoff) and `Stamp`: no double draw.
- One undo: 0 markups and all 15 originals back. Redo: 13 markups, originals gone.
- Saved `/Annots`: 13 markups + 1 takeoff line + 1 Stamp = 15, no duplicates.
- Reopened: 13 editable markups through the sidecar, import offered 0 times,
  page draws only the takeoff line and Stamp.

## Security

No new capability across `window.api`, no filesystem or network access. Input
is the already-open PDF; malformed dictionaries are skipped (type-checked reads,
`/RD` sanity check), and a failed import leaves the document unchanged and says so.
