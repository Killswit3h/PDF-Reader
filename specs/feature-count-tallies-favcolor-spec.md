# Spec — Count tallies across pages, individual count marks, colour-first favourites

**Phase 2 (spec-designer) · slug `count-tallies-favcolor` · type: feature + UX correction**

## Source

Three field notes, written against the shipped app:

1. "Add to the Count feature the ability to count across multiple pages."
2. "Count Feature: Be able to copy a number, so treat each (count) object as
   individual, not as a unit."
3. "Favorite colour option feature: I did not want the option to add a favourite
   colour by hex code — that shouldn't be the main way. It should be a colour
   way, with the option of hex code."

They arrived as a finished, concrete change list, so the research and spec
phases collapsed into this one document; the two pipeline approval checkpoints
were not run as separate rounds. Notes 1 and 2 are one feature — both fall out
of the same change to how a count is stored — and are specified together.

## Problem

**Count.** A count was one measurement object holding every dot of a tally in
its `pts` array, locked to the page the first dot landed on
(`measure.js: "lock to first page"`). Two consequences, both wrong for a
take-off:

- The same item counted across a six-sheet plan set produced six unrelated
  counts that had to be added up by hand.
- The dots were a unit. Selecting, dragging, deleting or copying reached the
  whole pile. There was no way to say "one more of these" — the copy/paste and
  Ctrl+D machinery that works for every other object cloned the entire tally.

**Favourite colours.** The dialog led with a "Paste a legend" textarea, and
naming a colour meant knowing its hex code. Pasting a legend is the *bulk* path
for someone who has a legend table in hand; it was standing in for the ordinary
one — pick a colour, name it, save it.

## Functional requirements

**FR-C1 — A tally spans pages.**
Marks made while the Count tool is armed join one *tally* regardless of which
page they are clicked on. The tally's total is the number of marks in it across
the whole document. Arming Count from the Measure menu starts a **new** tally;
carrying on with an existing one is the explicit `+` on its row in the
Measurements panel.

**FR-C2 — Every mark is its own object.**
One click makes one measurement carrying one point. It can be selected, nudged,
dragged, deleted, and copied (Ctrl+C/Ctrl+V, Ctrl+D) on its own through the
existing object machinery. A copied mark stays in its tally, so the total goes
up by exactly one.

**FR-C3 — Numbering follows the tally.**
Marks are numbered in the order they were made, continuing across pages
(1, 2, 3… not 1, 1, 1 per sheet). Deleting a mark renumbers the rest; there is
no stored number to go stale.

**FR-C4 — One running total per sheet.**
Each page shows the tally's label once, at its first mark on that page.
A single-page tally reads `Name: N`. A tally that spans pages reads
`Name: <this page> of <total>` — a sheet holding 4 of 38 must not print "38".

**FR-C5 — Tallies are named.**
A tally opens as `Count 1`, `Count 2`, … (first unused). The name is editable in
place on its Measurements-panel row and appears in the on-page label, the CSV
and the exported PDF.

**FR-C6 — The panel lists tallies, not dots.**
One row per tally: colour, `count`, editable name, total, the pages it spans,
`+` (keep counting into it) and delete (the whole tally). A 40-dot count must
not push every other measurement out of the panel. The `count:` figure in the
panel totals stays the number of marks. CSV export writes one row per tally
(`count, "1 3 4", total, ct, name`), not one per dot.

**FR-C7 — Restyling a tally restyles all of it.**
Changing the selected mark's colour applies to every mark of its tally — a
half-recoloured count reads as two counts.

**FR-C8 — The exported PDF is unchanged in shape.**
On export, a tally is folded back into one count shape per page carrying its
dots and its running total, so a recipient opens the same single count
annotation per sheet they got before this change. Individual marks are an
in-app editing model, not a change to the file format.

**FR-C9 — Old files still open, upgraded.**
A document saved with the previous lump-count shape loads with its dots split
into individual marks sharing one tally, on the sidecar-reopen path and the
tab tear-off path alike. Nothing is lost and nothing moves.

**FR-F1 — Favourites open on a colour, not a code.**
The Favorites dialog leads with a swatch palette (18 colours) and a colour
wheel, plus a name field and an **Add color** button. Picking a swatch, naming
it and adding it is the primary path and requires no hex code.

**FR-F2 — Hex entry is available, not required.**
A "Have the hex code? Type it" disclosure holds a single-code field that sets
the pending colour. The legend-paste bulk path keeps its existing behaviour
(unchanged parsing) behind its own "Paste a whole legend at once" disclosure.
Both are closed by default.

**FR-F3 — The dialog opens on the colour you were using.**
Opening Favorites… from the markup bar or the Measure menu pre-loads that
toolbar's current colour, so "save this one, named" is two fields, not a hunt
for the code.

**FR-F4 — Existing behaviour preserved.**
The ★ toggle on each toolbar, the shared swatch strips, rename/reorder/recolor
in the saved list, the 32-colour cap, and Prefs persistence are unchanged.

## Acceptance criteria

- **Given** the Count tool is armed, **when** marks are clicked on page 1 and
  page 3, **then** they form one tally totalling 3 spanning pages [1, 3], and
  page 1's label reads `Count 1: 2 of 3`. (FR-C1, FR-C4)
- **Given** one count mark is selected, **when** it is copied and pasted,
  **then** the tally total rises by exactly 1. (FR-C2)
- **Given** a 3-mark tally, **when** one mark is deleted, **then** 2 remain and
  they are numbered 1 and 2. (FR-C2, FR-C3)
- **Given** Count is armed a second time, **when** a mark is made, **then** it
  belongs to a second tally with its own total. (FR-C1)
- **Given** two tallies and four marks, **when** the Measurements panel is open,
  **then** it shows 2 rows and a `count: 4` total. (FR-C6)
- **Given** a tally renamed from the panel, **when** the document is exported,
  **then** each page carries one count shape labelled with the new name and that
  page's share of the total. (FR-C5, FR-C8)
- **Given** a measurement list in the old lump-count shape, **when** it is
  loaded, **then** it becomes one mark per dot in a single tally, in place.
  (FR-C9)
- **Given** the Favorites dialog, **when** it opens, **then** a palette of ≥12
  swatches is visible and both the hex field and the legend paste box are inside
  closed disclosures. (FR-F1, FR-F2)
- **Given** a palette swatch is clicked and named, **when** *Add color* is
  pressed, **then** that exact colour is saved with that name and appears on the
  markup bar and Measure-menu strips. (FR-F1)

## Out of scope

- Count symbols other than the numbered dot (triangles, squares, custom stamps).
- Counting by legend item automatically, or reading counts back in from a PDF
  produced elsewhere.
- Any change to the legend-paste parser.

## Verification

- `test/unit/count-groups.test.js` — the tally model (grouping, numbering,
  per-page labels, legacy split, export merge).
- `SMOKE_COUNT` (`src/main.js`) + "count — one tally across pages, every mark
  its own object" (`test/e2e/run.js`) — the whole feature on real Electron.
- `SMOKE_FAVPICK` + "favorites — save a color by picking one, with hex as the
  fallback" — the colour-first path, including that hex and paste are demoted.
- `npm run verify:web` — the same renderer code driven in headless Chromium,
  which is what the Android WebView runs.
