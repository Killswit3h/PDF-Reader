# Inspection Report — Single-open rail menus

**Phase 5 (inspector) · branch `feat/rail-menu-exclusivity` · verdict: PASS**

## Gates

| Gate | Result |
|---|---|
| `npm test` (vitest, 182 tests / 11 files) | **PASS** — unchanged, no `src/shared` edit |
| `npm run verify:web` (headless Chromium = Android WebView engine) | **PASS** — incl. the new dropdown probe |
| `npm run test:e2e` (headless Electron) | **BLOCKED LOCALLY** — see below |
| `node --check` on every edited JS file | **PASS** |

### e2e blocked locally — environment, not code

`node_modules/electron/dist/Electron.app` is absent on this machine. Reinstalling
via `node node_modules/electron/install.js` succeeds (exit 0, `Electron.app`
appears in `dist/`) and the app is **deleted again within seconds**, after which
every scenario spawns with `ENOENT`. All 52 scenarios failed identically with
empty output *before* any code in this branch was touched, and the failure
signature is unchanged by the fix. This reproduces a previously-recorded issue on
this workstation (macOS removing the unsigned Electron binary post-install).

Mitigation: the same assertions were added to `scripts/verify-web.js`, which
drives the **identical** `src/renderer/js/app.js` in real Chromium with no
Electron dependency, and it passes. `SMOKE_DROPDOWN` will be exercised by CI on
Linux/Windows/macOS runners.

## Does the new test actually catch the bug?

Yes — verified by reverting only `app.js` to its pre-fix state and re-running the
web gate:

| Probe | Pre-fix | Post-fix |
|---|---|---|
| `maxOpen` (max simultaneous open `.tb-menu`) | **3** | **1** |
| `swapped` (Markup closes Measure) | false | true |
| `swapped2` (Document closes Markup) | false | true |
| `selfClosed` (self-click toggles shut, none left open) | false | true |
| `stickyOpen`, `escClosed`, `outsideClosed`, `measureAlone` | — | true |

`maxOpen: 3` is the reported defect reproduced numerically: three flyouts stacked
in the same screen region.

## Requirements

| FR | Verified by |
|---|---|
| FR-1 mutual exclusion (incl. rail↔Help) | `swapped`, `swapped2`, `s3b` in `SMOKE_DROPDOWN`; `maxOpen <= 1` |
| FR-2 self-toggle preserved | `selfOpen` + `selfClosed` |
| FR-3 outside-click, correctly scoped | `outsideClosed` |
| FR-4 Esc closes, focus to trigger, tool untouched | `escClosed` + `modeKept` + `focusBack` |
| FR-5 `aria-expanded` / `aria-haspopup` | `aria1` = "true", `ariaOff` = "false" |
| FR-6 sticky in-menu controls | `stickyOpen` (Snap checkbox does not dismiss) |
| FR-7 disabled triggers inert | `if (btn.disabled) return` retained in `registerDropdown` |

## Regression boundary

| # | Behaviour | Status |
|---|---|---|
| R-1 | Measure items arm tools / toggle panel | Item handlers unchanged; only `close()` → `dd.close()`. CI `SMOKE_MEASURE`, `SMOKE_MSNAP` |
| R-2 | Markup items, text tools, list toggle | Unchanged. CI `SMOKE_MARKUP`, `SMOKE_TMARK` |
| R-3 | Document items open their targets | Unchanged. CI `SMOKE_ORGANIZE`, `SMOKE_STAMP`, `SMOKE_SPLIT` |
| R-4 | Help menu tour / shortcuts | Unchanged. CI `SMOKE_TOUR` |
| R-5 | Measure colour + snap + feet-inches | Explicitly asserted (`stickyOpen`), passing |
| R-6 | Rail collapse + persisted pref | Untouched code path. CI `SMOKE_RAIL` |
| R-7 | Right-hand markup rail | No dropdowns; untouched. CI `SMOKE_MRAIL` |
| R-8 | Esc still cancels measurement / disarms mode when no menu open | Guarded by `if (Dropdowns.open)` + early `return`; asserted by `modeKept` |
| R-9 | Mobile bottom-bar grid layout | JS is layout-agnostic — registry keys off `.tb-dropdown`, which the mobile CSS reuses verbatim. Reasoning check, no behavioural change possible |
| R-10 | Android/web parity | `npm run verify:web` PASS with the dropdown probe |

## Code review notes

- Net **-36 lines** in `app.js`: four duplicated trigger handlers and four
  duplicated `document` click listeners collapse to one of each.
- No new dependency, no HTML, no CSS. ARIA set programmatically.
- New global surface is additive only: `App.Dropdowns.closeAll()`.
- Ordering is safe: `setupDropdownDismiss()` is called after all four
  `registerDropdown()` calls in boot; `setupKeys()` runs earlier but reads
  `Dropdowns` at keydown time, not at wiring time.
- Rollback is a single-file revert of `072e44d`.

## Findings

None blocking. One observation deferred to backlog: the mobile overflow sheet
(`#more-menu`, scoped on `.g-more`) is a separate dismissal mechanism and does
not participate in the dropdown registry. Pre-existing, out of the approved
scope, no user-visible overlap on the current layouts.

**Verdict: PASS** — open draft PR, maintainer merges.
