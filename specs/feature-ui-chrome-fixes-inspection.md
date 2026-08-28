# Inspection Report — `ui-chrome-fixes`

**Phase 5 (inspector) · slug `ui-chrome-fixes`**

## Verdict

**PASS**, with one environmental caveat recorded in §5.

## 1. How this was verified

Not by reading the diff. Every defect was reproduced first — in headless
Chromium against the assembled `www/` bundle, with `html.platform-mac` forced so
the macOS skin applies — and each fix is asserted by a check that fails on the
old code. Three new `SMOKE_*` scenarios run on real Electron in the e2e suite,
per `CLAUDE.md`; the one check that cannot (the macOS blur, which needs the
`platform-mac` skin Linux CI never applies) runs in `verify-web`.

## 2. Acceptance criteria

| AC | Requirement | Verified by | Result |
|---|---|---|---|
| AC-1 | No control's right edge exceeds `innerWidth` | `SMOKE_CHROME` at 1500 and 950 px; headless sweep at 1600/1200/1000/900/800/600/360 | PASS |
| AC-2 | `⋯` holds the relocated controls at 900px | `SMOKE_CHROME` (`inMenu > 0`); sheet contains `btn-save-as`, `btn-updates`, page group | PASS |
| AC-3 | 1600 → 900 → 1600 returns every control home | `SMOKE_CHROME` (`back.inMenu === 0`, `back.collapsed === false`) | PASS |
| AC-4 | ≤820px keeps today's mobile layout | `verify-web` layout scenarios (360/768 viewports) unchanged; the media block is untouched | PASS |
| AC-5 | The `⋯` sheet stays inside the window on desktop | headless: at 900px the sheet measures left 610, right 890, window 900 | PASS |
| AC-6 | Shelf rows are the top-most element at their own coordinates | `SMOKE_CHROME` `elementFromPoint` on title / first / last row | PASS |
| AC-7 | Same for `#help-menu` | `SMOKE_CHROME` `helpHit` | PASS |
| AC-8 | Document content is blurred, not merely tinted, under a macOS dropdown | `verify-web` `glass`, calibrated — see §3 | PASS |
| AC-9 | Non-`platform-mac` rendering unchanged | every `liquid-glass.css` change is `html.platform-mac`-prefixed; `#toolbar`'s only changed property in `styles.css` is `z-index` | PASS |
| AC-10 | Pages 5,{9},2,2 render as 2,2,5,9 | `SMOKE_SHELF` | PASS |
| AC-11 | Current-page marker + `aria-current`, and it moves | `SMOKE_SHELF` (`current === [2,2]`, `ariaCurrent === 2`) | PASS |
| AC-12 | Visible provenance on every row, no `title` | `SMOKE_SHELF` (`rowTitles === 0`, 4 tags, 4 marks) | PASS |
| AC-13 | Header names both counts | `SMOKE_SHELF` (`4 bookmarks · 1 added here`) | PASS |
| AC-14 | Three-state toggle, third state labelled | `SMOKE_SHELF` (`onlyForeign.foreign === true`, label matches "in this document") | PASS |
| AC-15 | Foreign outline entries survive save + reopen | pre-existing `SMOKE_BOOKMARK` / `bookmarks` e2e scenario | PASS (unchanged) |
| AC-16 | Hover shows the tooltip; no native `title` | `SMOKE_TOOLTIP` (`nativeTitles === 0`, text matches) | PASS |
| AC-17 | Keyboard focus shows it | headless: focusing `#btn-save` shows "Save — overwrites the opened file (Ctrl+S)" | PASS |
| AC-18 | Runtime `title` reassignment is picked up | `SMOKE_TOOLTIP` (`dynamicTip` follows `refreshButton()`) | PASS |
| AC-19 | Clamped inside the window at the edge | `SMOKE_TOOLTIP` (`edgeRight <= winW`, `edgeLeft >= 0`) | PASS |
| AC-20 | Escape hides; inert at all times | `SMOKE_TOOLTIP` (`afterEsc`, `pointerEvents === 'none'`, `aria-hidden === 'true'`) | PASS |
| AC-21 | No control lost its accessible name | `SMOKE_TOOLTIP` (`nameless === []` across 121 migrated controls) | PASS |
| AC-22 | Touch raises no tooltip and does not alter the tap | `SMOKE_TOOLTIP` (`tipOnTouch === false`, `touchClicks === 1`) | PASS |

## 3. The macOS blur check, and how its threshold was set

A pass/fail number here is only worth having if it fails on the old code, so it
was calibrated against both states rather than guessed.

The sample is the interior of the open bookmark shelf, inset 20px so Chromium's
edge-clamped blur kernel is out of frame, over a 2px black/white stripe
stimulus — the highest spatial frequency the sample can hold. The metric is mean
|Δluminance| between horizontally adjacent pixels: an edge detector. The panel's
*own* rows contribute to that too, so the measurement is differential — the same
region with `#viewer-wrap` hidden — which cancels them and leaves only leakage.

Measured, as a fraction of the stimulus' own detail:

```
fixed        2.43 %
regressed   15.34 %     (backdrop-filter re-added to #toolbar via an injected rule)
```

