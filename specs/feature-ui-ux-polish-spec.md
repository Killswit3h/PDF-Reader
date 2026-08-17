# Spec — UI/UX finish pass

**Phase 2 (spec-designer) · slug `ui-ux-polish` · type: quality program (7 tracks)**

## Goal

Close the gap between "capable app" and "finished product" without changing what
the app *does*. Every requirement below is about how the app looks, responds,
communicates, and remembers — none of them add a document capability.

## Scope shape

Seven tracks, sequenced A→G. Each is independently valuable, independently
committable, and independently verifiable. Later tracks depend on earlier ones
only where noted.

---

## Track A — One icon system

**A-1.** The renderer **shall** render every interface icon from a single inline
SVG sprite defined once in `index.html`, referenced via `<svg><use href="#i-…">`.

**A-2.** Every icon **shall** inherit `currentColor` so it takes the theme and the
armed/selected state automatically.

**A-3.** No emoji character **shall** remain as an interface icon in
`index.html`, `styles.css`, or any renderer module that writes markup
(`markup.js`, `measure.js`, `organize.js`, `toolchest.js`, `print.js`,
`digisign.js`, `tour.js`).

- Emoji **may** remain in user-authored content, in `tour.js` step *illustrations*
  where the emoji is decorative narrative art rather than a control, and in
  commit messages / docs.

**A-4.** Icons **shall** be drawn on a 24×24 grid with a 1.5px stroke and rendered
at 16px in dense chrome and 20px in the tool rail, so optical weight is uniform.

**A-5.** The brand mark (`index.html:26`) **shall** use `currentColor` driven by
`.brand-mark { color: var(--accent) }`, removing the hard-coded legacy `#2f6fed`.

### Acceptance

- **Given** the app in either theme, **when** any tool is armed, **then** its icon
  changes colour with the button state (proving `currentColor`, not emoji).
- **Given** the shipped bundle, **when** grepping the renderer for emoji code
  points in control markup, **then** there are zero matches.
- **Given** macOS, Windows, and Android, **when** the rail is rendered, **then**
  the icon set is byte-identical because it is app-owned SVG.

---

## Track B — One visual vocabulary

**B-1.** The app **shall** express "selected / armed" with exactly **two** idioms:
*primary-armed* (accent fill + `var(--on-accent)` text + focus-safe ring) for
tool triggers, and *selected-in-list* (`--accent-quiet` background + 1px accent
ring) for rows, tiles, and chips. The other seven idioms **shall** be removed.

**B-2.** `--on-accent` **shall** be used for every foreground on an accent fill;
no hard-coded `#fff` **shall** remain on an accent background.

**B-3.** Every interactive element **shall** have `:hover`, `:active`,
`:focus-visible`, and `:disabled` states. Every `:hover` rule **shall** be guarded
with `:not(:disabled)`.

**B-4.** The `:focus-visible` ring **shall** apply to all focusable controls,
including the markup rail, tabs, swatches, panel rows, tiles, and close buttons,
and **shall** meet 3:1 contrast against its surface in both themes.

**B-5.** Font size, spacing, radius, and shadow **shall** come from tokens.
Targets: **≤ 8** distinct font sizes (from `--fs-*`), **≥ 85%** of padding/gap
declarations using `--sp-*`, all radii from `--r-*`, all shadows from
`--shadow-*`.

**B-6.** A z-index scale **shall** be defined as tokens with documented tiers, and
every `z-index` **shall** use one. Elements declaring `z-index` **shall** be
positioned (fixes the three inert declarations at `styles.css:38, 91, 313`).

**B-7.** `--tab-h` and `--radius-1` **shall** be resolved — defined or replaced —
so no CSS references an undefined token.

**B-8.** Dead tokens (`--fs-xs`, `--fs-2xl`, `--bg-raised`, `--warning`,
`--measure`) **shall** either be adopted where their hard-coded equivalent is
written by hand, or deleted. No token **shall** be defined and unused.

