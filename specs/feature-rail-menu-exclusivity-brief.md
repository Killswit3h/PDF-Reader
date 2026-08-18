# Research Brief — Left rail dropdown menus don't close each other

**Phase 1 (deep-researcher) · feature slug: `rail-menu-exclusivity`**

## 1. The reported defect

> "Every time I click any of the menu buttons on the left-hand side, if I click on
> another button it doesn't minimize the previous menu that was clicked."

The screenshot confirms it: the **Markup** flyout is open and rendered on top of a
still-open **Measure** flyout (rows "Continuous", "Perimeter", "Angle", "Snap to
drawing", "Feet-inches", "Add Scale Region…", "Measurements List" are visible
bleeding through behind the Markup panel). Two dropdowns are open at once and
they physically overlap, because both are absolutely positioned at
`top: 0; left: calc(100% + 8px)` relative to their own `.tb-dropdown`
(`src/renderer/styles.css:764`).

## 2. Stack (detected, not chosen)

Vanilla JS on a global `App` object, no bundler, no framework. PDF.js viewer +
pdf-lib export. Electron (desktop) / Capacitor (Android) share the same
`src/renderer/`. Styling is hand-written CSS in `src/renderer/styles.css` plus a
macOS-only `styles/liquid-glass.css` overlay. This is a **renderer-only** defect —
no `window.api` surface, no file I/O, no platform branch.

## 3. How the menus are built today

**Markup** (`src/renderer/index.html:91-189`): `<aside id="tool-rail">` holds four
groups. Three of its buttons open flyouts, each wrapped in a `.tb-dropdown`:

| Trigger | Menu element | Wired in |
|---|---|---|
| `#btn-measure` | `#measure-menu` | `app.js:566` `setupMeasureMenu()` |
| `#btn-markup` | `#markup-menu` | `app.js:589` `setupMarkupMenu()` |
| `#btn-document` | `#document-menu` | `app.js:673` `setupDocumentMenu()` |

A fourth `.tb-dropdown` lives in the header, not the rail:

| `#btn-help` | `#help-menu` | `app.js:702` `setupHelpMenu()` |

**JS**: all four `setup*Menu()` functions are near-verbatim copies of the same
eight lines. Each one:

```js
const close = () => menu.classList.add('hidden');
btn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (btn.disabled) return;
  menu.classList.toggle('hidden');
});
…
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tb-dropdown')) close();   // ← the bug
});
```

## 4. Root cause (two independent causes, both must be fixed)

1. **The outside-click guard is too broad.** Each menu's document-level listener
   bails when the click lands inside *any* `.tb-dropdown` — not just its own.
   Clicking `#btn-markup` while `#measure-menu` is open is a click inside a
   `.tb-dropdown`, so Measure's `close()` never runs. The guard should be "not
   inside **my** dropdown", not "not inside **a** dropdown".
2. **`e.stopPropagation()` on every trigger.** Even if (1) were fixed, the trigger
   handler halts the event before it reaches `document`, so no sibling's
   document-level listener ever sees the click at all. Opening must therefore
   *proactively* close the others rather than relying on the outside-click path.

Both must go, or the two-open-menus state persists.

## 5. Adjacent behaviour that must not regress

- **`Esc`** — grep of `app.js` keyboard handling shows `Escape` currently drives
  `App.setMode(null)` / find-bar close; the dropdowns have **no** Esc handling
  today. Adding it is a bonus, not a requirement (see spec).
- **Outside-click close** already works today for the single-menu case and must
  keep working.
- **Item activation** — each menu's item handlers call `close()` then dispatch
  (`App.Measure.startTool`, `App.Markup.startTool` / `startTextMarkup` /
  `App.MarkupPanel.toggle`, `App.Organize/DocStamp/ToolChest/DigiSign/Compare/
  Overlay/SplitView`, `App.Tour.start` / `App.Shortcuts.open`). Untouched.
- **Sticky inner controls** — `#measure-menu` contains a `<label class="mtool-color">`
  with `<input type="color">` and a Reset button, plus two `<label class="mtool-toggle">`
  checkboxes (`#measure-snap`, `#measure-ftin`). These live inside the menu and are
  *not* `button[data-mtool]`, so clicking them does **not** close the menu — that
  is deliberate and must survive. The native colour picker also steals focus; the
  menu must not close underneath it.
- **Disabled state** — rail triggers are `disabled` until a document is open
  (`viewer.js:735` toggles `body.doc-open`). `if (btn.disabled) return` must stay.
- **Right-hand markup rail** (`#markup-rail`, `app.js:617`) has no dropdowns —
  unaffected.
- **Side panels** (Measurements List, Markups List, Tool Chest, Organize) are
  independent `has-*panel` body classes that shift the viewport and are designed to
  co-exist. **Out of scope** — the report is about flyout menus, not panels.
- **Rail collapse** (`#rail-toggle`, `body.rail-collapsed`) and the **mobile
  bottom-bar** layout (`styles.css:1261-1296`, where the rail becomes a horizontal
  bar and menus become a grid) both reuse the same JS. The fix is layout-agnostic.

## 6. Integration points (exact files to touch)

| File | Change |
|---|---|
| `src/renderer/js/app.js` | Replace the four duplicated menu wirings with one shared helper that enforces single-open |
| `src/main.js` | New `SMOKE_DROPDOWN` scenario |
| `test/e2e/run.js` | Matching assertion |

No HTML or CSS change is required — the markup already gives every dropdown the
`.tb-dropdown` / `.tb-menu` hooks a generic controller needs.

## 7. External research

None needed. This is a well-understood single-open-menu / roving-flyout pattern;
the WAI-ARIA menu-button practice (trigger owns `aria-expanded`, only one menu
open per menubar, Esc closes and returns focus to the trigger) is the reference
behaviour. `#btn-help` already sets `aria-expanded`; the three rail triggers do
not — worth aligning while the code is being unified.

## 8. Risk

Low. The change is confined to event wiring in one file, with a mechanical
before/after equivalence for every existing path. The main risk is **over-closing**:
a shared controller that closes on any document click would kill the menu when the
user ticks "Snap to drawing" or opens the colour wheel. The guard must be
"click landed outside the owning `.tb-dropdown`".
