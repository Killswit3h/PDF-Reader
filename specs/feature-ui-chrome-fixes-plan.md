# Build Plan — `ui-chrome-fixes`

**Phase 3 (dev-project-manager) · slug `ui-chrome-fixes`**

## Stack (detected — no decision to make)

Vanilla JS on a global `App` object, no bundler, no framework, no new
dependencies. PDF.js + pdf-lib. Electron + Capacitor share `src/renderer/`.
Hand-written CSS with tokens in `styles/tokens.css`.

Per `CLAUDE.md`: **`backend-agent` and `security-agent` have almost no surface
here.** Nothing in this change crosses the `window.api` contract, touches the
filesystem, parses untrusted bytes, or adds network access. The security track
reduces to the two review items in WO-6.

## Work orders

Ordered so each lands independently and the tree stays releasable.

### WO-1 — Lift toolbar dropdowns above the contextual bars (FR-6, FR-7)

`src/renderer/styles.css`

`#toolbar` is a stacking context at `--z-chrome` (20), trapping its `.tb-menu`
children's `--z-flyout` (40). Raise `#toolbar` itself to `--z-flyout` so the
context it establishes sits above `#mode-banner`, `#markup-props`, `#find-bar`,
`#tool-rail`, `#tab-bar` and the side panels — none of which the toolbar overlaps
geometrically, so nothing is newly occluded.

Add a comment recording *why* the toolbar sits in the flyout layer, since the
value looks wrong for a bar until you know it hosts the flyouts.

Leave `#mode-banner`, `#markup-props` and `#find-bar` untouched (FR-7).

**Done when:** AC-6, AC-7.

### WO-2 — Restore the glass blur under toolbar dropdowns (FR-8, FR-9, FR-10)

`src/renderer/styles/liquid-glass.css`

`html.platform-mac #toolbar` carries `backdrop-filter`, which makes it a Backdrop
Root for `#bookmark-menu`, `#help-menu` and `#more-menu`, so their own
`backdrop-filter` samples nothing.

Move the toolbar's blur onto a `#toolbar::before` that fills the bar
(`position: absolute; inset: 0; z-index: -1`). The blur then paints across the
same box, but the *element* `#toolbar` no longer carries `backdrop-filter`, so it
is no longer a Backdrop Root and its dropdown descendants blur the real page
behind the window again.

Constraints:
- `#toolbar` keeps `position: relative` (it already has it) so the pseudo-element
  is contained.
- The specular inset shadow, hairline, material fill and `-webkit-app-region:
  drag` move with the blur or stay put such that the bar looks identical (FR-10).
- The pseudo-element must not swallow pointer events (`pointer-events: none`) and
  must sit behind the bar's controls.
- Every rule stays under `html.platform-mac` (FR-9).

Apply the same treatment to `#mode-banner` if it is in the same selector list and
also hosts nothing — **it does not host dropdowns, so leave it alone** and keep
the change minimal.

**Done when:** AC-8, AC-9.

### WO-3 — Measurement-driven top-bar overflow (FR-1…FR-5)

`src/renderer/js/app.js` (`setupMobileOverflow`), `src/renderer/styles.css`

Replace the `matchMedia('(max-width: 820px)')` decision with a measured one:

1. At init — before any relocation, so the bar is in its expanded state —
   measure `needWidth`: the sum of `#toolbar`'s non-`.tb-spacer` children's
   widths, plus `column-gap × (children − 1)`, plus horizontal padding.
   Re-measure on every pass that ends expanded, so font/locale/version-string
   changes are picked up.
2. `shouldCollapse = mq.matches || needWidth > toolbar.clientWidth` (FR-2).
3. Hysteresis: once collapsed, expand only when
   `clientWidth >= needWidth + SLACK` (8px) (FR-3).
4. Toggle `document.body.classList` `toolbar-collapsed` alongside the relocation
   so CSS can reveal `.g-more` above 820px.
5. Drive it from a `ResizeObserver` on `#toolbar` when available, else the
   `resize` event; keep the `matchMedia` listener as the floor (error table).

CSS:
- `body.toolbar-collapsed .g-more { display: flex; }` — beats the global
  `.g-more { display: none }` at `styles.css:1213`.