**B-9.** The legacy accent `#2f6fed` and the hard-coded `'Segoe UI'` stack
**shall** be removed everywhere in favour of `var(--accent)` and `var(--font-ui)`
/ `var(--font-mono)`.

**B-10.** Dismissible surfaces **shall** animate. `.hidden` **shall** move from
`display:none` to an opacity/transform transition with `visibility`, so modals,
menus, panels, the toast, and overlays fade and settle instead of popping.
Durations and easings **shall** come from `--dur-*` / `--ease`.

**B-11.** Under `prefers-reduced-motion`, transitions **shall** be suppressed but
the loading spinner **shall** keep animating (it communicates liveness, not
decoration).

### Acceptance

- **Given** any two selectable surfaces, **when** compared, **then** they use the
  same selected idiom from the two allowed.
- **Given** keyboard-only navigation through the whole app, **when** Tab reaches
  any control, **then** a visible focus ring appears at ≥3:1.
- **Given** a modal is opened and closed, **when** observed, **then** it fades in
  and out rather than appearing instantly.
- **Given** `prefers-reduced-motion: reduce`, **when** a long save runs, **then**
  the spinner still rotates.

---

## Track C — Nothing fails silently

**C-1.** When the editable-annotation sidecar cannot be embedded on save, the app
**shall** tell the user, in plain language, that the file was saved but its
markups are now flattened and will not reopen as editable (`save.js:460`).

**C-2.** When any interactive form-field value cannot be written on save, the app
**shall** report how many fields were dropped (`save.js:168, 178, 180`).

**C-3.** When `form.flatten()` fails after the user asked to flatten, the app
**shall** say so (`save.js:432`).

**C-4.** When a sidecar is present but unreadable on open, the app **shall** warn
that markups were loaded flattened rather than editable (`viewer.js:411`).

**C-5.** Editing an interactive form field **shall** set `App.state.dirty`, so the
close and quit guards protect typed form data (`save.js:153`).

**C-6.** Document stamps and inline date-text edits **shall** set `dirty` and
**shall** enter the undo history (`docstamp.js:193-200`, `placement.js:307-318`).

**C-7.** Every operation that takes perceptible time **shall** show progress:
print (all three passes, `app.js:175-239`), digital signing including
click-to-place mode (`digisign.js:343-398`), and compare/overlay file parsing
(`compare.js:136`, `overlay.js:187`).

**C-8.** The toast **shall** queue rather than overwrite, so a success message
cannot erase an error the user has not read. Errors **shall** persist longer than
successes and **shall** be dismissible.

**C-9.** Remaining silent `catch` blocks **shall** either surface a message or
carry a comment explaining why silence is correct. Silence **shall** be a
decision, not an accident.

**C-10.** With one document open and unsaved changes, the app **shall** show an
unsaved indicator (the tab bar is hidden below two documents, so today there is
none — `tabs.js:297-299`).

### Acceptance

- **Given** a save where sidecar embedding fails, **when** the save completes,
  **then** an error toast states the file is no longer editable on reopen.
- **Given** a form field is typed into, **when** the window is closed, **then** the
  save prompt appears.
- **Given** a print of a large document, **when** the user clicks Print, **then** a
  spinner appears within 100ms and the UI never looks frozen.
- **Given** an error toast is showing, **when** a success toast fires 200ms later,
  **then** the error is still readable.

---

## Track D — Layout correctness

**D-1.** `.modal` **shall** clamp its height and scroll its body at every viewport
size, not only below 820px, so modal footers are always reachable
(`styles.css:1328` → base rule).

**D-2.** `#find-bar` **shall** fit any supported viewport, including a 320px phone
(`styles.css:282-294`).

**D-3.** `#markup-rail` **shall** offset below the tab bar when tabs are visible
(`styles.css:811`).

**D-4.** Desktop rail flyouts **shall** clamp height and scroll (`styles.css:764`).

**D-5.** `#markup-props` **shall** scroll horizontally at every size, so Undo/Redo
are never clipped (`styles.css:310-314`).

