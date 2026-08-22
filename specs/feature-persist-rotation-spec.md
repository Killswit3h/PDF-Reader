# Spec — Save the orientation you saved it in

Phase 2. Contract. Backlog item "Persist page orientation by baking `/Rotate`",
reported again from use: rotate a sheet, save, close, reopen — it comes back in
the original orientation.

## What is actually wrong

Rotation is a **pure view setting** and is stored nowhere.

`Viewer.rotate()` sets `pdfViewer.pagesRotation`, PDF.js's display-only
rotation. It is absent from `App.state`, from the per-tab session state, and
from the round-trip model, and `save.js` never writes `/Rotate`. So the
orientation is not "lost on save" — it was never anywhere to lose.

A second symptom falls out of the same cause and is worth fixing here:
**switching tabs also discards it**, because `activate()` restores only the
zoom and the page.

## Decision taken

The backlog recorded `/Rotate` baked into the page — so a corrected sheet opens
the same way in every application — but hedged that it "wants a clear, undoable
user action rather than silently persisting whatever the Rotate button was last
set to".

The repo owner has now settled that: **the orientation you save in is the
orientation the file has.** Saving is the deliberate action.

> **Accepted consequence.** Rotating the view only to read something sideways
> and then saving for an unrelated reason will rotate the document for everyone.
> It is undone the same way it was done — rotate back, save again — and the
> alternative (a separate "apply rotation" command) was rejected as making the
> common case harder to serve the rare one.

## Requirements

**FR-1** — The system shall keep the view rotation as part of the document's
state, so it survives switching tabs.

**FR-2** — When a document is saved, the system shall write the orientation
being viewed into each page's `/Rotate`.

**FR-3** — The system shall **add** the view rotation to a page's existing
`/Rotate` rather than replacing it, so a document whose pages already differ in
orientation keeps those differences.

**FR-4** — The system shall write the orientation into the round-trip sidecar's
base copy as well as the saved output.

> `Tabs.open` reopens that base. Baking only the output would show the right
> orientation in Acrobat and the original one on reopening here — the #98
> failure shape, for the third time.

**FR-5** — After a save, the system shall reset the view rotation to zero.

> The rotation is now in the file. Leaving the view rotated as well would show
> the document turned twice as far as it is.

**FR-6** — Markups, measurements and placements shall remain correctly
positioned and oriented on a document saved rotated.

**FR-7** — Where the view is not rotated, saving shall leave every page's
`/Rotate` exactly as it was.

**FR-8** — Rotating back and saving again shall return the document to its
original orientation, so the change is reversible by the same action that made
it.

## Acceptance criteria

**AC-1 — It is written.** *Given* a document whose page 1 has `/Rotate 0`,
*when* the view is rotated 90° and the file saved, *then* page 1 of the saved
PDF has `/Rotate 90`.

**AC-2 — Added, not replaced.** *Given* a page that already has `/Rotate 90`,
*when* the view is rotated 90° and saved, *then* that page has `/Rotate 180`,
and a page in the same document that had `/Rotate 0` has `/Rotate 90`.

**AC-3 — It comes back.** *Given* a document saved rotated 90°, *when* it is
reopened in FieldMark, *then* it displays in that orientation and the view
rotation reads 0 — not rotated twice.

**AC-4 — Marks survive it.** *Given* a rotated document with a measurement,
*when* it is saved and reopened, *then* the measurement is on the same part of
the drawing and reports the same value.

**AC-5 — Reversible.** *Given* a document saved rotated 90°, *when* it is
rotated 270° and saved again, *then* its pages are back to their original
`/Rotate`.

**AC-6 — No rotation, no change.** *Given* an unrotated view, *when* the file is
saved, *then* no page's `/Rotate` differs from the original.

**AC-7 — Tabs.** *Given* two open documents, one rotated, *when* the user
switches away and back, *then* the rotation is still applied.

## Error handling

| Condition | Response |
|---|---|
| Page has a non-multiple-of-90 `/Rotate` | Normalise to the nearest valid quarter turn, as PDF readers do |
| Page has no `/Rotate` | Treated as 0 |
| `/Rotate` cannot be written | Warn that the orientation was not saved; do not fail the save |

## Scope boundaries

**In scope:** persisting the uniform view rotation into `/Rotate` on save, into
both the output and the sidecar base, per-tab rotation state, and the view reset
after saving.

**Not in scope:**
- Rotating a **single page** independently. The viewer's rotation is uniform
  across the document today; per-page rotation is a separate feature.
- A separate "apply rotation permanently" command, explicitly rejected above.
- Rotation of a compare pane (its own backlog item).

## Regression boundary — verified before merge

- `textrot` — a flattened text box and a measurement label still save upright on
  a page that already carries `/Rotate`. This is the scenario most exposed by
  the change and must pass **unmodified**.
- `rotate` — the existing scenario for the button turning the view and overlays
  following it.
- The #98 round-trip still restores every mark type; `verify:tools` passes.
- An unrotated save is byte-comparable in `/Rotate` terms to today's output.
