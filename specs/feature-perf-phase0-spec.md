# Spec — Performance apparatus and baseline (Phase 0)

**Phase 2 (spec-designer) · slug `perf-phase0` · type: test infrastructure**

## Problem

Nothing in the repo measures render latency, main-thread blocking, canvas
memory, or markup-layer cost, and the largest fixture is 12 Letter pages. Phases
1–8 of `docs/perf/BRIEF.md` each promise before/after numbers; without an
apparatus and a baseline those numbers cannot exist.

## Goal

Three committed, deterministic fixtures; one probe that measures the brief's
metric list identically in headless Chromium, on real Electron, and on a tablet;
a baseline document; and CI coverage for the two gates that only ran locally.
No product behaviour changes.

## Functional requirements

**FR-1 — Fixtures.** `npm run fixtures` SHALL additionally write
`test/fixtures/dense-plans.pdf` (120 ANSI D pages, each executing ≥ 30,000 path
segments), `test/fixtures/scanned-set.pdf` (40 ANSI D pages, each a unique
300 DPI bilevel image), and `test/fixtures/heavy-markup.pdf` (one ANSI D page
carrying the FieldMark sidecar with 2,000 annotations across ink, polyline,
cloud, rect and text, plus 300 measurements on a calibrated page scale).

**FR-2 — Determinism.** Running the generator twice SHALL produce
byte-identical output for the three fixtures.

**FR-3 — Probe.** `bench/probe.js`, evaluated inside the renderer together with
`src/shared/perf-stats.js`, SHALL expose `window.__FMPerf.runAll(load, log)`
returning, for `dense-plans.pdf`: first-page paint time on a cold and a warm
open; time from pinch end to a sharp render of the current page and of all
visible pages at 200% and 400%; the longest `longtask`, the longest
`long-animation-frame` where supported, and frame-gap statistics during a 3 s
synthetic pan; total canvas bytes and the largest canvas; JS heap where
available. For `heavy-markup.pdf`: open time, `App.Markup.repositionAll()`,
`App.Measure.repositionAll()`, select, a 60-`pointermove` drag through the real
pointer path with per-move main-thread work, and undo.

**FR-4 — Web runner.** `npm run bench` SHALL build `www/`, drive it in headless
Chromium the way `scripts/verify-web.js` does, print a markdown table, and write
the JSON to `docs/perf/results/`. A `--tablet` flag SHALL shape the run as
1024 × 1366 at dpr 2 with touch.

**FR-5 — Electron runner.** A `SMOKE_PERF` scenario in `src/main.js` SHALL run
the same probe on the real app and print `[perf] {json}`; `npm run
bench:electron` SHALL save that JSON to `docs/perf/results/`.

**FR-6 — Device runner.** `npm run bench:serve` SHALL serve the web build on the
LAN with the probe and a one-tap panel injected, without modifying files on
disk or relaxing the app's CSP, and SHALL accept the result over POST into
`docs/perf/results/`.

**FR-7 — e2e assertion.** `test/e2e/run.js` SHALL gain a `perf` scenario that
fails if any metric in FR-3 is missing or non-numeric, if the dense set does not
report 120 pages, if the heavy fixture does not report 2,000 annotations and
300 measurements, if either pinch does not land on its target, or if the drag
does not displace the markup. It SHALL NOT assert the brief's targets.

**FR-8 — Shared arithmetic.** Percentiles, task summaries, canvas budget,
frame and step statistics, and the report rows SHALL live in
`src/shared/perf-stats.js` with the repo's dual export and unit tests.

**FR-9 — CI.** `.github/workflows/ci.yml` SHALL run `verify:web` and
`verify:tools` as gating steps; a bench run MAY be included as a non-gating,
artifact-producing step.

**FR-10 — Documents.** `docs/perf/BRIEF.md` SHALL hold the maintainer's brief
verbatim; `docs/perf/00-baseline.md` SHALL hold the measured numbers with the
environment each came from and the target next to each; the status header of
`docs/measurement-plan.md` SHALL say Phase 6 shipped.

## Explicit non-goals

- No change to any file under `src/renderer/js/`, `src/preload.js`,
  `src/renderer/js/platform-web.js`, or `src/shared/markup-model.js`.
- No dependency added to `package.json` (`playwright-core` stays a `--no-save`
  harness install, as it is for `verify:web`).
- No assertion against the brief's targets anywhere; Phase 0 records, it does
  not enforce.

## Regression boundary — must still pass after the change

- `npm test` (all existing unit tests), `npm run test:e2e` (every existing
  scenario, unchanged), `npm run verify:web`, `npm run verify:tools`.
- The existing five fixtures are not regenerated on this branch (the generator
  is not deterministic for them; regenerating would produce a spurious diff).

## Acceptance test

- **AC-1** Given a clean checkout, when `node test/fixtures/make-fixtures.js`
  runs twice, then the SHA-256 of each perf fixture is identical both times.
- **AC-2** Given `www/` is built, when `node bench/run-web.js` runs, then it
  exits 0, prints 23 metric rows, and writes one JSON under
  `docs/perf/results/`.
- **AC-3** Given Xvfb, when `node test/e2e/run.js perf` runs, then the scenario
  passes and prints the same 23-row table.
- **AC-4** Given `www/` is built, when `node bench/serve.js` runs and a browser
  opens `/`, then the page loads under the app's CSP with no console errors and
  shows the "Bench" button.
- **AC-5** `npm test` includes `test/unit/perf-stats.test.js` and passes.

## Done means

All FRs implemented, ACs exercised, the regression boundary green, the baseline
document written with the desktop Chromium and Electron numbers, and the tablet
rows clearly marked pending with the exact command to fill them.