**D-6.** `.mkp-opt` **shall** be styled consistently with its sibling panel regions
(`index.html:452`).

**D-7.** `.dsig-modes` **shall** reflow instead of forcing three ~130px tiles into
a 520px modal (`styles.css:1508`).

**D-8.** The breakpoint ladder **shall** be reduced to a documented set with named
values; the 720/820 mismatch **shall** be resolved (`styles.css:223, 876, 1190`).

**D-9.** `safe-area-inset-left/right` **shall** be honoured for Android landscape
with a display cutout.

### Acceptance

- **Given** a 1400×700 window, **when** the digital-signature modal opens, **then**
  its Cancel and Sign buttons are visible and clickable.
- **Given** a 320px-wide viewport, **when** Find opens, **then** the whole bar is
  on-screen.
- **Given** two documents open, **when** the markup rail is shown, **then** it does
  not cover the tab bar or the "+" button.

---

## Track E — Accessibility

**E-1.** Every modal **shall** have `role="dialog"`, `aria-modal="true"`, and an
`aria-labelledby` pointing at its title (all 11).

**E-2.** Every modal and panel **shall** trap Tab focus while open and **shall**
restore focus to the control that opened it on close.

**E-3.** The toast **shall** be a live region — `polite` for information,
`assertive` for errors — so outcomes are announced.

**E-4.** Zoom level, page number, find results, and mode changes **shall** be
announced to assistive tech.

**E-5.** `.mp-row`, `.pp-tile`, `.org-tile`, and `.tab` **shall** be keyboard
operable with a role, a tab stop, and Enter/Space activation.

**E-6.** Every control **shall** have an accessible name — including `#page-input`,
`#find-input`, the filter inputs, the markup property controls, the organizer
action buttons, and the delete buttons.

**E-7.** Armed tools **shall** expose `aria-pressed`; open disclosures already
expose `aria-expanded` and **shall** keep doing so.

**E-8.** Panel headings **shall** be real headings, and the document **shall** keep
a coherent heading structure after a PDF opens.

### Acceptance

- **Given** a screen reader, **when** a save fails, **then** the failure is spoken.
- **Given** a modal is open, **when** Tab is pressed repeatedly, **then** focus
  cycles inside the modal and never reaches the toolbar behind it.
- **Given** a modal is closed, **when** it dismisses, **then** focus returns to the
  button that opened it.
- **Given** keyboard-only operation, **when** navigating the measurements list,
  **then** rows can be reached and activated.

---

## Track F — Mobile is not a degraded desktop

**F-1.** Undo and Redo **shall** be reachable on a phone at all times, in a
persistent location, reflecting `App.History.canUndo/canRedo()`.

**F-2.** Find **shall** be reachable without a keyboard — a control **shall** exist
in the UI on every platform (`index.html:324`).

**F-3.** Controls that ship in the mobile UI **shall** work with touch. Marquee
zoom and pan **shall** either use pointer events or **shall not** be offered on
touch (`viewer.js:284-307, 239-257`).

**F-4.** In-canvas touch targets — placement delete and resize handles, markup
handles, measurement vertex handles — **shall** meet a ≥44px effective touch
target under `pointer: coarse`, without changing their visual size on desktop.

**F-5.** The mobile bottom bar **shall** meet the 48px target the stylesheet
already cites, including width (`styles.css:1261-1276`).

**F-6.** Features unavailable on touch **shall not** appear as dead controls.

**F-7.** Android print/share failures **shall** be distinguishable from
cancellation (`platform-web.js:77, 96, 234, 245`).

### Acceptance

- **Given** a phone-sized viewport with a measurement placed, **when** it is
  deleted, **then** Undo is visible and restores it.
- **Given** a phone, **when** the user wants to search the document, **then** a
  Find control is present and opens the find bar fully on-screen.
- **Given** `pointer: coarse`, **when** a placement is selected, **then** its
  delete and resize affordances are at least 44px.

---

## Track G — The app remembers

**G-1.** Zoom level and current page **shall** persist per document across
launches, not only across tab switches (`viewer.js:103`, `tabs.js:72-73`).

