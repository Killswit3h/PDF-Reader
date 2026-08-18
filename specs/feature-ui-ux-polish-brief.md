# Research Brief — UI/UX finish pass

**Phase 1 (deep-researcher) · slug `ui-ux-polish`**

## The request

> "Improve the overall UI and UX of the software to make it a finished product
> completely. Don't stop making improvements until everything works the way a
> multi-million-dollar software would."

This is a **quality bar**, not a feature. There is no new capability to add; the
job is to close the gap between "a capable app built by one person" and "a
product a paying customer trusts on a job site."

## Method

Three parallel read-only audits of the shipped code, plus a Playwright visual
capture harness that renders the real `www/` bundle in Chromium (the same engine
the Android WebView uses) and screenshots 26 app states at desktop, narrow, and
phone widths.

Baselines measured before any change:

| Gate | Result |
|---|---|
| `npm test` | **green** — 182 unit tests, 11 files |
| `npm run verify:web` | **green** — bundle boots, renders, exports, dropdowns exclusive |
| `npm run test:e2e` | **cannot run on this Mac** — see Environment below |

## Environment constraint (must be stated up front)

`node_modules/electron/dist/Electron.app` is missing its `Contents/` payload.
Reinstalling it (sandboxed and unsandboxed) succeeds, then macOS kills the binary
with SIGKILL and the `.app` disappears again. Consequence:

- **`npm run test:e2e` reports 0/52 locally for environmental reasons, not code
  reasons.** It is not a usable local gate in this session.
- The e2e suite still runs in CI (`.github/workflows/ci.yml`, Ubuntu + xvfb), so
  new `SMOKE_*` scenarios are still worth writing — they are simply verified on
  push rather than locally.
- **`npm run verify:web` is the local gate for this work.** It exercises the same
  renderer through real Chromium, which is exactly the layer a UI/UX pass
  touches. It is extended, not bypassed.

## What the codebase is

Vanilla JS on a global `App` object, no bundler, no framework. PDF.js renders,
pdf-lib exports. 22 renderer modules (~10k lines), 11 shared modules with a dual
Node/browser UMD export, 916 lines of HTML, 1,595 lines of CSS plus a 118-line
token file and a 328-line macOS "liquid glass" layer.

The engineering underneath is genuinely good: coordinate mapping is done properly
through PDF.js viewports, the mobile reflow is thorough, pointer events are used
instead of mouse events for drawing, `prefers-reduced-motion` is respected, and
the code is unusually well-commented. **The gap is finish, not foundations.**

## Finding 1 — The app is built out of emoji

The single loudest "unfinished" signal, and it is visible in every screenshot.
Tool icons, menu icons, and status glyphs are literal emoji characters: ✏️ 📐 🎨
📋 🖼️ 📄 ✅ 🅾 in the rail, the dropdowns, and the markup bar.

Why this reads as amateur:
- Emoji render as **full-colour vendor artwork** that cannot inherit `currentColor`,
  so icons ignore the theme and the accent entirely.
- They render **differently on every platform** — Apple, Windows, and Android each
  ship different glyph art, so the product has three different looks.
- They have inconsistent optical weight and baseline, which is why the rail looks
  ragged.
- The brand mark in `index.html:26` is a hard-coded `#2f6fed` — the *old* accent
  colour, which no longer matches `--accent`.

No product at the quality bar being asked for ships emoji as its icon system.

## Finding 2 — Nine different ways to say "this is selected"

The same idea is expressed nine ways across the app (`styles.css:721, 1113, 846,
132, 485, 328, 893, 1491, 1566`): accent fill + 2px ring; inset white 3px tick;
accent fill + hard `#fff`; inset 2px accent bar; 2px accent underline; 2px accent
outline; accent-quiet background; 1px accent ring; accent fill + `#fff`.

Two of them are also broken:
- `.mr-btn.armed` hard-codes `color:#fff` over `--accent`, ignoring `--on-accent`
  (`styles.css:846`).
- `.rail-btn.armed` uses `inset 0 -3px 0 rgba(255,255,255,0.35)` (`styles.css:1113`)
  — invisible on the light theme.

## Finding 3 — The design system exists and is bypassed

`tokens.css` defines a competent system. The code largely ignores it.

