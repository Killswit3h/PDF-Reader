# Spec — Top-bar chrome fixes, bookmark-shelf clarity, in-app tooltips

**Phase 2 (spec-designer) · slug `ui-chrome-fixes` · type: bug fix + small feature**

## Problem

Five defects, all in the app's chrome, all reproduced in headless Chromium (see
`specs/feature-ui-chrome-fixes-brief.md` §2 for measurements):

1. Between 821px and ~1480px of viewport width the top bar overflows the window
   and Save As…, the theme toggle, Help and the version/Update button become
   unreachable. The `⋯` overflow only engages at ≤820px.
2. Toolbar dropdowns paint *underneath* the mode banner, the markup properties
   bar and the find bar, because `#toolbar` is itself a stacking context at the
   same z-index as those bars.
3. On macOS those dropdowns are see-through: their `backdrop-filter` is neutered
   by `#toolbar`'s own `backdrop-filter` (nested Backdrop Root), leaving a
   0.74–0.80 alpha wash over sharp document text.
4. The bookmark shelf cannot be read for "which pages are bookmarked": no
   current-page marker, no page ordering, no count, and provenance conveyed only
   by an OS tooltip that lands on the other side of the window.
5. Every control's name is delivered by the native `title` tooltip — slow,
   unstyled, OS-positioned, and absent entirely on Android.

## Goal

The top bar keeps every control reachable at every width; menus opened from the
top bar sit above all chrome and are opaque enough to read; the bookmark shelf
answers "which pages are bookmarked" at a glance; and hovering or focusing any
control names it, in-app, on every platform.

## Functional requirements

### Top bar overflow

**FR-1 — The `⋯` collapse is driven by measurement, not by a fixed breakpoint.**
WHEN the top bar's controls require more horizontal space than the bar has, the
app SHALL relocate every `[data-overflow]` control into the `⋯` menu and reveal
the `⋯` button. WHEN the bar has room for all of them, the app SHALL return each
control to its original slot.

**FR-2 — The ≤820px behaviour is preserved as a floor.**
WHERE the viewport is 820px or narrower, the controls SHALL be collapsed
regardless of measurement, so the existing mobile layout
(`styles.css:1540`, sticky Open/`⋯`, scrollable row, safe-area padding, fixed
`⋯` sheet) engages exactly as it does today.

**FR-3 — Collapse and expand SHALL NOT oscillate.**
The width at which the bar expands SHALL be at least the width at which it
collapses, so a viewport resting on the threshold settles in one state.

**FR-4 — No control is ever painted outside the window.**
At every viewport width from 320px upward, with a document open, every top-bar
control SHALL be either inside the window's horizontal bounds or inside the `⋯`
menu.

**FR-5 — The `⋯` menu is usable above 820px.**
WHERE the bar is collapsed on a desktop-width viewport, the `⋯` menu SHALL open
anchored to the right of its button and remain fully inside the window.

### Menu layering

**FR-6 — Menus opened from the top bar paint above all chrome.**
A menu opened from `#toolbar` SHALL paint above `#mode-banner`, `#markup-props`,
`#find-bar`, the tool rail, the tab bar and the side panels, and every one of its
rows SHALL be the top-most element at its own coordinates (hit-testable).

**FR-7 — Layering SHALL NOT be achieved by raising the bars' z-index.**
`#mode-banner`, `#markup-props` and `#find-bar` keep their current tokens, so the
rest of the layering model is unchanged.

### Menu legibility

**FR-8 — Toolbar dropdowns are legible over document content on macOS.**
WHERE `html.platform-mac` applies, the content behind a toolbar dropdown SHALL be
blurred by the dropdown's backdrop filter — not merely tinted — so no document
text is readable through the panel.

**FR-9 — The macOS skin stays additive.**
Windows and the Android WebView SHALL render the toolbar and its dropdowns
exactly as they do today; no rule outside `html.platform-mac` changes appearance.

**FR-10 — The toolbar's own glass is unchanged.**
The top bar SHALL keep its frosted material, specular top edge, hairline and
`-webkit-app-region: drag` behaviour on macOS.

### Bookmark shelf

**FR-11 — Rows are ordered by page.**
The shelf SHALL list entries in ascending page order. Entries sharing a page keep
their relative order from the outline tree.

**FR-12 — The current page is marked.**
The row (or rows) whose page equals the page in view SHALL be visually
distinguished and carry `aria-current="true"`.

**FR-13 — Provenance is visible, not hovered.**
Each row SHALL carry a visible, labelled indicator of whether the entry was added
in FieldMark or arrived with the document. The indicator SHALL NOT depend on a
tooltip, on hover, or on italics alone.

