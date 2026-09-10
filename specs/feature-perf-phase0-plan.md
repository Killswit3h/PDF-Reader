# Build Plan — Performance apparatus and baseline (Phase 0)

**Phase 3 (dev-project-manager) · slug `perf-phase0`**

## Stack decision

None. Vanilla JS, no bundler, no new dependency. Everything is test
infrastructure: Node scripts under `bench/` and `test/`, one pure module under
`src/shared/`, one `SMOKE_*` block in `src/main.js`, and CI YAML. The
`backend-agent` and `security-agent` tracks have no surface (no `window.api`
change, no file I/O in the product, no network); their review reduces to
confirming `bench/serve.js` binds only when run on purpose and serves nothing
outside `www/`, the three fixtures, and its own two scripts.

## Branch

`claude/fieldmark-perf-usability-d3aad1` (assigned by the session), off
`origin/main` at v1.25.0. Draft PR; the maintainer merges.

## Work orders

| # | Files | Does | FR |
|---|---|---|---|
| 1 | `test/fixtures/make-fixtures.js`, three new `.pdf` | Seeded PRNG, pinned dates, form-XObject guardrail runs, 1-bit scans as raw Flate image XObjects, heavy sidecar via the real `serializeMarkupModel`. Export the builders; keep `main()` behind `require.main`. | FR-1, FR-2 |
| 2 | `src/shared/perf-stats.js`, `test/unit/perf-stats.test.js` | `percentile`, `summarizeTasks`, `canvasBudget`, `frameStats`, `stepStats`, `reportRows`, `markdownTable`. Dual export → `App.PerfStats`. | FR-8 |
| 3 | `bench/probe.js` | `window.__FMPerf`: `open`, `pinch`, `pan`, `canvas`, `heap`, `markup`, `runAll`. State-driven waits on `renderingState`; drag through real `PointerEvent`s with rAF work attributed to the move that scheduled it. | FR-3 |
| 4 | `bench/lib.js`, `bench/run-web.js`, `bench/run-electron.js`, `bench/serve.js`, `bench/device.js`, `package.json` scripts | Shared server + result writer; the three drivers. | FR-4, FR-5, FR-6 |
| 5 | `src/main.js` (`SMOKE_PERF`), `test/e2e/run.js` (`perf` scenario, `runApp` timeout arg) | Electron path and its assertion. | FR-5, FR-7 |
| 6 | `.github/workflows/ci.yml` | New `web` job: build, Playwright, `verify:web`, `verify:tools`, non-gating bench with artifact. | FR-9 |
| 7 | `docs/perf/BRIEF.md`, `docs/perf/00-baseline.md`, `docs/perf/results/*.json`, `docs/measurement-plan.md` | The record. | FR-10 |

## Integration contract

- The probe is injected, never bundled: `bench/lib.js#probeSource()` returns
  `perf-stats.js + probe.js`; `run-web.js` evaluates it, `main.js` reads the
  same two files from disk. `www/` and `index.html` are untouched.
- `runAll(load, log, opts)` is the one entry point; `load(name)` returns an
  `ArrayBuffer` (fetch on web/device, `window.api.readPdf` on Electron).
- `App.PerfStats.reportRows(result)` is the single source of the table used by
  the runners, the e2e log, the device panel, and the baseline document.

## Existing behaviours that must still pass

Every scenario already in `test/e2e/run.js`; `verify-web.js`; `verify-tools.js`;
all 541 existing unit tests. The five existing fixtures keep their committed
bytes.

## Sequencing

1 → 2 → 3 → 4 → 5 (needs 1, 3) → 6 → baselines → 7 → inspection.
