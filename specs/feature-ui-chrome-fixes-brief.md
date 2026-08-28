# Research Brief — Top-bar chrome defects, bookmark-shelf clarity, in-app tooltips

**Phase 1 (deep-researcher) · feature slug: `ui-chrome-fixes`**

## 1. What was reported

A screenshot of FieldMark running on macOS (markup mode active, find bar open,
the **Bookmarked pages** shelf open) plus two follow-up asks:

> "fix all of these UI bugs you see in this picture"
>
> "improve the way you know which pages are actually bookmarked when you click
> that button next to bookmark page"
>
> "implement a feature when you hover over a menu button it tells you what its
> named"

## 2. Reproduction (not inference)

The defects were reproduced in the real renderer rather than read off the
screenshot. `www/` was assembled with `npm run build:web` and driven in headless
Chromium — the same engine the Android WebView runs — with
`html.platform-mac` forced on so the `styles/liquid-glass.css` skin applies, a
fixture PDF loaded, `App.state.bookmarks` seeded with a mix of foreign and
our-own entries, and markup mode + the find bar opened. Geometry and paint order
were then read back with `getBoundingClientRect()` and `document.elementFromPoint()`.

Measured at a 1400x900 viewport:

```
#toolbar        top   0  bottom  52     z-index 20   scrollWidth 1475 / clientWidth 1400
#mode-banner    top  52  bottom  86     z-index 20
#markup-props   top  86  bottom 126     z-index 20
#find-bar       top  94  bottom 142     z-index 30
#bookmark-menu  top  47  bottom 306     z-index 40   (child of #toolbar)

elementFromPoint(menu centre, menu.top +  8)  ->  #mode-banner
elementFromPoint(menu centre, menu.top + 60)  ->  #markup-props
```

At a 900x900 viewport:

```
#toolbar scrollWidth 1278 / clientWidth 900
#btn-updates right edge = 1193   (293px past the right window edge)
```

## 3. Stack (detected, not chosen)

Vanilla JS on a global `App` object, no bundler, no framework. PDF.js viewer +
pdf-lib export. Electron (desktop) and Capacitor (Android) both run
`src/renderer/`. Styling is hand-written CSS in `src/renderer/styles.css`, tokens
in `styles/tokens.css`, and a macOS-only `styles/liquid-glass.css` overlay loaded
last.

Every defect below is **renderer-only (Tier A)**: no `window.api` surface, no
file I/O, no platform branch inside an app module. All of it ships to Windows,
macOS and Android for free.

## 4. The defects, with root causes

### BUG-1 — Top-bar controls run off the right edge and become unreachable

`src/renderer/js/app.js:974` `setupMobileOverflow()` relocates every
`[data-overflow]` control into the `⋯` menu, but only when
`window.matchMedia('(max-width: 820px)')` matches. The top bar's real intrinsic
width is far larger than 820px: measured child widths (brand 125, Open 81, zoom
group 341, page group 146, save group 169, theme/help/version group 153, three
1px separators, 8px gaps, 20px padding) come to **~1120px minimum**, and 1475px
of content is reported at 1400px of space.

So for every viewport between 821px and roughly 1480px the bar silently
overflows: `#toolbar` has no `overflow-x` outside the mobile query, so the
right-hand controls are simply painted past the window edge with no scrollbar and
no `⋯` fallback. At 900px, **Save As…, the theme toggle, Help and the version /
Update button are all off-screen and unreachable.** This is the clipped "Update"
button in the screenshot.

The fixed breakpoint is the bug. Whether the bar fits depends on the UI font,
the locale, the version string length and the safe-area insets — none of which a
hard-coded `820px` can know.

### BUG-2 — Toolbar dropdowns paint underneath the contextual bars

`#toolbar` is `position: relative; z-index: var(--z-chrome)` (20)
(`styles.css:38`), which makes it a **stacking context**. `.tb-menu` sets
`z-index: var(--z-flyout)` (40) (`styles.css:700`), but that 40 is resolved
*inside* the toolbar's context — it can never lift the menu above the toolbar's
own 20. `#mode-banner` (`styles.css:108`) and `#markup-props`
(`styles.css:376`) are also `--z-chrome` (20) and come **later** in DOM order, so
they win the tie and paint over the menu. `#find-bar` at `--z-float` (30)
(`styles.css:346`) beats it outright.

The `elementFromPoint` probes above confirm it: the shelf's title row and its
first entries are literally not hittable — the banner and the props bar are.

The token comment in `styles/tokens.css:58` already states the intent —
*"`--z-flyout: 40` menus opened from chrome — must cover those tools"* — so this
is a stacking-context trap, not a disagreement about layering.

### BUG-3 — On macOS the dropdowns are see-through and illegible

`styles/liquid-glass.css:75` gives `html.platform-mac #toolbar` a
`backdrop-filter: var(--lg-blur)`, and line 260 gives `html.platform-mac .tb-menu`
the same. Per the Filter Effects spec, **an element with `backdrop-filter`
becomes a Backdrop Root for its descendants**. `#bookmark-menu`, `#help-menu` and
`#more-menu` all live inside `#toolbar`, so their own `backdrop-filter` samples
the toolbar's (empty) backdrop root instead of the page behind the window — the
blur is computed but paints nothing.

What is left is `--lg-material-strong` alone: `rgba(21,33,47,0.74)` dark /
`rgba(255,255,255,0.80)` light. In the reproduction, the words
"Sample drawing — page 1 of 3" read through the shelf perfectly sharply, exactly
as the sheet's title block does in the reported screenshot.

Note the same trap does **not** currently bite the left rail's flyouts: they were
probed and paint correctly, because nothing overlaps them at the same z.