**FR-14 — The shelf reports its own size.**
The shelf header SHALL state how many entries it lists and how many of those were
added in FieldMark.

**FR-15 — The bookmark toggle distinguishes three states.**
`#btn-bookmark` SHALL communicate: this page has our bookmark; this page has only
a bookmark that came with the document; this page has none. Its accessible name
SHALL say which.

**FR-16 — The toggle's semantics are unchanged.**
Pressing `#btn-bookmark` SHALL still add or remove only *our* bookmark for the
current page, and SHALL NEVER add, remove or rewrite an entry that came with the
document.

**FR-17 — Unresolvable entries stay out of the shelf and stay in the tree.**
Entries whose destination cannot be resolved SHALL continue to be omitted from
the shelf and preserved on save.

### In-app tooltips

**FR-18 — Hovering a control names it.**
WHERE the pointer supports hover, hovering a control that has a name SHALL show
an in-app tooltip with that name, anchored to the control, after a short delay.

**FR-19 — Keyboard focus names it too.**
Focusing such a control from the keyboard SHALL show the same tooltip
immediately.

**FR-20 — The tooltip replaces the native one.**
No native OS tooltip SHALL appear for any control the in-app tooltip covers.

**FR-21 — Dynamic names are honoured.**
WHEN code assigns a new `title` to a control at runtime, the tooltip SHALL show
the new text without that call site being modified.

**FR-22 — The tooltip stays inside the window.**
The tooltip SHALL be repositioned (flipped or shifted) so it is never painted
outside the viewport, and SHALL never be clipped by an ancestor's `overflow`.

**FR-23 — The tooltip is inert.**
It SHALL NOT receive pointer events, SHALL be hidden from assistive technology
(the control keeps its own accessible name), and SHALL dismiss on click, on
`Esc`, on scroll, on `blur` and on pointer-leave.

**FR-24 — Accessible names survive.**
Migrating a control's name out of `title` SHALL leave the control with an
equivalent accessible name (`aria-label` or its own text), so nothing regresses
for screen readers.

**FR-25 — Touch is unaffected.**
WHERE the pointer is coarse, hover tooltips SHALL NOT appear, and no tap SHALL be
delayed, swallowed or altered.

## Acceptance criteria

**AC-1 (FR-1, FR-4).** *Given* a document is open and the viewport is 900x900,
*when* the top bar is measured, *then* `#toolbar.scrollWidth <= #toolbar.clientWidth`
and every top-bar control's `right` is `<= window.innerWidth`.

**AC-2 (FR-1).** *Given* the viewport is 900px wide, *when* the `⋯` menu is
opened, *then* it contains `#btn-save-as`, `#btn-updates` and the page-number
group.

**AC-3 (FR-1, FR-3).** *Given* the viewport is resized 1600 → 900 → 1600, *then*
the controls end up back in their original parents in their original order, and
the `⋯` group is hidden.

**AC-4 (FR-2).** *Given* the viewport is 800px wide, *then* the controls are
collapsed and `#toolbar` is horizontally scrollable, as today.

**AC-5 (FR-5).** *Given* a 900px viewport with the bar collapsed, *when* `⋯` is
opened, *then* the menu's `right <= window.innerWidth` and its `left >= 0`.

**AC-6 (FR-6).** *Given* markup mode is active (mode banner and properties bar
both shown) and the find bar is open, *when* the bookmark shelf is opened, *then*
`document.elementFromPoint()` at the shelf's title row, at its first row and at
its last row returns an element inside `#bookmark-menu`.

**AC-7 (FR-6).** Same as AC-6 for `#help-menu`.

**AC-8 (FR-8).** *Given* `html.platform-mac` and the shelf open over page text,
*when* the shelf's pixels are sampled, *then* the sampled region contains no
high-contrast text edges from the document beneath — measured as: the standard
deviation of luminance inside the panel is below the threshold measured for the
same region with the panel closed, by at least 4x.

**AC-9 (FR-9).** *Given* `html.platform-mac` is absent, *then* the computed
`background-color` and `backdrop-filter` of `#toolbar` and `.tb-menu` are
byte-identical to the pre-change build.

**AC-10 (FR-11).** *Given* an outline whose entries resolve to pages 5, 2, 9, 2,
*when* the shelf renders, *then* the rows read 2, 2, 5, 9.

**AC-11 (FR-12).** *Given* the viewer is on page 2 and the shelf lists an entry
for page 2, *then* exactly the page-2 rows carry `aria-current="true"` and a
`.bm-current` class; *when* the viewer moves to page 5, *then* the marker moves.

