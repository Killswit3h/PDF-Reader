# Build Plan — UI/UX finish pass

**Phase 3 (dev-project-manager) · slug `ui-ux-polish`**

Approved at the spec checkpoint: **all seven tracks A→G**, **one PR per track**,
**technical line icons**.

## Stack decision

None to make. Detected and kept: vanilla JS on the global `App` object, no
bundler, no framework, PDF.js + pdf-lib, Electron + Capacitor. `frontend-agent`
owns nearly all of this work. `backend-agent` has surface only where Track G
touches `App.Prefs` and the `window.api` contract. `security-agent` reviews Track
G's persisted state and Track C's error messages (they must not leak filesystem
paths into UI text).

No new runtime dependency. No build step. `react-best-practices` is not
applicable; its general `js-*` rules are.

## Git strategy — stacked PRs

Each track is a branch whose PR **targets the previous track's branch**, so every
PR diff shows only that track's work. When you merge a PR, GitHub auto-retargets
the next one at `main`.

```
main
 └─ feat/rail-menu-exclusivity      → PR #1  (already built, PASS, unpushed)
     └─ feat/ui-icons               → PR #2  Track A
         └─ feat/ui-visual-system   → PR #3  Track B
             └─ feat/ui-failure-path→ PR #4  Track C
                 └─ feat/ui-layout  → PR #5  Track D
                     └─ feat/ui-a11y→ PR #6  Track E
                         └─ feat/ui-mobile   → PR #7  Track F
                             └─ feat/ui-persistence → PR #8  Track G
```

All PRs open as **drafts**. The maintainer merges; the pipeline never merges to
`main` (CLAUDE.md). Conventional Commits referencing FR numbers.

**Step 0, before any new code:** push `feat/rail-menu-exclusivity` and open its
draft PR. It is finished, inspected, and blocking the stack.

## Verification per track

Local, every track: `npm test`, `npm run verify:web`, `npm run verify:rotate`,
`npm run verify:pwa`, plus a screenshot sweep through the Playwright harness.

CI, every push: unit on 3 OSes, PWA verify, **e2e on Ubuntu** (the gate that
cannot run on this Mac), www/ self-containment, `verify-web`, `verify-rotate`,
Android APK, iOS simulator compile.

`scripts/verify-web.js` gains assertions as tracks land — it is the only local
harness that drives the real renderer, so it carries the weight the broken local
Electron would otherwise carry.

---

## Track A — Icon system → `feat/ui-icons`

**Inventory measured:** 37 distinct pictographs at 77 sites, plus glyph-character
icons (`✕ ↺ « » ✓ ⤢ ⟳ ▲ ▼`). Sprite target: ~40 symbols.

**Design.** An inline `<svg hidden>` sprite of `<symbol id="i-*" viewBox="0 0 24 24">`
placed at the top of `<body>` in `index.html`. Inline, not fetched: zero latency,
no FOUC, no CSP question, and `build-web.js` copies it for free because it lives
in `index.html`. Icons drawn at 1.5px stroke, squared terminals, `stroke="currentColor"`,
`fill="none"`.

Markup form: `<svg class="ico" aria-hidden="true"><use href="#i-measure"/></svg>`.
Sizes via `.ico` (16px) and `.ico-lg` (20px, tool rail).

For modules that build markup in JS, one helper: `App.icon(name, cls)` returning
the same string, so `markup.js`, `measure.js`, `organize.js`, `toolchest.js`,
`tabs.js`, `placement.js`, `tour.js`, `app.js` never hand-roll SVG.

| WO | Task | Files | FRs |
|---|---|---|---|
| A-1 | Draw the sprite; add `.ico` sizing rules | `index.html`, `styles.css` | A-1, A-4 |
| A-2 | `App.icon()` helper | `util.js` | A-1 |
| A-3 | Replace every emoji in static markup | `index.html` | A-3 |
| A-4 | Replace every emoji in JS-built markup | 8 renderer modules | A-3 |
| A-5 | Brand mark → `currentColor` | `index.html`, `styles.css` | A-5 |
| A-6 | Guard assertion: no pictographs in control markup | `scripts/verify-web.js` | A-3 |

**Risk.** Mechanical but wide. The mitigation is A-6: an automated check that
fails the build if an emoji returns, plus a screenshot sweep of all 26 states.

**Regression watch.** `SMOKE_MRAIL`, `SMOKE_RAIL`, `SMOKE_TOUR`, `SMOKE_ORGANIZE`
assert on DOM structure near these nodes; icon swaps must not change ids,
classes, `title`, or `aria-label`.

---

## Track B — Visual vocabulary → `feat/ui-visual-system`