**G-2.** Open panel state, last-used tool, measurement colour and thickness, and
digisign placement preference **shall** persist.

**G-3.** Page scale calibration **shall** survive reopening a document that was not
saved, so a calibrated plan set is not silently recalibrated.

**G-4.** A **Settings** surface **shall** exist, gathering preferences that are
currently buried inside tool menus, including theme, units/feet-inches, default
markup style, save-as-editable, snapping, and the update check.

**G-5.** The update check **shall** be disableable, because the product's core
promise is offline operation (`app.js:945`).

**G-6.** New preferences **shall** default to today's behaviour, and an absent or
corrupt prefs blob **shall** fall back cleanly — no migration step may break an
existing install.

### Acceptance

- **Given** a document opened at 150% on page 7, **when** the app is relaunched and
  the document reopened, **then** it restores to 150% and page 7.
- **Given** a fresh install with no prefs, **when** the app boots, **then** it
  behaves exactly as it does today.
- **Given** the update check is disabled, **when** the app launches, **then** no
  network request is made.

---

## Explicit non-goals

- **No new document capability.** No new markup type, measurement type, export
  format, or file operation.
- **No framework, no bundler, no build step, no new runtime dependency.** Vanilla
  JS on the global `App` object stays.
- **No React, no design-system generator, no CSS-in-JS.**
- **No visual redesign of the drafting-table identity.** The grid canvas, the
  title-block empty state, and the macOS liquid-glass layer are the product's
  character and are refined, not replaced.
- **No change to the coordinate-mapping model or the PDF export path**, beyond
  surfacing errors that path already produces.
- **No change to the `window.api` contract** except where Track G needs a
  preference that already has a home in `App.Prefs`.
- **No cloud, no telemetry, no analytics.** Offline stays absolute.

## Regression boundary — must still pass unchanged

| # | Behaviour | Guarded by |
|---|---|---|
| R-1 | All 52 existing e2e scenarios | `npm run test:e2e` (CI) |
| R-2 | All 182 unit tests | `npm test` |
| R-3 | Bundle boots, renders, exports in Chromium | `npm run verify:web` |
| R-4 | Rotation and inverse point mapping at 0/90/180/270 | `verify-rotate.js` |
| R-5 | PWA bundle assertions | `npm run verify:pwa` |
| R-6 | Android APK build and www/ self-containment | `android.yml` |
| R-7 | Single-open rail dropdowns (just landed) | `SMOKE_DROPDOWN`, `verify-web.js` |
| R-8 | Editable round-trip: save → reopen as live markups | `SMOKE_RT` |
| R-9 | Every markup, measure, placement, organize, stamp tool | `SMOKE_*` suite |
| R-10 | Digital signature PKCS#7 output | `SMOKE_SIGN`, `SMOKE_DSIGN` |
| R-11 | Print geometry incl. the tabloid fill fix | `SMOKE_PRINT` |
| R-12 | Tabs, reorder, tear-off, macOS reopen | `SMOKE_TABS`, `SMOKE_TEAROFF`, `SMOKE_REOPEN` |

Any track that cannot keep these green is wrong, however good it looks.

## Verification strategy

Because local Electron is broken on this machine (see the brief), the gates are:

1. `npm test` — every pass, locally.
2. `npm run verify:web` — every pass, locally; **extended** with new assertions
   per track (focus trap, dialog roles, live region, modal clamp, icon sprite
   presence, no-emoji check).
3. `npm run verify:rotate`, `npm run verify:pwa` — locally.
4. New `SMOKE_*` scenarios written to the existing boilerplate and **verified in
   CI on push**, not locally.
5. Screenshot diffing via the Playwright harness for each track, so visual
   regressions are caught by eye rather than assumed away.

## Done means

All seven tracks delivered, every gate in the regression boundary green in CI,
new `SMOKE_*` coverage for C/E/F/G behaviours, and the measurable targets in B-5
met. The inspector verifies against this document, not against taste.