**AC-12 (FR-13).** *Given* a shelf containing one entry we added and one that
came with the file, *then* each row exposes a non-empty visible provenance label,
and no row relies on a `title` attribute to convey it.

**AC-13 (FR-14).** *Given* a shelf with 7 entries of which 2 are ours, *then* the
header text names both counts.

**AC-14 (FR-15).** *Given* page 3 carries only a bookmark that came with the
document, *then* `#btn-bookmark` is neither in the plain nor the `armed` state
but in a distinct third state, and its `aria-label` says the bookmark came with
the document.

**AC-15 (FR-16, FR-17).** *Given* a document whose outline contains a foreign
entry `Client Index` and our `Page 3`, *when* a bookmark is toggled on and off
and the file is saved and reopened, *then* both entries are present and the
foreign one is byte-unchanged. *(This is the existing `SMOKE_BOOKMARKS`
assertion; it must still pass.)*

**AC-16 (FR-18, FR-20).** *Given* a hover-capable pointer, *when* the pointer
rests on `#btn-open`, *then* an element `#tooltip` becomes visible with the text
of that button's name, and `#btn-open` has no `title` attribute.

**AC-17 (FR-19).** *Given* `#btn-save` is focused via keyboard, *then* the
tooltip is visible with that button's name.

**AC-18 (FR-21).** *Given* the tooltip system is running, *when*
`App.Bookmarks.refreshButton()` reassigns `#btn-bookmark.title`, *then* hovering
that button shows the newly assigned text.

**AC-19 (FR-22).** *Given* a control within 40px of the right window edge, *when*
its tooltip shows, *then* the tooltip's `right <= window.innerWidth` and
`left >= 0`.

**AC-20 (FR-23).** *Given* a tooltip is visible, *when* `Esc` is pressed, *then*
the tooltip hides; and `getComputedStyle(tooltip).pointerEvents === 'none'` and
`tooltip.getAttribute('aria-hidden') === 'true'` at all times.

**AC-21 (FR-24).** *Given* every control that had a `title` in the shipped
`index.html`, *then* each still has a non-empty accessible name
(`aria-label`, or its own trimmed text content).

**AC-22 (FR-25).** *Given* a coarse pointer, *when* a control is tapped, *then*
its click handler runs exactly once and no tooltip is shown.

## Error handling

| Condition | Behaviour |
|---|---|
| The top bar is narrower than the primary controls alone (<~360px) | Collapse, then let `#toolbar` scroll horizontally — today's ≤820px behaviour. Never clip. |
| `ResizeObserver` unavailable in the host WebView | Fall back to the `resize` event plus the existing `matchMedia('(max-width: 820px)')`; never leave controls off-screen. |
| A control is moved into `⋯` while its tooltip is showing | Hide the tooltip; the control keeps its name. |
| A control is removed from the DOM while its tooltip is showing | Hide the tooltip on the next frame; no error. |
| `backdrop-filter` unsupported by the engine | The dropdown falls back to its opaque `--panel` background — legible, just not frosted. |
| The outline contains an entry with `page === null` | Omitted from the shelf (unchanged), still written on save (unchanged). |
| The outline is empty | The existing empty-state string is shown; the header reports zero counts. |
| A page carries both our bookmark and a foreign one | The toggle reports *our* state (FR-16); the shelf lists both rows, each with its own provenance label. |

## Out of scope (regression boundary — must behave exactly as today)

- The bookmark **model**: `src/shared/outline.js`, `App.toggleBookmark`,
  `App.hasOurBookmark`, `App.flattenOutline`'s tree walk, `B.read`,
  `B.writeOutline`, and the round-trip sidecar. Only *presentation* changes.
  `flattenOutline` keeps its current signature and depth-first output; ordering
  for display happens in the shelf.
- Saving, exporting, form fill/flatten, `pdf-lib` output bytes.
- The left tool rail's flyouts, their mutual-exclusion behaviour, and the
  `markup-rail`.
- The find bar's search behaviour, counts and navigation.
- Measure, markup, organize, docstamp, OCR, compare, split view, tabs, print,
  digital signatures.
- The ≤820px mobile layout's visual design.
- Theme tokens, the light/dark palette, and every non-`platform-mac` surface.
- The guided tour, the what's-new notes, and the update check.

## Deferred to `specs/backlog.md`

- Editing a bookmark's title from the shelf.
- Deleting a foreign bookmark (deliberately impossible today).
- Long-press tooltips on touch.
- A keyboard-shortcut hint line inside the tooltip.