| WO | Task | Files | FRs |
|---|---|---|---|
| B-1 | Collapse 9 selected idioms → 2; fix `#fff`-on-accent | `styles.css` | B-1, B-2 |
| B-2 | Complete hover/active/focus-visible/disabled matrix; `:not(:disabled)` guards | `styles.css` | B-3, B-4 |
| B-3 | Raise `--focus-ring` to ≥3:1 both themes | `tokens.css` | B-4 |
| B-4 | Token sweep: font sizes → `--fs-*`, spacing → `--sp-*`, radii, shadows | `styles.css` | B-5 |
| B-5 | z-index token scale; `position: relative` on the 3 inert declarations | `tokens.css`, `styles.css` | B-6 |
| B-6 | Define `--tab-h`; kill `--radius-1`; adopt-or-delete the 5 dead tokens | `tokens.css`, `styles.css` | B-7, B-8 |
| B-7 | Purge `#2f6fed` and `'Segoe UI'` | `styles.css`, `index.html` | B-9 |
| B-8 | `.hidden` → animatable visibility pattern | `styles.css`, any module toggling `.hidden` | B-10 |
| B-9 | Spinner exemption under reduced motion | `tokens.css` | B-11 |
| B-10 | Extend `liquid-glass.css` to the surfaces it currently misses | `liquid-glass.css` | B-1 |

**The one genuinely risky item is B-8.** `.hidden { display:none !important }` is
used on 28 elements and is load-bearing: layout, hit-testing, and several
`SMOKE_*` assertions read `classList.contains('hidden')`. The transition pattern
must keep that class as the source of truth and keep the element non-interactive
and out of the a11y tree when hidden. If any harness reads computed `display`, it
changes meaning — that is checked before the change, not after.

**Measurable exit:** ≤8 font sizes, ≥85% tokenized spacing, zero undefined tokens,
zero unused tokens, zero `#2f6fed`, zero `'Segoe UI'`.

---

## Track C — Failure path → `feat/ui-failure-path`

The only track that can prevent real data loss, so it gets the most test weight.

| WO | Task | Files | FRs |
|---|---|---|---|
| C-1 | Toast queue: ordered, dismissible, errors persist longer | `util.js`, `styles.css` | C-8 |
| C-2 | Surface sidecar embed failure | `save.js:460` | C-1 |
| C-3 | Count and report dropped form fields; surface flatten failure | `save.js:168,178,180,432` | C-2, C-3 |
| C-4 | Warn on unreadable sidecar at open | `viewer.js:411` | C-4 |
| C-5 | Form edits set `dirty` | `viewer.js`/`save.js` | C-5 |
| C-6 | Stamps + date-edit set `dirty` and snapshot history | `docstamp.js`, `placement.js`, `history.js` | C-6 |
| C-7 | Spinners on print, digital signing, compare/overlay parse | `app.js`, `digisign.js`, `compare.js`, `overlay.js` | C-7 |
| C-8 | Audit all 40+ silent catches: surface or comment | across renderer | C-9 |
| C-9 | Unsaved indicator with a single document | `tabs.js`, `viewer.js` | C-10 |
| C-10 | `SMOKE_FAILPATH` scenario | `src/main.js`, `test/e2e/run.js` | C-1…C-6 |

**C-6 note.** Adding `docStamp` to the history KEYS changes the undo snapshot
shape. `history.js` caps at 60 snapshots of whole-JSON state; adding a key is
additive and safe, but the per-tab export/import path (`history.js:73-74`) must
round-trip the new key or undo will silently drop stamps on tab switch.

**Error-message rule (security-agent):** messages state *what the user lost and
what to do*, never a raw filesystem path or stack.

---

## Track D — Layout → `feat/ui-layout`

Smallest, lowest-risk track; pure CSS except D-6.

| WO | Task | Files | FRs |
|---|---|---|---|
| D-1 | `.modal` height clamp + body scroll at all sizes | `styles.css:464` | D-1 |
| D-2 | Responsive find bar | `styles.css:282` | D-2 |
| D-3 | `body.has-tabs #markup-rail` offset | `styles.css:811` | D-3 |
| D-4 | Rail flyout max-height + scroll | `styles.css:764` | D-4 |
| D-5 | `#markup-props` overflow at all sizes | `styles.css:310` | D-5 |
| D-6 | Style `.mkp-opt` | `styles.css`, `index.html:452` | D-6 |
| D-7 | `.dsig-modes` auto-fit reflow | `styles.css:1508` | D-7 |
| D-8 | Breakpoint ladder: resolve 720/820, document the set | `styles.css` | D-8 |
| D-9 | Left/right safe-area insets | `styles.css` | D-9 |
| D-10 | Viewport assertions at 320/390/768/1024/1440 + short-window | `scripts/verify-web.js` | D-1…D-7 |

D-10 is the track's real deliverable: these breakages recur, so they get an
automated size sweep rather than a one-time fix.

---

## Track E — Accessibility → `feat/ui-a11y`

