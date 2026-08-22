# Build Plan — Automatic per-page scale detection

Phase 3 of the build pipeline. Plans against the approved
`specs/feature-auto-scale-spec.md`. Brief: `specs/feature-auto-scale-brief.md`.

**Status: awaiting user approval.**

---

## 1. Stack — detected, not chosen

Read from the repo, not assumed:

| Layer | What is there |
|---|---|
| Renderer | Vanilla JS, no bundler, modules hanging off a global `App` object, loaded by ordered `<script>` tags in `src/renderer/index.html:1049-1080` |
| Shared logic | `src/shared/*.js`, dual Node/browser export via a UMD-ish factory, unit-tested by vitest (`test/unit/*.test.js`) |
| PDF read | PDF.js `3.11.174` — global `pdfjsLib` |
| PDF write | pdf-lib `1.17.1` — global `window.PDFLib` |
| Desktop | Electron (`src/main.js`, `src/preload.js`) |
| Android | Capacitor, fed by `scripts/build-web.js` |

**No stack decision to make. No new dependencies (NFR-7).** Every capability the
spec needs is already loaded.

Two facts verified during planning that shape the work:

- `scripts/build-web.js:50` does `copyDir(src/shared → www/shared)` — a new shared module is picked up by the Android build **automatically**, no build-script change.
- `viewer.js:432-433` restores the sidecar with `st.scales = m.scales` / `st.viewports = m.viewports` — whole-object copies, so the new `source` / `confidence` / `halfSize` fields **round-trip through the sidecar for free**, no serializer change.

## 2. Architecture

### 2.1 The one decision that matters: a hard purity split

Detection is ~85% arithmetic and string parsing over untrusted input, and ~15%
PDF/DOM access. The repo already has the right shape for this
(`measure.js` resolves state, `measure-math.js` does arithmetic — see the
comment at `measure-math.js:11-13`). This build follows it exactly:

**ADR-1 — All parsing and arithmetic goes in `src/shared/scale-detect.js`;
the renderer module only fetches bytes/text and writes state.**
*Alternative considered:* one renderer module doing everything. *Rejected
because* the risky logic here is the parsing of hostile input from arbitrary
PDFs, and in a renderer module none of it is reachable by `npm test` — it would
only ever be exercised through Electron. The split makes every FR in §3.2-3.4 of
the spec unit-testable, and gets Android coverage via `npm run verify:web` for
free.

**ADR-2 — `measureToScale()` takes a plain JS object, not a pdf-lib
`PDFDict`.** The renderer flattens the `/Measure` dictionary into
`{ subtype, R, X: [{ U, C }] }` before calling. *Alternative:* pass the pdf-lib
object and let the shared module walk it. *Rejected because* it would drag
pdf-lib into a pure module and into the Node test environment.

**ADR-3 — The Detected review list is a third tab in the existing Scale modal,
not a new modal.** `index.html:517-520` already has the tab strip and
`measure.js:696-699` already has `switchScaleTab`. *Alternative:* a new panel
like the measurements panel. *Rejected because* the review list is a scale
concern and the user is already in this modal when thinking about scale; a new
modal adds surface for no gain.

**ADR-4 — Region `/BBox` mapping uses PDF.js `convertToViewportPoint`.**
`CLAUDE.md` mandates `convertToPdfPoint` for the forward direction and forbids
hand-rolling the Y-flip; `convertToViewportPoint` is its rotation-correct
inverse and lives on the same `baseViewports[p-1]` object. *Alternative:*
`vy = pageHeight - y`. *Rejected* — silently wrong on any rotated page.

### 2.2 Folder map

```
src/shared/scale-detect.js        NEW  pure parsing + arithmetic (Track 1)
src/renderer/js/scaledetect.js    NEW  PDF/DOM access, state writes, Detected tab (Track 2)
src/renderer/index.html           MOD  2 script tags + Detected tab markup
src/renderer/js/measure.js        MOD  3rd tab wiring; source:'user' stamp on applyScale
src/renderer/js/viewer.js         MOD  kick off detection after open
src/renderer/styles.css           MOD  Detected-tab list styles
test/unit/scale-detect.test.js    NEW  Track 1 unit tests
src/main.js                       MOD  SMOKE_AUTOSCALE scenario
test/e2e/run.js                   MOD  SMOKE_AUTOSCALE assertions
specs/backlog.md                  MOD  tier C + the two "later" items
```