- `body.toolbar-collapsed #more-menu { left: auto; right: 0; }` so the desktop
  sheet stays inside the window (FR-5). The ≤820px block already fixes it to the
  top-right and must keep winning there.
- Nothing inside `@media (max-width: 820px)` changes (FR-2).

Guard against re-entrancy: relocation changes `#toolbar`'s layout and would
re-fire the `ResizeObserver`; set a flag around the mutation.

**Done when:** AC-1…AC-5.

### WO-4 — Bookmark shelf you can actually read (FR-11…FR-17)

`src/renderer/js/bookmarks.js`, `src/renderer/styles.css`, `src/renderer/index.html`

**Model is out of scope.** `src/shared/outline.js` is not modified: `flattenOutline`
keeps its depth-first walk and signature; the shelf sorts the rows it returns.

- **Sort (FR-11):** stable sort of the flattened rows by `page`. `Array.prototype.sort`
  is stable in every engine this ships on, so equal pages keep tree order.
- **Provenance (FR-13):** each row gains a small icon plus a short visible label —
  "Added here" for `mine`, "In document" otherwise — rendered as a `.bm-tag`.
  The `row.title = 'Bookmark saved in this document'` line at `bookmarks.js:130`
  is removed; nothing about provenance depends on hover any more. `.bm-foreign`'s
  italic stays as a secondary cue.
- **Current page (FR-12):** rows whose `page === App.state.currentPage` get
  `.bm-current` and `aria-current="true"`. `renderShelf()` is already called from
  the page-change path via `refreshButton`'s callers — verify and, if not, wire
  the shelf refresh into the same place `#btn-bookmark` is refreshed
  (`viewer.js:119`, `viewer.js:852`).
- **Counts (FR-14):** the `.tb-menu-title` becomes dynamic — an element id so the
  count can be written, e.g. "7 bookmarks · 2 added here".
- **Three-state toggle (FR-15):** `refreshButton()` gains a `foreign` state when
  the page has no entry of ours but does have one from the document. Needs a
  "does *any* entry point at this page" read — a small local helper in
  `bookmarks.js` over the already-flattened rows, **not** a change to
  `hasOurBookmark` (FR-16). New class `.bm-btn-foreign` on `#btn-bookmark`; the
  `aria-label`/`title` says so.
- Empty state and unresolvable entries unchanged (FR-17, error table).

**Done when:** AC-10…AC-15.

### WO-5 — In-app tooltips (FR-18…FR-25)

`src/renderer/js/tooltip.js` *(new)*, `src/renderer/index.html`,
`src/renderer/styles.css`

One delegated listener set and one `position: fixed` tooltip node appended to
`<body>` — so no ancestor `overflow: hidden` can clip it (FR-22) and it escapes
every stacking context.

- **Name migration (FR-20, FR-21, FR-24):** a `MutationObserver` with
  `attributeFilter: ['title']` over `document.body`, plus a one-time sweep at
  init. For each element with a `title`: copy it to `data-tip`, set `aria-label`
  from it when the element has neither an `aria-label` nor its own trimmed text,
  then remove `title`. All 21 runtime `el.title = …` sites keep working with no
  edit.
  - Skip elements inside `<svg>` (`<title>` there is a child element, not this
    attribute — but guard the attribute case anyway) and any element carrying
    `data-no-tip`.
- **Show/hide (FR-18, FR-19, FR-23):** `pointerover` / `pointerout` /
  `focusin` / `focusout` delegated on `document`, resolving
  `e.target.closest('[data-tip]')`. ~450ms delay on hover, immediate on focus.
  Hide on `click`, `keydown` `Escape` (without consuming the key — the app's own
  Esc handling must still run), `scroll` (capture) and `pointerdown`.
- **Placement (FR-22):** below the control by default, flipped above when it
  would leave the viewport, and clamped horizontally to an 8px margin.
- **Touch (FR-25):** the whole hover path is gated on
  `matchMedia('(hover: hover) and (pointer: fine)')`. Focus tooltips still work.
  No listener calls `preventDefault()`, so no tap is altered.
- **Inert (FR-23):** `pointer-events: none`, `aria-hidden="true"`.
- Respects `prefers-reduced-motion` like the rest of the app's surfaces.