| WO | Task | Files | FRs |
|---|---|---|---|
| E-1 | `role="dialog"` + `aria-modal` + `aria-labelledby` on all 11 modals | `index.html` | E-1 |
| E-2 | Shared `trapFocus(modal, returnTo)` helper; wire every open/close path | `util.js`, all modal owners | E-2 |
| E-3 | Toast live region, polite/assertive by kind | `index.html`, `util.js` | E-3 |
| E-4 | Announce zoom, page, find count, mode | `viewer.js`, `app.js` | E-4 |
| E-5 | Keyboard-operable rows and tiles | `markup.js`, `measure.js`, `organize.js`, `print.js`, `tabs.js` | E-5 |
| E-6 | Accessible names for every unnamed control | `index.html`, module-built markup | E-6 |
| E-7 | `aria-pressed` on armed tools | `app.js`, `markup.js` | E-7 |
| E-8 | Real headings in panels | `index.html` | E-8 |
| E-9 | `SMOKE_A11Y` + verify-web a11y assertions | `src/main.js`, `test/e2e/run.js`, `scripts/verify-web.js` | E-1…E-7 |

**E-2 is the load-bearing item.** Eleven modals, four panels, and several
transient surfaces open from many call sites. One helper, called from every path,
or focus restore will be inconsistent — which is worse than none, because
keyboard users learn to distrust it.

**Interaction with B-8.** Hidden surfaces must leave the a11y tree. The animation
pattern from B-8 and the dialog semantics here must agree; E depends on B.

---

## Track F — Mobile parity → `feat/ui-mobile`

| WO | Task | Files | FRs |
|---|---|---|---|
| F-1 | Persistent mobile Undo/Redo bound to `History.canUndo/canRedo` | `index.html`, `app.js`, `styles.css` | F-1 |
| F-2 | Find control present on all platforms | `index.html`, `app.js` | F-2 |
| F-3 | Marquee zoom + pan → pointer events, or hidden on coarse pointers | `viewer.js` | F-3, F-6 |
| F-4 | ≥44px effective touch targets for in-canvas handles | `styles.css`, `markup.js`, `measure.js` | F-4 |
| F-5 | Bottom bar meets 48px incl. width | `styles.css:1261` | F-5 |
| F-6 | Distinguish Android print/share failure from cancel | `platform-web.js` | F-7 |
| F-7 | Phone-viewport assertions in the web harness | `scripts/verify-web.js` | F-1…F-5 |

**F-4 design constraint:** grow the *hit* area, not the *paint* area — an
invisible padded hit region under `pointer: coarse`, so desktop precision is
untouched and the drawing does not get visually chunky.

**F-3 decision:** convert rather than hide. Marquee zoom is genuinely useful on a
tablet; hiding it is the fallback only if pointer conversion destabilises
`SMOKE_MARQUEE`.

---

## Track G — Persistence + Settings → `feat/ui-persistence`

| WO | Task | Files | FRs |
|---|---|---|---|
| G-1 | Per-document zoom + page, keyed by path/name, capped LRU | `viewer.js`, `tabs.js`, `src/shared/prefs.js` | G-1 |
| G-2 | Persist panels, last tool, measure colour/width, digisign placement | relevant modules | G-2 |
| G-3 | Persist page scale calibration per document | `measure.js`, `save.js` | G-3 |
| G-4 | Settings modal gathering the buried preferences | `index.html`, new `js/settings.js`, `styles.css` | G-4 |
| G-5 | Update-check opt-out, honoured at boot | `app.js`, `src/main.js` | G-5 |
| G-6 | Defaults + corrupt-blob fallback; unit tests | `src/shared/prefs.js`, `test/unit/prefs.test.js` | G-6 |
| G-7 | `SMOKE_SETTINGS` + `SMOKE_RESTORE` | `src/main.js`, `test/e2e/run.js` | G-1…G-5 |

**G-1 storage design.** A bounded map in the existing prefs blob — LRU-capped at
50 documents — so localStorage cannot grow without limit on a phone. Keyed by
file path on desktop, by name+size on Android where paths are opaque.

**G-6 is the safety requirement:** absent or corrupt prefs must behave exactly as
today. `src/shared/prefs.js` already has unit coverage; extend it rather than
inventing a second store.

**G-4 places a new script tag** in `index.html`, which `build-web.js` copies but
does not auto-register — the tag is required or the Android bundle silently loses
Settings. Called out because it is the documented footgun.

---

## Integration contract

- **New global surface:** `App.icon()` (A), `App.trapFocus()` (E),
  `App.Settings` (G). All additive.
- **`window.api`:** unchanged, except G-5 needs the existing update-check path to
  read a preference before firing. No new method if the renderer can gate it.
- **New persisted keys:** `docState`, `panels`, `lastTool`, `measureStyle`,
  `dsigPlacement`, `updateCheck`. All default to current behaviour.
- **New files:** `src/renderer/js/settings.js` (G). Everything else edits existing
  files.
- **HTML contract:** ids, classes, `title`, and `aria-label` on existing controls
  are preserved throughout — the `SMOKE_*` suite selects on them.

## Rollback

Each track is one branch and one PR; reverting a track is reverting its merge.
Within a track, work orders are separate commits, so a single bad WO reverts
alone. Track B's B-8 (`.hidden`) is the only change with cross-track blast radius
and is committed on its own for exactly that reason.

## Sequencing note

E depends on B-8. F-4 depends on B's state matrix. G is independent and could run
in parallel, but is last because it is the least visible. A and D are safe to
land first and give the fastest visible improvement.
