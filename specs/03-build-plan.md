# Build Plan — Markup selection defect + tool rail size

Phase 3 output. Implements `specs/02-spec.md`. No stack decision: this is a feature
in an existing codebase and existing conventions win.

## 1. Stack

Detected, not chosen: vanilla JS on the global `App` object, no bundler, no
framework. PDF.js render, pdf-lib export, Electron + Capacitor. All three
requirements are **Tier A renderer-only** — no `window.api` surface, no new
dependency, no `src/preload.js` or `platform-web.js` change.

## 2. Architecture

No new modules, no new state. The defect is a **read** problem, not a storage
problem: `App.state.annoSelectedId` is set correctly, but two call sites read it
without asking whether a tool is armed. The fix gates those two reads and adds one
call to an existing helper.

**Key decision — gate the reads, don't stop selecting.** Alternatives considered:
(a) stop auto-selecting in `finalize()`, rejected because `app.js:424` (Delete),
`:430` (arrow-nudge) and `:299` (copy) all depend on the selection, so removing it
trades one complaint for three; (b) clear selection only on tool switch, rejected
because it fixes the two-toolbar symptom but leaves the retroactive colour bug.
Gating the reads fixes both and touches four lines of behaviour.

**Second decision — the properties bar must follow the same gate.** `syncPropBar`
(`markup.js:630`) populates the bar from the selected annotation's style. If
`applyStyle` becomes prospective while the bar still displays the *selected* item's
colour, the bar lies: you'd see the old colour, change it, and watch nothing happen.
So both functions take the same `K.tool ? null : annoById(...)` gate, and the bar
shows what the **next** markup will look like whenever a tool is armed.

## 3. Integration contract

The module boundary here is the `App` global. Three touched contracts:

| Function | File | Contract change |
|---|---|---|
| `applyStyle(patch)` | `markup.js:651` | Mutates the selected annotation **only when no markup tool is armed**. Always updates `App.state.annoStyle` and persists. Signature unchanged. |
| `syncPropBar()` | `markup.js:630` | Reads defaults instead of the selection while a tool is armed. Signature unchanged, still exported as `K.syncProps`. |
| `App.setMode(mode, kind)` | `app.js:14` | Calls the existing `clearObjectSelection()` when `mode` is truthy. Falsy `mode` behaviour unchanged (selection retained — FR-5). |

`clearObjectSelection()` (`app.js:303`) is reused as-is — it already clears all three
layers. It is a hoisted function declaration, so calling it from `setMode` (defined
earlier, invoked later) is safe.

**CSS tokens**: `--rail-w` in `styles/tokens.css:30`; `.rail-btn` height in
`styles.css:753`. Both are read by `#viewer-wrap`, `#tool-rail`, and the collapsed
state, which all key off the same token and therefore follow automatically.

## 4. Work orders

### Track 1 — Renderer (frontend)

**T1 (FR-1, FR-2)** — `src/renderer/js/markup.js`
Gate `applyStyle` and `syncPropBar` on `K.tool`. Add the ellipsis-safe comment
explaining why. ~4 lines changed.

**T2 (FR-3, FR-4, FR-5)** — `src/renderer/js/app.js`
In `setMode`, after the existing `Measure.stop()` / `Markup.stop()` calls and before
the armed-highlight block, add `if (mode) clearObjectSelection();`. ~2 lines.

**T3 (FR-6, FR-7)** — `src/renderer/styles/tokens.css`, `src/renderer/styles.css`
`--rail-w: 148px` → `124px`; `.rail-btn` height `38px` → `34px`. Add
`overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0` to
`.rail-txt` on desktop — it has no truncation rule today (only a collapsed-state
hide at `:784` and a mobile rule at `:1264`), and the error table requires labels to
ellipsis rather than reflow. Collapsed 56px state untouched.

### Track 2 — Security

Genuinely thin here, and saying so beats theatre: no new input parsing, no network,
no filesystem, no `innerHTML`, no new `window.api` method. The review reduces to
confirming (a) the Tier A boundary is intact — `git diff` touches nothing under
`src/preload.js` or `platform-web.js`, and (b) no secret or path leaks into the new
smoke scenario. Anything beyond that would be inventing findings.

### Track 3 — Test coverage

**T4 (NFR)** — `src/main.js`, `test/e2e/run.js`
New `SMOKE_MKPROSPECT` scenario following the shape of the existing
`SMOKE_MKPRESET` (`main.js:906`): arm Highlight, draw one, click the blue preset,
assert the drawn markup's `style.stroke` is **unchanged** and
`App.state.annoStyle.stroke` **is** blue (FR-1); then arm a measure tool and assert
`App.state.annoSelectedId === null` and `#markup-props` is hidden (FR-3, FR-4).
Must restore `annoStyle` before finishing — `SMOKE_MKPRESET` already documents that
`applyStyle` persists to localStorage shared across the suite's Electron runs, so
leaving a custom colour poisons later colour-sensitive scenarios.

## 5. Build sequence

1. **T1** first — narrowest change, and it defines the gate T2 must not contradict.
2. **T2** — depends on T1 only conceptually; both must land before the new smoke test.
3. **T3** — pure CSS, independent, can land any time.
4. **T4** — last, since it asserts T1 + T2.

No parallelism worth the coordination cost: four small tasks in one file each.

## 6. Definition of done

- Every AC-1…AC-8 exercised by hand in the running app, not just by test.
- `npm run verify` (vitest + Electron e2e) green, including the regression list in
  the spec's NFR section.
- `npm run verify:web` green — proves the Android WebView gets identical behaviour,
  which is the whole point of the Tier A rule.
- `git diff` confirms nothing outside `src/renderer/`, `src/main.js` and
  `test/e2e/run.js` is touched.
- One Conventional Commit per task, each naming its FR numbers.

## 7. Risks

- **`setMode` is the hottest path in the app.** Every tool arm, every Escape, every
  placement runs it. T2's one line runs on all of them. Mitigated by gating on
  truthy `mode` so the Select/Escape path is byte-for-byte unchanged (FR-5).
- **`SMOKE_MKPRESET` asserts colour behaviour** and is the scenario most likely to
  break. It clicks a preset with nothing drawn and no tool armed, so the gate should
  leave it passing — but it is the first thing to check if the suite goes red.
- **Rail width is referenced by layout that is not obviously connected** (viewer
  offset, panel offsets, split view). All key off `--rail-w`, so the token change
  should propagate, but AC-7/AC-8 exist to catch it if not.