Naming follows the repo: shared files hyphenated (`measure-math.js`,
`ocr-layout.js`), renderer files unseparated (`docstamp.js`, `miniviewer.js`).

Script order in `index.html`: `shared/scale-detect.js` **after**
`shared/measure-math.js` (it needs `UNITS`); `js/scaledetect.js` **after**
`js/measure.js` (it calls `App.Measure.recomputeAll`).

## 3. Integration contract

This project has no HTTP routes. The equivalent contract is the `App`-object
surface between modules. **Frozen once Track 2 starts.**

### 3.1 `App.ScaleDetect` — pure module (`src/shared/scale-detect.js`)

```js
// Unit label -> key of App.UNITS, or null if unrecognised.        FR-10, FR-11
normalizeUnit(label: string): 'in'|'ft'|'yd'|'mm'|'cm'|'m'|null

// real units per scale-1 viewport point. Mirrors measure.js:710-718.  FR-19
factorFromRatio(drawnVal: number, drawnUnit: string,
                realVal: number, realUnit: string): number|null

// Guard against parsing a revision number as a ratio.        (spec §5 bounds)
plausibleFactor(f: number): boolean

// Flattened /Measure dict -> scale. Null if unreadable.        FR-8, FR-11
measureToScale(md: { subtype: string, R?: string,
                     X?: Array<{U?: string, C?: number}> })
  : { factor, unit, ratioLabel } | null

// All scale expressions found in a page's text.        FR-16..FR-21
parseScaleNotes(text: string)
  : { candidates: Array<{ factor, unit, ratioLabel, keyworded: boolean }>,
      noScaleMarker: string | null }

// high/low + whether to auto-apply.                    FR-23, FR-24, FR-25
classify(candidates: Array<Candidate>)
  : { confidence: 'high'|'low', apply: boolean, chosen: Candidate|null }

// Standard sheet sizes and the half-size inference.    FR-28, FR-29
SHEET_SIZES: Array<{ name, w, h }>            // inches, portrait-normalised
halfSizePages(pageSizesInches: Array<{w, h}>): Array<boolean>
```

Every function is total: no throws, `null` for "cannot", never a guess.

### 3.2 `App.ScaleDetect` — renderer module (`src/renderer/js/scaledetect.js`)

```js
App.ScaleDetect.run({ force?: boolean }): Promise<void>   // FR-1, FR-6
App.ScaleDetect.renderTab(): void                         // FR-35
App.ScaleDetect.accept(page: number, index: number): void // FR-36
App.ScaleDetect.clear(page: number): void                 // FR-37
App.ScaleDetect.isRunning(): boolean                      // §5 re-entrancy
```

Namespace note: the shared module attaches its pure helpers to
`App.ScaleDetect` at load; the renderer module **augments** the same object
(`Object.assign`) rather than replacing it — matching how `measure-math.js`
merges into `App` via `Object.assign(root.App, factory(...))`.

### 3.3 State contract (spec §7, additive only)

| Path | Written by | Read by |
|---|---|---|
| `state.scales[p].source/confidence/halfSize` | Track 2, and `measure.js:applyScale` (stamps `'user'`) | Track 2, Detected tab |
| `state.viewports[p][i].source` | Track 2 | Detected tab |
| `state.scaleDetect` | Track 2 only | Detected tab only |

`state.scaleDetect` is **transient** — never written to the sidecar. The three
scale fields **are** persisted, automatically (see §1).

### 3.4 Trust boundary

There is no server and no auth. The security boundary that exists is
**untrusted file → parser**: every value in §3.1 originates in an arbitrary PDF
a user opened. That is Track 3's entire remit.

## 4. Work orders

### Track 1 — core logic (`backend-agent`)

Pure module + its tests. No PDF, no DOM. Ships first; Track 2 blocks on it.