### BUG-4 — The bookmark shelf does not say which pages are actually bookmarked

`src/renderer/js/bookmarks.js:104` `renderShelf()` renders
`App.flattenOutline(tree())` as `.bm-row` buttons. Reading the shelf, a user
cannot answer "which pages are bookmarked?" because:

- **No current-page marker.** Nothing in the shelf relates to the page in view,
  so the shelf and the `#btn-bookmark` toggle tell two unconnected stories.
- **Provenance is a native tooltip.** `bookmarks.js:130` sets
  `row.title = 'Bookmark saved in this document'` for foreign entries. A native
  `title` is drawn by the OS, after a delay, wherever the OS chooses — in the
  reported screenshot it landed at the top-left of the window, over the **Open**
  button, ~900px from the row it describes. It is also invisible on the Android
  WebView. The only other cue is `.bm-foreign .bm-title { font-style: italic }`
  (`styles.css:1972`) — an unlabelled italic that no one can be expected to decode.
- **Tree order, not page order.** `flattenOutline` is a depth-first walk
  (`src/shared/outline.js:34`). A received drawing set lists p.28, p.31, p.26 in
  whatever order its outline happens to be in, so the shelf cannot be scanned for
  a page.
- **No count**, and no page number on the shelf title.
- `hasOurBookmark` (`src/shared/outline.js:62`) is deliberately *ours only*, and
  that is correct — the toggle must not delete someone else's entry. But it means
  `#btn-bookmark` reads "not bookmarked" on a page that visibly *is* bookmarked
  in the shelf. That contradiction is the heart of the complaint and is a
  **display** problem, not a reason to change the toggle's semantics.

### BUG-5 — No in-app tooltips (the requested feature)

`src/renderer/index.html` carries 121 `title="…"` attributes and 21 more are
assigned from JS. Every one of them relies on the OS tooltip, which is:
slow (~1s delay), unstyled, positioned by the OS rather than by the control,
and **entirely absent on the Android WebView**, where there is no hover. The
top-left tooltip fouling the Open button in the screenshot is that mechanism
misbehaving.

## 5. Constraints that shape the fix

- **`CLAUDE.md` cross-platform rule.** Renderer-only, no new dependencies, no
  framework, no bundler. Anything added lives in `src/renderer/js/` +
  `src/shared/` and is bundled into `www/` by `scripts/build-web.js`.
- **`styles/liquid-glass.css` is additive and `html.platform-mac`-scoped.**
  Windows and Android must keep the opaque "drafting table" chrome untouched.
- **The 820px mobile layout is load-bearing.** `styles.css:1540` gives the top
  bar sticky Open/`⋯` ends, a horizontally scrollable row, safe-area padding and
  a `position: fixed` `⋯` sheet. Nothing in that block may regress.
- **`title` attributes are not asserted by any test.** `test/e2e/run.js` and the
  `SMOKE_*` harness in `src/main.js` were checked: no assertion reads an element
  `title`. (They do read outline *node* titles, which are unrelated.)
- **Existing regression surface:** `SMOKE_BOOKMARKS` in `src/main.js:2561` and
  `test/e2e/run.js:345` assert that saving preserves both our `Page 3` entry and
  the document's own `Client Index` entry. Shelf presentation must not touch the
  tree model that those assertions cover.

## 6. Prior art considered

- **Portalling the menus to `<body>`** to escape both the stacking context and
  the backdrop root. Rejected as the primary fix: it would need JS repositioning
  on scroll/resize for four menus and breaks the `.tb-dropdown { position:
  relative }` anchoring the whole app uses. Kept as a fallback if the
  pseudo-element approach fails.
- **`backdrop-filter` on a `::before` pseudo-element** instead of on `#toolbar`
  itself. A pseudo-element paints the blur across the toolbar's box without the
  *element* `#toolbar` carrying the property, so it no longer becomes a Backdrop
  Root for its DOM children. This is the standard workaround for nested glass and
  is a two-line CSS change.
- **CSS-only tooltips (`::after` + `content: attr(...)`)**. Rejected: they are
  clipped by any ancestor with `overflow: hidden` — which `#markup-props`,
  `#bookmark-menu` and the mobile `#toolbar` all have — and they cannot be
  flipped to stay inside the viewport. A single `position: fixed` tooltip element
  driven by delegated pointer events avoids both problems and costs one small
  module.
- **Rewriting the 142 `title` sites.** Rejected. A `MutationObserver` on the
  `title` attribute migrates `title` → `data-tip` (+ `aria-label` when absent)
  wherever and whenever it is set, so all 21 dynamic assignment sites keep
  working untouched.

## 7. Files this will touch

| File | Why |
|---|---|
| `src/renderer/styles.css` | `#toolbar` stacking (BUG-2), `.g-more` collapse state (BUG-1), bookmark-shelf rows (BUG-4), tooltip styles (BUG-5) |
| `src/renderer/styles/liquid-glass.css` | move the toolbar's `backdrop-filter` to a pseudo-element (BUG-3) |
| `src/renderer/js/app.js` | measurement-driven top-bar overflow (BUG-1) |
| `src/renderer/js/bookmarks.js` | shelf rendering + button state (BUG-4) |
| `src/renderer/js/tooltip.js` *(new)* | in-app tooltips (BUG-5) |
| `src/renderer/index.html` | load the new module |
| `src/main.js` | new `SMOKE_*` scenarios |
| `test/e2e/run.js` | matching assertions |

`scripts/build-web.js` copies `src/renderer/js/*.js` wholesale — confirmed — so
the new module needs no build change.

## 8. Open questions

None blocking. The two follow-up asks are unambiguous and the defects reproduce
deterministically.
