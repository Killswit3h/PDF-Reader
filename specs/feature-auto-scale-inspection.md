# Inspection Report — Automatic per-page scale detection

Phase 5 of the build pipeline. Verifies the build against
`specs/feature-auto-scale-spec.md` (45 FRs, 21 ACs + FR-14a added during
build) and `specs/feature-auto-scale-plan.md`.

**Verdict: PASS.**

---

## 1. Gates

| Gate | Result |
|---|---|
| `npm test` (vitest, 19 files) | **437 passed, 0 failed** — 53 of them new |
| `npm run test:e2e` (headless Electron, real app) | **62 passed, 0 failed** — 1 new scenario |
| `npm run verify` (both — the pre-push gate) | **PASS** |
| `npm run verify:web` (Android WebView parity) | **PASS** — `bundle runs in a browser engine` |

`verify:web` additionally reports `bodyOverflow: 0` and `modalFits: true` at
all four breakpoints (`mobile`, `tablet-768`, `laptop-short`, `desktop-1440`),
so the new Detected tab does not break the Scale modal on a tablet — which is
the platform the field user is on.

## 2. Requirement coverage

All 46 requirements are implemented. How each was verified:

**Verified by executing the real app** (`SMOKE_AUTOSCALE`, on two fixtures):
FR-1, FR-3, FR-4, FR-6, FR-7, FR-9, FR-12, FR-13, FR-22, FR-26, FR-27,
FR-30, FR-31, FR-32, FR-33, FR-35, FR-36, FR-37, FR-38.

**Verified by unit test** (`test/unit/scale-detect.test.js`):
FR-8, FR-10, FR-11, FR-16, FR-17, FR-18, FR-19, FR-20, FR-21, FR-23, FR-24,
FR-25, FR-28, FR-29.

**Verified by a Node integration harness driving the real renderer module**
against the real fixture: FR-5, FR-14a, FR-34, FR-41.

**Verified by code inspection only** — stated plainly rather than claimed as
tested: FR-2 (non-blocking: the call is un-awaited and yields per page),
FR-14 (degenerate `/BBox` rejection), FR-15 (the OCR-words fallback path;
the text-layer path is tested), FR-39 (`History.snapshot`), FR-40
(`recomputeAll`), FR-42, FR-43, FR-44, FR-45.

### Acceptance criteria

19 of 21 ACs are demonstrated by an automated assertion. The two that are not:

- **AC-1** (a 120-page document stays interactive) — the mechanism is in place
  and the 4-page and 2-page fixtures complete without blocking, but no
  120-page timing assertion exists. See §5.
