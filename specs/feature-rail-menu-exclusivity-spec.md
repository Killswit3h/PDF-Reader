# Spec — Single-open rail menus

**Phase 2 (spec-designer) · slug `rail-menu-exclusivity` · type: bug fix**

## Problem

Opening a second left-rail flyout leaves the first one open. Two absolutely
positioned menus stack on top of each other in the same screen region, so the
user sees one menu bleeding through another and has to click empty canvas to
clear the mess.

## Goal

At most **one** dropdown menu is open at any moment, across all four
`.tb-dropdown` triggers (Measure, Markup, Document in the left rail; Help in the
header). Opening one closes the others. Nothing else about the menus changes.

## Functional requirements

**FR-1 — Mutual exclusion.**
Clicking any dropdown trigger while a *different* dropdown's menu is open closes
that other menu in the same click, and opens the clicked one. Applies to all four
triggers in both directions, including rail↔header (Help).

**FR-2 — Self-toggle preserved.**
Clicking a trigger whose *own* menu is already open closes it and opens nothing —
the existing toggle behaviour, unchanged.

**FR-3 — Outside-click close, correctly scoped.**
A click anywhere that is not inside the *owning* `.tb-dropdown` closes the open
menu. A click inside the open menu's own dropdown subtree does **not** close it
(FR-6 depends on this).

**FR-4 — Escape closes the open menu.**
With a dropdown open, `Esc` closes it, moves focus back to its trigger, and
consumes the keystroke — it must **not** also disarm the active tool, cancel an
in-progress measurement, or deselect a markup (`app.js:435-443`). With no
dropdown open, `Esc` behaves exactly as it does today.

**FR-5 — `aria-expanded` on every trigger.**
All four triggers reflect open state via `aria-expanded` (`#btn-help` already
does; the three rail triggers gain it). Triggers also get
`aria-haspopup="true"`.

**FR-6 — Sticky in-menu controls.**
The Measure menu's colour input, colour Reset, and the "Snap to drawing" /
"Feet-inches" checkboxes keep the menu open when clicked, exactly as today —
including while the OS colour picker has focus.

**FR-7 — Disabled triggers stay inert.**
A `disabled` trigger (no document open) opens nothing and closes nothing.

## Explicit non-goals

- No visual/CSS change. No new markup beyond ARIA attributes.
- No animation or transition added to menu open/close.
- No keyboard arrow-key roving within a menu.
- No change to what any menu item *does* when activated.
- No change to side panels (Measurements List, Markups List, Tool Chest,
  Organize). They co-exist by design; that is a separate concern.
- No new dependency, no framework, no bundler.

## Regression boundary — must still pass after the change

| # | Behaviour | Where |
|---|---|---|
| R-1 | Every Measure item still arms its tool; `Measurements List` still toggles the panel | `app.js:575-582` |
| R-2 | Every Markup item still arms its tool; text tools route via `startTextMarkup`; `Markups List` still toggles | `app.js:598-606` |
| R-3 | Every Document item still opens its target (organize / stamp / chest / digisign / compare / overlay / split) | `app.js:683-695` |
| R-4 | Help menu still starts the tour and opens the shortcut sheet | `app.js:712-719` |
| R-5 | Measure colour + snap + feet-inches controls behave unchanged | FR-6 |
| R-6 | Rail collapse/expand and its persisted pref unchanged | `SMOKE_RAIL` |
| R-7 | Right-hand markup rail unchanged | `SMOKE_MRAIL` |
| R-8 | Esc still cancels an in-progress measurement / markup and disarms the mode when no menu is open | `app.js:435-443` |
| R-9 | Mobile bottom-bar layout still opens menus as a grid | `styles.css:1261-1296` |
| R-10 | Android/web build (`npm run verify:web`) still boots and drives the rail | web bundle |

## Acceptance test (new `SMOKE_DROPDOWN`)

With a document open, in headless Electron:

1. Click `#btn-measure` → `#measure-menu` visible, other two hidden.
2. Click `#btn-markup` → `#markup-menu` visible, **`#measure-menu` hidden**.
3. Click `#btn-document` → `#document-menu` visible, other two hidden.
4. Click `#btn-markup` twice → open then closed; zero menus visible.
5. Open `#measure-menu`, click `#measure-snap` → menu **still** visible.
6. Open `#measure-menu`, press `Esc` → menu hidden, `App.state.mode` unchanged,
   `document.activeElement === #btn-measure`.
7. Open `#measure-menu`, click the page canvas → menu hidden.
8. Assert never more than one `.tb-menu:not(.hidden)` across the whole sequence.

## Done means

`npm run verify` green, `npm run verify:web` green, `SMOKE_DROPDOWN` asserting
all eight steps, and the regression table exercised.
