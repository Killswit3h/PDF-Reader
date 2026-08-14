# Inspection Report — Markup selection defect + tool rail size

Phase 5 output. Verified against `specs/02-spec.md`.

## 1. Verdict

**PASS**, with one disclosed gap: the Electron e2e suite could not be executed in
this environment (see §6). Every acceptance criterion was exercised for real in a
browser engine; nothing here is checked off on the strength of reading the code.

## 2. Requirements matrix

| FR | Status | Evidence |
|---|---|---|
| FR-1 style change prospective while tool armed | ✅ | AC-1, AC-2 measured in Chromium |
| FR-2 retroactive via Select | ✅ | AC-3: `#e5484d` → `#ffd400` with `App.Markup.tool === null` |
| FR-3 arming a tool clears all layers | ✅ | AC-4 (`annoSelectedId → null`), AC-5 (`measureSelectedId → null`) |
| FR-4 only the armed tool's bar | ✅ | AC-4: `#markup-props` hidden, mode banner shown |
| FR-5 disarming retains selection | ✅ | AC-6: still selected after Escape, arrow nudged it 1pt |
| FR-6 rail 130px / 34px buttons | ✅ | AC-7, **after the amendment in §4** |
| FR-7 collapse toggle unchanged | ✅ | AC-8: 56px, `rail-collapsed` set, rail box 56px |

## 3. Acceptance criteria

All eight exercised by driving the built `www/` bundle in headless Chromium — the
same engine the Android WebView runs, and the repo's own sanctioned parity harness.

| AC | Result |
|---|---|
| AC-1 preset with tool armed doesn't recolour the drawn highlight | PASS — `before === after === #e5484d`, next highlight `#2f6fed` |
| AC-2 colour then draw three | PASS — all three `#21a366` |
| AC-3 Select + colour is retroactive | PASS — `#e5484d` → `#ffd400` |
| AC-4 switch to Measure without Escape | PASS — selection null, props bar hidden, banner up |
| AC-5 measure selection cleared by arming Markup | PASS — `measureSelectedId` null, props shown |
| AC-6 Escape retains selection, arrows nudge | PASS — selected, moved by 1 |
| AC-7 rail geometry, no clipped labels | PASS **after fix** — 130px, 34px buttons, zero clipped, no overflow |
| AC-8 collapse still 56px | PASS |

No page errors or console errors in any run.

## 4. Findings

### F-1 — AC-7 failed as originally built (confidence 100) — **FIXED**

The plan's 124px clipped three of seven rail labels. Measured in the browser:
`Document` needed 59px and `Measure` 51px of label column against 42px available;
`Markup` was 1px over.

A width sweep from 118px to 152px showed width alone cannot fix it below **142px**,
which is only 4% narrower than the 148px it started at — not worth shipping. The
label column was the constraint, so the rail button's padding (12px → 8px) and gap
(8px → 6px) came down, making **130px** clean: a 12% reduction with every label
intact.

This was a **spec defect**, not just an implementation miss: FR-6's 124px and AC-7's
"no label clipped or wrapped" were mutually unsatisfiable. FR-6 is amended in place
in `specs/02-spec.md` with the measurement and the reasoning. Fixed in `d4e045f`.

### F-2 — The new smoke scenario is unexecuted (confidence 100)

`SMOKE_MKPROSPECT` and its `test/e2e/run.js` assertion are written and
syntax-checked but have **never run**, because Electron cannot start here. Its
assertions duplicate what the Chromium harness verified passing, and it is modelled
closely on the existing `SMOKE_MKPRESET`, but it is unproven until CI runs it. Treat
a failure there as a test-harness bug, not a product regression.

### Considered and dropped (below the 80-confidence bar)

- `startTool` calls `commitActive()` before `setMode`, so finishing a polyline *by
  switching tools* now deselects the committed shape where it previously stayed
  selected. Spec-compliant under FR-3 and arguably more consistent; ~30 confidence
  this bothers anyone.
- `editTarget()` sits between `K.syncProps` and `applyStyle`. Hoisted, so correct;
  purely cosmetic placement.

## 5. What was done well

- **The two reported bugs were one defect.** Finding that before writing code turned
  six requests into a four-file change and kept the fix minimal.
- **FR-5 protected the fix from becoming its own regression.** Auto-select after
  drawing is load-bearing for Delete (`app.js:424`), arrow-nudge (`:430`) and copy
  (`:299`); gating the *readers* rather than removing the selection preserved all of it.
- **The gate was applied to `syncPropBar` as well as `applyStyle`.** Fixing only the
  latter would have left the bar displaying a colour that changing no longer
  affected — a more confusing bug than the original.
- **Consistency with an existing convention**: the measure tool already behaves this
  way, per the e2e case *"measure color — chosen color applies only to later
  measurements"*. Markup now matches the app's own precedent.

## 6. Environment gap — Electron e2e not run

`npm run test:e2e` reported 0 passed / 51 failed with **empty output for every
scenario**. Root cause is not the code: `node_modules/electron/dist/Electron.app`
is absent, so the binary never launches. Re-downloading it via
`node node_modules/electron/install.js` succeeded, but the app bundle was deleted
again and the next run died with `SIGKILL` — consistent with a security tool on this
machine removing or refusing the unsigned download.

Compensating verification actually performed:

- `npm test` — **162 passed**, 11 files (this also cleared a pre-existing failure:
  `node-forge` was declared but not installed).
- `npm run verify:web` — **PASS**, bundle boots, renders and exports in Chromium.
- A purpose-built harness driving all eight acceptance criteria in Chromium, plus a
  rail width sweep. Scripts are in the session scratchpad, not the repo.
- The AC-6 anomaly (mode staying `markup` after a synthetic Escape) was reproduced
  **identically on `main`**, confirming it is a synthetic-`KeyboardEvent` artifact of
  the harness rather than a regression.

What remains unverified: everything Electron-specific — the 51 `SMOKE_*` scenarios
including the regression list in the spec's NFR section, and the new
`SMOKE_MKPROSPECT`. CI runs these on Linux/Windows/macOS, so the PR should be
treated as awaiting that signal.

## 7. Punch list

Nothing outstanding for the build. Two items for the maintainer:

1. Let CI run the e2e suite and confirm the regression list plus `SMOKE_MKPROSPECT`.
2. Unrelated, pre-existing: `package-lock.json` carries `version: 1.17.0` while
   `package.json` is at `1.21.0`. Deliberately left out of this branch to keep the
   diff focused.