- **AC-4** (a `/Rotate 90` page's region lands where Acrobat puts it) — the
  `/BBox` conversion is asserted exactly on an unrotated page
  (`[72,200,1440,2176]`), and the conversion goes through PDF.js
  `convertToViewportPoint`, which is rotation-correct by construction. A
  rotated-page fixture would make this an assertion rather than an argument.
  See §5.

Both are recorded as residual gaps below, not glossed over.

## 3. Regression boundary (spec §8) — executed, not assumed

Every item was exercised by an existing e2e scenario that still passes:

| # | Boundary | Evidence |
|---|---|---|
| 1 | `scaleFor` region-over-page order | `measure — length/continuous/area/angle/count + region scale export` ✓ |
| 2 | Enter-scale, Calibrate-by-drawing, Apply-to-all | same scenario ✓ |
| 3 | `save.js` `/Measure` export unchanged | `interop — every markup + measure tool exports as a live annotation` ✓ |
| 4 | Sidecar save/restore of scales and regions | `round-trip — saved marks reopen as editable objects (not baked in)` ✓ |
| 5 | Label formatting incl. feet-inches | `measure — snap-to-drawing, feet-inches, and per-segment breakdown` ✓ |
| 6 | Undo/redo across scale changes | `failure path — errors survive, stamps undo, dirty reaches the title` ✓ |
| 7 | OCR untouched | `OCR — a scanned page becomes searchable text, offline, without losing marks` ✓ |
| 8 | Open path for a document with no detectable scale | all 61 other scenarios open `sample.pdf`/`big.pdf`, which carry no scale ✓ |

**AC-20 and AC-21**, the spec's two explicit regression criteria, are covered by
rows 1–3 above.

`tabs.js` `DOC_FIELDS` was modified (adding `scaleDetect`), which is the change
most able to break document isolation. `tabs — open two PDFs, switch, each
keeps isolated state` and `tab reorder` and `tear-off` all still pass.

## 4. Defects found and fixed during the build

Three, each of which would have shipped silently:

1. **`lenToNumber('0')` returned null**, so every note ending `1'-0"` was
   discarded — the commonest way an architectural scale is written. Tier B
   would have been close to useless on real drawings. Zero is now a valid
   result; positivity is enforced where it actually matters, in
   `factorFromRatio`.
2. **The open hook never fired.** It was placed in `Viewer.load`, but opening a
   file goes through `App.Tabs.open` — the same trap `tabs.js` documents in its
   own comment about the sidecar base swap. Detection ran only on an explicit
   re-detect. Hooked at `T.open`.
3. **Embedded regions were placed over hand-calibrated pages.** A region beats
   the page scale in `scaleFor`, so this silently overrode the user's own
   calibration inside the box — the exact surprise FR-4 exists to prevent. The
   spec did not say whether FR-4 or FR-12 won; resolved in FR-4's favour and
   recorded as **FR-14a**.

Two smaller ones: a pure ratio as extreme as `1:999999` was accepted as a scale
(now bounded to `1:0.01`–`1:100000`, so `1:1250` and `1:25000` still work), and
the half-size doubling bypassed `plausibleFactor` (now re-checked, so "every
factor in `state.scales` passed `plausibleFactor`" holds as an invariant).

## 5. Residual gaps (accepted, recorded)

- **Half-size inference is a heuristic.** An 11×17 sheet genuinely drawn
  full-size at `1/4" = 1'-0"` is doubled incorrectly. The user chose
  auto-correction over flag-only (D3), so this is mitigated, not eliminated:
  the whole-document guard means a mixed set never trips it (asserted), the
  correction is labelled `(half-size)`, it raises its own toast, it is flagged
  for confirmation, and it is one click and one undo from being reverted.
  Spec §9.
- **No 120-page performance assertion** (AC-1). The design is right — one
  pdf-lib parse for the document, a yield per page, nothing awaited on the open
  path — but "stays interactive at 120 pages" is currently an argument, not a
  measurement.
- **No rotated-page fixture** (AC-4). The conversion is rotation-correct by
  construction; a `/Rotate 90` fixture would make it provable.
- **Bar-scale detection (tier C) is not built** — deferred by decision D1 and
  recorded in `specs/backlog.md`. It is the only source that stays true on a
  rescaled sheet, so it is the real answer to the half-size problem.
- **Pre-existing, unrelated:** `App.state.ocr` is not a `tabs.js` `DOC_FIELD`,
  so OCR results do not follow their document across a tab switch. Noticed
  while adding `scaleDetect` to that list. Filed in `specs/backlog.md`; not
  fixed here because it is outside this feature's scope.

## 6. Security track (plan §4, Track 3)

| Item | Finding |
|---|---|
| T3.1 ReDoS | Every quantifier in every regex is explicitly bounded. A timing test asserts adversarial input (20k digits, 5k quote characters, a 200×-repeated near-match) returns in under 2 s. **Clear.** |
| T3.2 Numeric bounds | `plausibleFactor` gates every path into `state.scales`, including after the half-size doubling. Pure ratios carry tighter bounds again. Tested against `0`, negatives, `NaN`, `±Infinity`, `1e-9`, `1e9`, strings, `null`. **Clear.** |
| T3.3 Prototype pollution | `UNIT_ALIASES` is `Object.create(null)` and the result is confirmed with `hasOwnProperty` against `UNITS`. Tested with `__proto__`, `constructor`, `hasOwnProperty`, `toString`. **Clear.** |
| T3.4 XSS | Every PDF-sourced string reaching `innerHTML` passes through `esc()`; `/R` and `/U` additionally pass `safeLabel` (control characters folded, length capped). Verified by reading each interpolation in `renderTab`. **Clear.** |
| T3.5 Memory | Page text capped at `MAX_TEXT` (200k chars) and discarded per page; the pdf-lib load is wrapped so a parse failure is contained to tier A. **Clear.** |
| T3.6 No new surface | `grep` over both new files for `fetch`, `XMLHttpRequest`, `WebSocket`, `window.api`, `import(`, `http(s)://` returns nothing. No `package.json` change. **Clear.** |

No unresolved findings.

## 7. Conventions

- Renderer + `src/shared/` only; no new `window.api` method, no platform branch — ships to Windows, macOS and Android together (NFR-4, confirmed by `verify:web`).
- Zero new dependencies (NFR-7) — `package.json` untouched.
- Naming follows the repo: hyphenated in `src/shared/`, unseparated in `src/renderer/js/`.
- The pure module uses the same dual Node/browser factory export as its neighbours and takes `UNITS` as a dependency the way `measure-math.js` takes `Geom`.
- A new `SMOKE_*` scenario with matching e2e assertions, per `CLAUDE.md` (NFR-10).
- Conventional Commits referencing FR numbers; nothing committed to `main`.
