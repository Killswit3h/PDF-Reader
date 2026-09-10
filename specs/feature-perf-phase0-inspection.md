# Inspection Report — Performance apparatus and baseline (Phase 0)

**Phase 5 (inspector) · branch `claude/fieldmark-perf-usability-d3aad1` · verdict: PASS**

## Gates

| Gate | Result |
|---|---|
| `npm test` (vitest, 554 tests / 24 files, incl. new `perf-stats.test.js`) | **PASS** |
| `npm run test:e2e` (headless Electron under Xvfb, 72 scenarios incl. new `perf`) | **PASS** — 72 passed, 0 failed |
| `node scripts/verify-tools.js` (built `www/`, headless Chromium) | **PASS** — 14 tools, 8 measurements, every assertion OK |
| `node scripts/verify-web.js` | **PASS on every assertion; FAIL on one environment line** — see below |
| `node --check` on every edited JS file | **PASS** |
| Fixture determinism (generate twice, compare SHA-256) | **PASS** — identical |

### verify-web — environment, not code

The only line in `[verify-web] page errors:` is
`requestfailed: https://api.github.com/repos/Killswit3h/PDF-Reader/releases/latest`,
the app's allow-listed update check. `curl` reaches that URL (HTTP 200) through
the session's egress proxy; the headless browser does not trust the proxy's CA
and the request fails at TLS. Nothing on this branch touches `verify-web.js`,
`index.html`, or any renderer module it loads, and every functional result the
script prints (`numPages`, canvases, OCR, dropdowns, icons, a11y, tabs, rotate)
is OK. CI runners have a direct network path; the new `web` job in `ci.yml`
runs the gate there.

## Requirements matrix

| FR | Status | Evidence |
|---|---|---|
| FR-1 fixtures | Implemented | `test/fixtures/make-fixtures.js` (`buildDensePlans`, `buildScannedSet`, `buildHeavyMarkup`); generator prints `>=44671 segments/page`; `perf` scenario asserts 120 pages / 2,000 annotations / 300 measurements on open |
| FR-2 determinism | Implemented | two consecutive runs, identical SHA-256 for all three files |
| FR-3 probe | Implemented | `bench/probe.js`; all 24 metric rows present in every saved JSON |
| FR-4 web runner | Implemented | `bench/run-web.js`, `npm run bench`, `--tablet`; results in `docs/perf/results/chromium-*.json` |
| FR-5 Electron runner | Implemented | `SMOKE_PERF` in `src/main.js`; `bench/run-electron.js`; `docs/perf/results/electron-*.json` |
| FR-6 device runner | Implemented | `bench/serve.js` + `bench/device.js`; AC-4 exercised in Chromium (loads under the app's CSP with zero console errors, panel opens, fixture fetch 200, POST writes a result) |
| FR-7 e2e assertion | Implemented | `test/e2e/run.js` scenario `perf`; passes; prints the table |
| FR-8 shared arithmetic | Implemented | `src/shared/perf-stats.js`, 13 unit tests |
| FR-9 CI | Implemented | `.github/workflows/ci.yml` new `web` job: `verify:web`, `verify:tools` gating; bench non-gating with artifact |
| FR-10 documents | Implemented | `docs/perf/BRIEF.md`, `docs/perf/00-baseline.md`, `docs/measurement-plan.md` header |

Acceptance criteria AC-1 … AC-5: all exercised, all pass (AC-4 by driving the
served page in Chromium, see FR-6).

## Findings

**Critical:** none.

**Important:** none.

**Minor**

- `docs/perf/00-baseline.md` tablet columns are `pending`: no iPad or Android
  device is reachable from this session. The runner exists and is verified;
  the maintainer fills the columns with `npm run bench:serve`. Not a code
  defect; recorded so the gap is visible.
- `scanned-set.pdf` is committed but not yet driven by the probe (the brief's
  Phase 0 metric list does not use it). Phase 1 should add its canvas budget
  and paint check to `runAll`.
- The device panel (`bench/device.js`) uses `navigator.clipboard`, which
  Safari allows only on a user gesture; the button is one, so it works, and
  the textarea fallback covers the rest.

## Scope check

No file under `src/renderer/`, `src/preload.js`, or `src/shared/markup-model.js`
changed. `package.json` gains four `bench*` scripts and no dependency. The five
pre-existing fixtures keep their committed bytes.

## What was done well

- The probe attributes rAF-deferred redraw work to the `pointermove` that
  scheduled it, so the drag number is main-thread work, not wall-clock idle.
- The pixel readback turned a "258 ms pinch at 400%" that would have read as a
  pass into the documented blank-canvas failure the brief predicted for dpr 2
  tablets, on the desktop engine, before any device was in hand.
- One probe, three drivers, one `reportRows`: the table in the PR, the CI log,
  the device panel, and the baseline document cannot drift from each other.

## Punch list

None. Draft PR and stop, per CLAUDE.md; the maintainer reviews the baseline
before Phase 1 starts.