| Metric | Value |
|---|---|
| Distinct font sizes in use | **22** (5 from the scale) |
| Raw `13px` vs `var(--fs-md)` | 27 vs 9 |
| Raw `12px` vs `var(--fs-sm)` | 27 vs 12 |
| Distinct line-heights | 11 |
| Distinct control heights | 17 |
| Padding/gap using `--sp-*` | ~27% |
| Distinct z-index values | 24 (3 of them inert) |
| Tokens defined but never used | 7 |
| Tokens referenced but never defined | 2 (`--tab-h`, `--radius-1`) |
| Hard-coded colours in `styles.css` | ~68 occurrences, ~40 distinct |
| `'Segoe UI'` hard-coded (absent on mac/Android) | 9 |
| Inline `style=` in `index.html` | 26 |
| Breakpoints | 4 (560, 720, 820, 821) |

The legacy accent `#2f6fed` appears 8 times and is visibly bluer than the real
`--accent`. Three separate "kbd chip" components use two different font stacks.
Six modal widths are inline styles.

## Finding 4 — The failure path is silent

The happy path is above average: spinners, toasts, a mode banner, a guided tour,
a cheat sheet, a confirm dialog. The failure path barely exists — **40+ `catch`
blocks resolve to nothing.** The worst, ranked by what the user loses:

| What silently fails | Where | What the user loses |
|---|---|---|
| Sidecar embed on save | `save.js:460` (console.warn only) | Their saved file is **no longer editable on reopen** — discovered days later |
| `applyFormEdits` | `save.js:168, 178, 180` | **Every form value they typed**, dropped from the saved PDF |
| Form-field edits never set `dirty` | `save.js:153` | Closes with no "unsaved changes" prompt |
| Corrupt sidecar on open | `viewer.js:411` | Markups silently downgrade to flattened |
| `form.flatten()` | `save.js:432` | They asked to flatten; it didn't happen |
| Content snapping harvest | `snap.js:118` | Snapping just doesn't work, no reason given |
| Thumbnail render | `organize.js:157`, `print.js:99` | Blank tiles, no explanation |
| Android print/share | `platform-web.js:77, 96, 234` | A failed print is indistinguishable from a cancelled one |

Three long operations run with **no spinner at all**: print (three heavy PDF
passes — `app.js:175-239`), digital signing in click-to-place mode
(`digisign.js:343-398`, where the status element is inside the hidden modal), and
compare/overlay file parsing.

## Finding 5 — Undo/redo is unreachable on Android

The right markup rail is `display:none !important` below 820px
(`styles.css:876-878`), and it holds the only always-available Undo/Redo buttons
(`index.html:298-299`). The other pair lives in `#markup-props`, which only
appears in markup mode (`app.js:96-100`).

**Net effect: on a phone, after deleting a measurement, there is no way to undo
it.** Find is likewise unreachable on Android — no button exists anywhere
(`index.html:324`), so it is keyboard-only, and phones have no Ctrl+F.

Several things are also mouse-only despite shipping in the mobile UI: marquee
zoom (`viewer.js:284-307`), right-drag pan (`viewer.js:239-257`), tab reorder and
tear-off (`tabs.js:316-351`). In-canvas touch targets are 8–22px against a 48px
guideline the stylesheet itself cites (`styles.css:1163-1168`).

## Finding 6 — Accessibility stops at `title` attributes

- **No modal has `role="dialog"`/`aria-modal`** — all 11 (`index.html:345…829`).
- **No focus trap in any modal**; Tab walks straight into the toolbar behind the scrim.
- **Focus is restored in exactly one place** in the whole app (`app.js:380`).
- **No `aria-live` region anywhere** — the ~80 toasts, zoom label, find count, and
  page readout are silent to assistive tech. A save failure is unannounced.
- `.mp-row`, `.pp-tile`, `.org-tile`, `.tab` are clickable `<div>`s with no role,
  no `tabindex`, no keyboard handler — four panels are pointer-only.
- The entire markup/measure SVG canvas is unreachable by keyboard.
- 18 markup-rail buttons have **no `:focus-visible` and no `:disabled`** styling.
- `--focus-ring` in light theme is a 42%-alpha ring on white ≈ **1.9:1**, below the
  3:1 minimum.

## Finding 7 — Layout breaks that are functional, not cosmetic

- **Tall modals have no height clamp on desktop.** `max-height: 88dvh` exists only
  inside `@media (max-width:820px)` (`styles.css:1328`). On a short laptop window
  the digital-signature and stamps modals overflow and **their footer buttons
  become unreachable.**
