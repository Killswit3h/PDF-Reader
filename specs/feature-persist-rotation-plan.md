# Build plan — Save the orientation you saved it in

Phase 3. Implements `feature-persist-rotation-spec.md`. Renderer-only, no new
dependencies. Small in code, and the whole risk sits in one place.

## Where the risk is

Not in writing `/Rotate` — pdf-lib has `page.setRotation()`. It is in what
already depends on a page's rotation.

`save.js` maps every mark through `page.getViewport({ scale: 1 })` on the
**source** document, then writes into PDF **user space**. User space is
unaffected by `/Rotate`, which is a display instruction, so adding rotation to
the output page turns the page content and the marks together — they stay glued
to the drawing. That is why FR-6 is achievable at all.

The exposed part is **text orientation**. `save.js` already compensates for a
page's existing `/Rotate` when writing text-box and measurement labels (the
comments at `save.js:678` and `:800`, and the `textrot` scenario). Those
compensations are computed from the source viewport. Baking additional rotation
must not double-compensate them.

Since the marks and the labels both rotate with the page, the correct behaviour
is to leave the label maths **entirely alone** and let the whole page turn. The
plan therefore changes no label code, and `textrot` passing unmodified is the
evidence that this reasoning holds. If it fails, the assumption is wrong and the
approach needs revisiting before anything else is done.

## Integration contract

### `src/renderer/js/viewer.js`
- `Viewer.rotate()` also writes `App.state.rotation`, so the value lives in
  document state rather than only inside PDF.js.
- `Viewer.setRotation(deg)` to apply a stored value on open/tab-switch.
- `_showActive()` applies `App.state.rotation` when restoring a session.

### `src/renderer/js/tabs.js`
- `freshState()` gains `rotation: 0`; `DOC_FIELDS` carries it so `activate()`
  restores it — this alone fixes the tab-switch symptom (FR-1).

### `src/shared/rotation.js` — new, pure, unit-tested
- `addRotation(pageRotate, viewRotate)` → normalised `0|90|180|270`, handling
  absent, negative and non-multiple-of-90 input (error table). Tiny, but it is
  the arithmetic AC-2 and AC-5 turn on, and it should not be discovered wrong
  inside an Electron run.

### `src/renderer/js/save.js`
- After the page content is written and before the sidecar block, apply
  `App.state.rotation` to every page of `pdfDoc` via `setRotation(degrees(...))`
  using `addRotation`.
- Apply the same to `baseDoc` inside the sidecar block (FR-4). Same trap as
  bookmarks and #98: the base is what `Tabs.open` reopens.
- Guarded so a failure warns rather than failing the save.

### `src/renderer/js/app.js` (or the save path)
- After a successful save, reset the view rotation to 0 (FR-5). The document now
  carries the rotation; leaving the view rotated would show it twice over.

## Work order

| # | Task | FRs |
|---|---|---|
| 1 | `src/shared/rotation.js` + unit tests | FR-3, error table |
| 2 | Rotation into document + per-tab state, restored on activate | FR-1 |
| 3 | Bake into output and base on save | FR-2, FR-3, FR-4 |
| 4 | Reset the view after saving | FR-5 |
| 5 | Tests: `SMOKE_ROTPERSIST`, and confirm `textrot` unmodified | AC-1..7 |

## Test plan

**Unit** — `addRotation` across 0/90/180/270 combinations, wrap past 360,
negative input, `undefined`, and a non-multiple-of-90 normalising to a quarter
turn.

**`SMOKE_ROTPERSIST`** in `src/main.js` + `test/e2e/run.js`:
- AC-1/AC-2: rotate 90, save, reparse the bytes with pdf.js and read each page's
  `rotate` — including a document whose pages start at different rotations.
- AC-3: reopen through `App.Viewer.load` (the tab path) and confirm the
  orientation is applied and `Viewer.rotation()` is 0, not 90.
- AC-4: a measurement placed before the rotated save reports the same value
  after the reopen.
- AC-5: rotate 270 from there, save, confirm the original `/Rotate` is back.
- AC-6: save unrotated, confirm no page's `/Rotate` moved.

**Regression** — `textrot` and `rotate` must pass **unmodified**; `verify:tools`
and the #98 round-trip unchanged.

**Gates** — `npm run verify`, `verify:web`, `verify:tools`.

## Branching

Fresh from `origin/main` (currently `4375303`, v1.23.2), branch
`fix/persist-rotation`. Draft PR on PASS.