Script tag goes after `util.js` and before `app.js` in `index.html`;
`scripts/build-web.js` copies `src/renderer/` wholesale, so `www/` picks it up
with no build change (verified).

**Done when:** AC-16…AC-22.

### WO-6 — Security review (thin, by design)

Two items only, since there is no server, no auth and no new I/O:

1. **No untrusted string reaches `innerHTML`.** The shelf renders titles that
   come out of a *user-supplied PDF's* outline. Today `bookmarks.js:126` builds
   the row with `innerHTML` for the *structure* and then assigns the title via
   `textContent` — correct. The new provenance tag and count must keep that
   discipline: structure via `innerHTML` with no interpolation, all text via
   `textContent`.
2. **The tooltip renders `data-tip`, which can carry a PDF-derived string.** It
   must be written with `textContent`, never `innerHTML`.

### WO-7 — Tests (`CLAUDE.md`: a new renderer feature needs a `SMOKE_*` scenario)

`src/main.js`, `test/e2e/run.js`, plus a headless-web check.

- `SMOKE_CHROME_LAYERING` — markup mode + find bar + shelf open; assert
  `elementFromPoint` at the shelf's title/first/last rows lands inside
  `#bookmark-menu` (AC-6, AC-7).
- `SMOKE_TOOLBAR_OVERFLOW` — resize to 900, assert no control's `right` exceeds
  `innerWidth` and that `#more-menu` holds the relocated controls; resize back,
  assert every control is home (AC-1…AC-3).
- `SMOKE_BOOKMARK_SHELF` — seed a mixed outline, assert page ordering, the
  `aria-current` marker, per-row provenance labels, the header counts, and the
  three-state toggle (AC-10…AC-14).
- `SMOKE_TOOLTIP` — assert `#btn-open` has no `title`, has an accessible name,
  and that hovering shows `#tooltip` with that name; assert a runtime `title`
  reassignment is picked up (AC-16…AC-18, AC-21).
- The macOS-only blur check (AC-8) cannot run under Electron on Linux CI; it runs
  in the headless-web harness with `html.platform-mac` forced, sampling pixel
  luminance variance inside the panel with the panel open vs closed.

## Integration contract

No new `window.api` methods. No changes to `src/preload.js` or
`src/renderer/js/platform-web.js`. No new files under `src/shared/`.

New global: `App.Tooltip` with `{ init(), show(el), hide(), refresh(el) }`.
New DOM node: `#tooltip` appended to `<body>` at init.
New body classes: `toolbar-collapsed`.
New element classes: `.bm-current`, `.bm-tag`, `.bm-btn-foreign`.
New element id: the shelf header's count element.

## Regression boundary — must still pass after the change

Exercised explicitly in Phase 5:

1. `SMOKE_BOOKMARKS` (`src/main.js:2561`, `test/e2e/run.js:345`) — saving keeps
   both our `Page 3` entry and the document's own `Client Index` entry.
2. The ≤820px mobile top bar: sticky Open and `⋯`, scrollable row, `⋯` sheet
   fixed top-right, safe-area padding.
3. Left-rail flyout mutual exclusion (`rail-menu-exclusivity`) and rail-menu
   paint order.
4. The find bar: open, count, next/prev, close, and its position under the
   banner/props bars.
5. The mode banner's Finish/Cancel actions in markup and measure modes.
6. Theme toggle, light and dark, on both the default skin and `platform-mac`.
7. Tab bar with two documents open (`.tab-menu` is `position: fixed` and must
   still paint above the toolbar).
8. `npm test`, `npm run test:e2e`, `npm run verify:web` all green.

## Sequencing

WO-1 → WO-2 (both CSS, independent of JS) → WO-3 → WO-4 → WO-5 → WO-6 review →
WO-7 tests. One Conventional Commit per work order, each referencing its FRs.

Branch: `claude/feature-pipeline-ui-bugs-ta2ox5` (the session's designated
branch; `CLAUDE.md`'s golden rule — never commit features to `main`).
Delivery is a **draft PR**, not a merge — `CLAUDE.md` overrides the generic
pipeline's Phase 6 merge step for this repo.