| # | Task | FRs | Files |
|---|---|---|---|
| T1.1 | Module skeleton with the repo's dual Node/browser factory export, taking `UNITS` as its dependency the way `measure-math.js` takes `Geom` | — | `src/shared/scale-detect.js` |
| T1.2 | `normalizeUnit` over an allowlist of spellings (`ft/FT/feet/'`, `in/IN/inch/"`, `m/metre/meter`, `mm`, `cm`, `yd`) | FR-10, FR-11 | ↑ |
| T1.3 | `factorFromRatio` + `plausibleFactor` (reject non-finite, ≤0, <1e-6, >1e6) | FR-19, §5 | ↑ |
| T1.4 | `measureToScale` — read `/X[0].C` and `/U`, require `subtype === 'RL'`, build `ratioLabel` from `/R` when present else synthesise | FR-8, FR-11 | ↑ |
| T1.5 | `parseScaleNotes` — architectural, engineering, and pure-ratio grammars, plus the `keyworded` flag from an adjacent `SCALE` token | FR-16, FR-17, FR-18, FR-20 | ↑ |
| T1.6 | No-scale markers (`NTS`, `N.T.S.`, `NOT TO SCALE`, `AS NOTED`, `AS SHOWN`, `VARIES`) | FR-21 | ↑ |
| T1.7 | `classify` — one keyworded ratio → high/apply; one bare ratio → low; 2+ distinct → low, apply nothing | FR-23, FR-24, FR-25 | ↑ |
| T1.8 | `SHEET_SIZES` + `halfSizePages`, including the whole-document guard (no half-size if any page is the full size) | FR-28, FR-29 | ↑ |
| T1.9 | Unit tests covering AC-3, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-12, AC-13, plus the §5 bounds rows | all above | `test/unit/scale-detect.test.js` |

**Done when:** `npm test` passes, every function above is exercised including its
null/reject path, and the module imports cleanly in Node with no `window`.

### Track 2 — renderer integration and UI (`frontend-agent`)

Blocked on T1.1-T1.8. **No React, no new dependency, no `window.api` change.**

| # | Task | FRs | Files |
|---|---|---|---|
| T2.1 | Module skeleton, `App.ScaleDetect` augmentation, `isRunning` re-entrancy guard, abort-on-document-change | FR-2, §5 | `src/renderer/js/scaledetect.js` |
| T2.2 | Tier A: load `state.pdfBytes` with pdf-lib once, walk each page's `/VP`, flatten `/Measure` to the plain shape, call `measureToScale` | FR-7, FR-8, FR-42 | ↑ |
| T2.3 | Tier A geometry: map `/BBox` through `baseViewports[p-1].convertToViewportPoint`, normalise corners with `App.Geom.rectFrom`, reject degenerate | FR-9, FR-14 | ↑ |
| T2.4 | Tier A apply: push regions to `state.viewports[p]` with `source:'embedded'`; set page scale when all viewports agree | FR-12, FR-13 | ↑ |
| T2.5 | Tier B: `getTextContent()` per page, fall back to `state.ocr[p].words`, join to text, call `parseScaleNotes` + `classify` | FR-15, FR-26, FR-27, FR-45 | ↑ |
| T2.6 | Half-size: page sizes from `baseViewports`, `halfSizePages`, double the factor, `halfSize:true`, ` (half-size)` label, never on tier A | FR-30, FR-31, FR-32 | ↑ |
| T2.7 | Ordering and non-clobber: A before B, skip B where A applied, never overwrite `source:'user'` or absent-source scales | FR-3, FR-4, FR-5, FR-34 | ↑ |
| T2.8 | Chunked scheduling — yield to the event loop each page, per-page try/catch, summary toast | FR-1, FR-41, FR-43, FR-44, NFR-1, NFR-2 | ↑ |
| T2.9 | Detected tab markup + styles | FR-35, NFR-6 | `index.html`, `styles.css` |
| T2.10 | Detected tab rendering, Accept / Clear / Re-detect, each wrapped in `History.snapshot()` + `Measure.recomputeAll()` | FR-6, FR-35..FR-37, FR-39, FR-40 | `scaledetect.js`, `measure.js` |
| T2.11 | Stamp `source:'user'` in `measure.js applyScale`; treat absent source as user | FR-33, FR-34, FR-38 | `measure.js` |
| T2.12 | Kick detection off after open, after `_rehydrate`, non-blocking | FR-1, FR-5 | `viewer.js` |
| T2.13 | `SMOKE_AUTOSCALE` scenario + e2e assertions | NFR-10 | `src/main.js`, `test/e2e/run.js` |

**Done when:** `npm run verify` and `npm run verify:web` pass, and the Detected
tab is reachable and keyboard-operable.

### Track 3 — security review (`security-agent`)