The gate is **6%**, roughly 2.5x clear in both directions. An earlier draft of
this check measured raw luminance variance and reported 29.06 vs 30.47 — it was
measuring the shelf's own text, not leakage, and would have passed the broken
build. That draft was discarded.

`verify-web` also asserts the root cause structurally: no `.tb-menu` may have an
ancestor carrying `backdrop-filter`, and each must carry one itself. **That check
found a defect the Phase 1 research missed** — `#tool-rail` was a Backdrop Root
too, so the Measure, Markup and Document flyouts were as sheer over a drawing as
the shelf. The Phase 1 probe had tested rail-menu paint *order* (fine) and never
tested whether their blur did anything. Fixed the same way, in `251b5f1`.

## 4. Regression boundary

Every item from the build plan's list, re-exercised:

| # | Behaviour | Result |
|---|---|---|
| 1 | `SMOKE_BOOKMARK`: our `Page 3` and the document's `Client Index` both survive save and reopen; ownership restored; foreign entry unrenamed | PASS |
| 2 | ≤820px mobile top bar: sticky Open/`⋯`, scrollable row, fixed sheet, safe-area padding | PASS — the media block is byte-unchanged apart from the sheet's row rules being hoisted out of it, which widens where they apply and narrows nothing |
| 3 | Left-rail flyout mutual exclusion | PASS (`dropdowns` e2e + `verify-web` `dropdowns`, `maxOpen <= 1`) |
| 4 | Find bar: open, count, next/prev, close, position | PASS (`verify-web` `findOnScreen` at every viewport) |
| 5 | Mode banner Finish/Cancel alignment | PASS (`mode banner` e2e scenario) |
| 6 | Theme toggle, light and dark | PASS (`verify-web` runs both; no theme token changed) |
| 7 | Tab bar with two documents; `.tab-menu` still above the toolbar | PASS (`tabs`, `tab reorder`, `tear-off` e2e scenarios) |
| 8 | Full gates | see §5 |

Layering was re-checked for anything the toolbar's move to `--z-flyout` could
newly occlude. Everything at or above 40 keeps winning: `#loading` and
`#drop-overlay` (`--z-scrim` 50), modals (100), `#toast` (150), `#tooltip` (160),
the tour (200). Everything below it — the rails, panels, banner, props bar, find
bar, copy button, marquee — sits geometrically below the top bar and never
overlapped it.

## 5. Gates

```
npm test          520 passed / 22 files          PASS
npm run test:e2e   69 passed, 0 failed           PASS   (66 existing + 3 new)
npm run verify:web   all sub-checks pass         see caveat
```

**Caveat (environmental, not this change).** `npm run verify:web` exits 1 in this
sandbox on one line:

```
requestfailed: https://api.github.com/repos/Killswit3h/PDF-Reader/releases/latest
```

That is the in-app update check, which the harness explicitly allow-lists as the
one deliberate remote call. The container's egress proxy blocks it. **Verified
pre-existing:** an unmodified `origin/main` worktree fails identically, on that
same single line and nothing else. Every sub-check on this branch — `dropdowns`,
`icons`, `layout`, `a11y`, `ocr`, `tabs`, and the new `glass` — passes.

## 6. Code review

Reviewed against the spec's out-of-scope list and the repo's conventions.

- **The bookmark model is untouched.** `src/shared/outline.js` has no diff.
  `hasOurBookmark`, `toggleBookmark`, `flattenOutline` and `writeOutline` are
  unchanged, so the toggle still adds and removes only our own entry and a
  foreign one is still never rewritten. The new `anyBookmarkOn()` is a read, and
  lives in `bookmarks.js` rather than the shared model on purpose — it governs
  what the button *says*, not what it *does*.
- **No new dependency, no bundler, no framework**, per `CLAUDE.md`. One new
  renderer module, hung off `App` like every other. `scripts/build-web.js`
  copies `src/renderer/` wholesale, so `www/` and the APK pick it up with no
  build change.
- **Security track** (thin by design — offline, no server, no new I/O). Two
  items, both clean: `bookmarks.js` uses `innerHTML` for row *structure* with no
  interpolation and writes every PDF-derived string through `textContent`;
  `tooltip.js` renders `data-tip` — which can carry a title straight out of a
  user-supplied PDF outline — with `textContent`, never `innerHTML`.
- **Accessibility.** Migrating names out of `title` writes `aria-label` when the
  element has no name of its own, verified across all 121 controls. The tooltip
  is `aria-hidden` so nothing is announced twice, and `pointer-events: none` so
  it cannot eat a click. Shelf rows carry `aria-current`. `Escape` dismisses the
  tooltip without consuming the key, so the app's own Escape handling still runs.
- **Reduced motion.** `#tooltip` joins the existing named fade list rather than
  redefining `.hidden`, so `prefers-reduced-motion` handling is inherited.

## 7. Deferred

Written to `specs/backlog.md`: section headers in the shelf (the depth indent had
to go when the list became globally page-ordered), renaming our own bookmarks,
long-press tooltips on touch, a shortcut chip inside the tooltip, and text labels
for the icon-only rows in the `⋯` sheet now that it is a desktop surface.
