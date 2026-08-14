# Spec — Markup selection defect + tool rail size

Phase 2 output. **The spec is the contract**: later phases are checked against this
document, and anything not written here is out of scope.

Scope decision (approved at Phase 1 checkpoint): this run ships the **defect pair
(requests 4 + 5)** and the **rail size (request 3)**. Requests 1, 2 and 6 are
deferred to a second pipeline run and recorded in `specs/backlog.md` with their
design decisions already made, so run 2 does not re-litigate them.

## 1. Overview and user value

Two of the six reported problems turned out to be one defect: every markup is
auto-selected the instant you finish drawing it, and that lingering selection both
(a) makes the colour picker recolour what you just drew instead of setting the
colour for the next thing, and (b) keeps the markup properties bar on screen after
you switch to another tool, so two toolbars are visible at once. Today the only
workaround is pressing Escape.

Value: redlining stops fighting the user. Pick a colour mid-session and the *next*
markup uses it; switch tools and only that tool's chrome is on screen.

Separately, the left tool rail is wider than it needs to be, costing drawing area on
every sheet.

## 2. Scope

**In scope**
1. Colour (and any style) change is prospective while a markup tool is armed.
2. Arming any tool clears object selections from the other layers, so exactly one
   contextual bar is ever visible.
3. The left tool rail gets smaller.

**Out of scope — must not be touched**
- Bookmarks, page-jump panel, print-preview performance (deferred; see backlog).
- The right-hand `#markup-rail`, the mode banner's text, and the markup properties
  bar's *contents* (only its visibility rules change).
- The collapsed rail state (56px), which already ships and stays as-is.
- Any `window.api` / `src/preload.js` / `platform-web.js` change. All three
  requirements are renderer-only (Tier A) and must stay that way.
- The export path (`save.js`) and anything touching PDF geometry.

## 3. Functional requirements (EARS)

**FR-1** — While a markup tool is armed, when the user changes a style property
(colour, width, opacity, fill, font), the system shall apply the change only to the
default style for subsequently drawn markups, and shall not modify any existing
markup.

**FR-2** — While no markup tool is armed and a markup is selected, when the user
changes a style property, the system shall apply the change to the selected markup
and to the default style, as it does today.

**FR-3** — When the user arms any tool (markup, measure, signature, initials, date,
stamp), the system shall clear the current object selection on every layer
(placement, markup, measurement).

**FR-4** — While any tool is armed, the system shall display the contextual bar for
that tool only, and shall not display a contextual bar belonging to a previously
active tool.

**FR-5** — When the user leaves all tools (Select / Escape), the system shall retain
any existing object selection so the item can still be nudged, copied or deleted.

**FR-6** — The system shall render the expanded left tool rail at 130px wide with
34px-tall rail buttons, reduced from 148px and 38px.

> Amended during Phase 5. The plan assumed 124px, but inspection measured every
> rail label in the browser: at 124px "Measure", "Markup" and "Document" all clip,
> which AC-7 forbids, and width alone cannot fix it below 142px — a 4% reduction
> not worth shipping. Trimming the rail button's padding (12px → 8px) and gap
> (8px → 6px) buys back the label column and makes 130px clean, a 12% reduction.
> FR-6 and AC-7 were mutually unsatisfiable as written; this is the resolution.

**FR-7** — The system shall preserve the existing rail collapse toggle and its 56px
collapsed width unchanged.

## 4. Acceptance criteria

**AC-1 (FR-1)** — *Given* the Highlight tool is armed and a highlight has just been
drawn, *when* the user clicks the blue preset in the markup properties bar, *then*
the just-drawn highlight keeps its original colour and the next highlight drawn is
blue.

**AC-2 (FR-1)** — *Given* the Highlight tool is armed, *when* the user changes
colour and then draws three highlights, *then* all three are the new colour.

**AC-3 (FR-2)** — *Given* no tool is armed (Select) and an existing markup is
clicked, *when* the user picks a different colour, *then* that markup changes colour.

**AC-4 (FR-3, FR-4)** — *Given* a highlight was just drawn with the Highlight tool,
*when* the user arms a Measure tool without pressing Escape, *then* the markup
properties bar is hidden and only the measure banner is visible.

**AC-5 (FR-4)** — *Given* a measurement is selected, *when* the user arms the Markup
tool, *then* the measure selection is cleared and only the markup properties bar
shows.

**AC-6 (FR-5)** — *Given* a markup has just been drawn, *when* the user presses
Escape once to leave markup mode, *then* the markup is still selected and the arrow
keys nudge it.

**AC-7 (FR-6)** — *Given* a document is open on desktop, *when* the expanded rail is
measured, *then* `--rail-w` computes to 124px and every `.rail-btn` is 34px tall,
with no label text clipped or wrapped.

**AC-8 (FR-7)** — *Given* the rail is expanded, *when* the collapse toggle is
clicked, *then* the rail narrows to 56px icon-only and the choice survives a restart.

## 5. Error handling

| Failure mode | Expected behaviour |
|---|---|
| Style change fired with no selection and no tool armed | Update defaults only; no error, no visual change to existing markups |
| `annoSelectedId` points at a markup deleted in the same gesture | `applyStyle` finds no annotation and updates defaults only; no throw |
| Tool armed while another layer's selection is mid-drag | Selection cleared on arm; the in-progress drag is cancelled, not committed |
| Rail label text longer than 124px at the user's font scale | Label truncates with ellipsis; the rail never reflows or overflows the viewer |
| Prefs write fails (quota/denied) while persisting style defaults | Silently ignored, as `applyStyle` already does today; the in-memory default still applies for the session |

## 6. Non-functional requirements

- **Cross-platform**: renderer-only. `npm run verify:web` must pass, proving the
  Android WebView gets the same behaviour. No new dependency.
- **Regression boundary** — these must still pass unchanged: `SMOKE_MKPRESET`,
  `SMOKE_MCOLOR`, `SMOKE_MARKUP`, `SMOKE_FREEHAND`, `SMOKE_TMARK`, `SMOKE_SELECT`,
  `SMOKE_MDRAG`, `SMOKE_MRESIZE`, `SMOKE_RAIL`, `SMOKE_ORGANIZE`, plus the full
  `npm test` vitest suite.
- **Coverage**: a new `SMOKE_*` scenario in `src/main.js` with a matching assertion
  in `test/e2e/run.js` covering FR-1 and FR-3, per `CLAUDE.md`.
- **Accessibility**: at 34px the rail buttons stay above the 24px WCAG 2.2 minimum
  target; the mobile bottom-bar layout below 821px is untouched, keeping 44px
  touch targets there.
- **No visual regression** to the collapsed rail, split view, or panel offsets that
  key off `--rail-w`.

## 7. Data model

No persisted-data change. `App.state.annoStyle` (already persisted to
`App.Prefs` under `annoStyle`) keeps its shape; only *when* it is written versus
when a selected annotation is mutated changes. `--rail-w` is a CSS token in
`src/renderer/styles/tokens.css`.