Scoped per `CLAUDE.md`: no server, no auth, no CORS. The real surface is
**parsing untrusted PDF content**, reviewed as Tracks 1-2 land.

| # | Task | FRs |
|---|---|---|
| T3.1 | ReDoS audit of every regex in `parseScaleNotes` — no nested quantifiers, bounded repetition, tested against adversarial input (long digit runs, thousands of quotes) | NFR-9 |
| T3.2 | Confirm numeric bounds are enforced on every path out of the parser; no `NaN`/`Infinity` can reach `state.scales` | NFR-9, §5 |
| T3.3 | Confirm unit labels are allowlist-matched, never interpolated into a lookup that could reach `Object.prototype` (`__proto__`, `constructor`) | NFR-9, FR-10 |
| T3.4 | Confirm no parsed string (`/R`, `/U`, note text) reaches `innerHTML` unescaped in the Detected tab | NFR-9 |
| T3.5 | Confirm text extraction is capped so a hostile page cannot exhaust memory (NFR-3), and pdf-lib failure is contained to tier A | NFR-3, FR-42 |
| T3.6 | Confirm no network call and no new `window.api` method was introduced | NFR-7, NFR-8, NFR-4 |

**Done when:** every item is confirmed or filed as a fix task against the owning
track and that fix has landed.

## 5. Build sequence

```
T1.1 ─ T1.8  (pure logic)
      │
      ├─ T1.9 (unit tests)          ─┐
      │                              ├─ T3.1-T3.3 (parser security, as T1 lands)
      └─ T2.1 ─ T2.8 (detection)    ─┤
              │                      ├─ T3.4-T3.6 (UI + boundary, as T2 lands)
              └─ T2.9 ─ T2.13 (UI)  ─┘
                        │
                        └─ Phase 5: inspector
```

- **Serial:** T1 before T2 (T2 imports T1's contract). T2.1-T2.8 before T2.9-T2.10 (the tab renders `state.scaleDetect`).
- **Parallel:** T1.9 alongside T2.1+. T3 reviews continuously, not at the end.
- **Environment prerequisite:** the worktree has no `node_modules`. Run `npm ci` in the worktree before the first test run.

## 6. Definition of done, per track

| Track | Done means |
|---|---|
| 1 | `npm test` green; every FR in spec §3.2-3.4 has a unit test; module loads in bare Node |
| 2 | `npm run verify` and `npm run verify:web` green; `SMOKE_AUTOSCALE` asserts real behaviour; Detected tab keyboard-operable (NFR-6) |
| 3 | All six T3 items confirmed; any finding fixed by the owning track, not waived |
| All | Every one of the 45 FRs claimed by implemented code; regression list §7 re-verified |

## 7. Regression boundary — re-verified in Phase 5

Carried verbatim from spec §8. These are **executed checks**, not assumptions:

1. `scaleFor` region-over-page resolution (`measure.js:70-77`) unchanged.
2. Enter-scale and Calibrate-by-drawing, including "Apply to: All pages".
3. `save.js` `/Measure` export byte-identical for a user-set scale.
4. Sidecar save/restore of user scales and region viewports.
5. Measurement label formatting including feet-inches mode.
6. Undo/redo across scale changes.
7. OCR unaffected — detection never starts, cancels or alters a run.
8. Open-path timing unchanged for a document with no detectable scale.

Plus, from the spec's ACs: **AC-20** and **AC-21** are the two explicit
regression criteria and must both be demonstrated.

## 8. Git discipline

Per `.claude/skills/git-workflow/` and `CLAUDE.md`'s golden rule:

- Branch `feat/auto-scale` off `main` — **already created**, working tree clean.
- Commit 1: the three approved spec documents.
- Then one Conventional Commit per work-order task group, each referencing its FR numbers, e.g.
  `feat(scale-detect): parse title-block scale notes (FR-16..FR-21)`.
- Tree clean between tasks. Nothing merges to `main`.
- **Phase 6 in this repo means: open a draft PR and stop.** `CLAUDE.md` overrides git-workflow's merge step — the maintainer merges.

## 9. Scope control

Out-of-scope ideas get one line in `specs/backlog.md` and no code:

- Tier C graphic bar-scale detection.
- Learning a correction from the user's first manual calibration and offering it to sibling sheets.
- Reading `/Measure` off incoming annotations rather than page `/VP`.
- Writing `/VP` on export.