- **The find bar overflows a phone screen** — ~390px of fixed content anchored
  `right:16px` with no mobile rule (`styles.css:282-294`).
- **The right markup rail covers the tab bar** with 2+ documents open — no
  `body.has-tabs` offset exists (`styles.css:811`).
- **Desktop rail flyouts have no `max-height`** — the 14-item Measure menu runs off
  a short window with no scroll (`styles.css:764`).
- **`.mkp-opt` has no CSS rule at all** (`index.html:452`) — the "Save markups as
  editable annotations" row renders as raw unpadded text between two styled
  regions. It is the most visibly unstyled element in the app, and it controls
  whether saved files stay editable.

## Finding 8 — Motion is structurally impossible

`.hidden { display:none !important }` (`styles.css:456`) is applied to 28
dismissible elements. `display:none` cannot be transitioned, so **every modal,
menu, panel, toast, and overlay pops in and out with zero animation.** This is
the difference between "a web page" and "an application" more than any single
colour choice.

Related: the spinner **freezes to a single static frame** under
`prefers-reduced-motion`, because the global kill in `tokens.css:117` sets
`animation-duration: .001ms !important` with no exemption.

## Finding 9 — Nothing is remembered between launches

Persisted today: theme, annotation style, snap, save-mode, stamps config, print
paper, tool chest, signature, rail state, tour flags, window bounds, recent files.

**Not persisted, and each one costs the user work every launch:** zoom level, last
page, open panels, last tool, measurement colour, measurement thickness, page
scales (a plan set's calibration is lost if not saved), split-view state,
digisign placement preference, and session restore. There is **no Settings screen
at all** — every preference is buried inside a tool menu.

## Prior art the pipeline should respect

- `docs/feature-research.md` — the repo's own feasibility model and ranked backlog.
- `specs/backlog.md` — where deferred ideas go.
- The just-completed `feat/rail-menu-exclusivity` branch (3 commits + PASS
  inspection, unpushed) is a UI fix in exactly this territory and should be
  landed alongside rather than duplicated or reverted.

## What "multi-million-dollar" means here, concretely

The user's phrasing is a vibe; these are the measurable proxies it maps to:

1. **One icon system**, theme-aware, drawn as SVG — not emoji.
2. **One visual vocabulary** — one selected state, one focus ring, one radius
   scale, one shadow set, one motion curve.
3. **Nothing fails silently** — every catch either recovers visibly or tells the
   user, in their words, what they lost.
4. **Nothing pops** — surfaces animate in and out.
5. **Keyboard and screen reader work** — dialogs are dialogs, focus is trapped and
   restored, state changes are announced.
6. **The phone build is not a degraded desktop** — undo, find, and touch targets
   are real.
7. **The app remembers** — where you were, what you had open, how you like it.

## Recommended scope shape

This cannot be one commit. It decomposes into tracks that are independently
valuable and independently verifiable, which is what the spec should encode.
Ordered by user-visible impact per unit of risk:

| Track | Why | Risk |
|---|---|---|
| A — Icon system (SVG sprite, kill emoji) | Biggest visual delta | Low, mechanical |
| B — Design-system convergence (states, tokens, z-index, radii, motion) | Coherence | Low-medium, wide diff |
| C — Failure-path honesty (toast queue, catch surfacing, spinners on long ops) | Trust; prevents real data loss | Medium |
| D — Layout correctness (modal clamp, find bar, rail/tab overlap, flyout scroll, `.mkp-opt`) | Functional breaks | Low |
| E — Accessibility (dialog roles, focus trap/restore, live regions, keyboard rows) | Table stakes | Medium |
| F — Mobile parity (undo/redo, find, touch targets, pointer events) | Android is a shipped target | Medium |
| G — Persistence + Settings screen | Daily friction | Medium |

Tracks A, B, and D are renderer-only and carry almost no regression risk. C, E,
and F touch behaviour and need `SMOKE_*` coverage. G introduces new persisted
state and needs a migration-safe default.

## Open question for the spec checkpoint

The user said "don't stop until everything works." Taken literally that is all
seven tracks. The spec should present them as an ordered program the user can
approve whole or trim, rather than silently choosing a subset — but the default
recommendation is **all seven, sequenced A→G**, since the request was explicit
about completeness.
