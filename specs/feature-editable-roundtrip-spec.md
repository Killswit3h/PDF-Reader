# Spec — markups and measurements survive save/reopen

Phase 2. Contract for the defect fix. Requirements are EARS-format; acceptance
criteria are Given/When/Then. Nothing here adds a tool or changes how marks are
drawn.

## Goal

A user who marks up a drawing, saves, closes and reopens it gets their marks back
as live, movable objects — or, when that is genuinely impossible, is told plainly
and immediately, never silently handed a flattened page.

## Requirements

### Atomicity of the sidecar

**FR-1** — When `buildBytes` embeds the round-trip sidecar, the system shall
attach the model and the base **as a pair**: either both are present in the saved
file, or neither is.

**FR-2** — When the base document cannot be produced, the system shall remove the
already-attached model before saving, so no file is written carrying a model
without its base.

**FR-3** — When the sidecar cannot be embedded, the system shall warn the user
that the saved file's marks will not be editable on reopen, before the save is
reported as successful.

### Recovering an existing broken file

**FR-4** — When a file is opened that carries a model attachment but no base, the
system shall inform the user that the file contains marks that cannot be restored
over this copy, rather than opening it flat with no message.

**FR-5** — Where a model exists without a base, the system shall offer to export
that model to a JSON file, so the record of the marks is recoverable even though
the layered document is not.

*Rationale for not auto-restoring: the visible page is already flattened. Laying
the marks back on top would render every mark twice. Warning plus export is the
honest outcome.*

### Durability outside FieldMark

**FR-6** — The system shall default `saveAnnots` to **on**, so a saved file's
marks are real PDF annotations that stay live in Bluebeam and Acrobat, not only
inside FieldMark.

**FR-7** — Where `saveAnnots` is off, the system shall make clear at save time
that marks will be flattened for other applications.

> **Decided.** FR-6 is confirmed: `saveAnnots` defaults to on. The trade-off —
> that a recipient can move or delete the marks in their copy — is accepted,
> because the sender keeps the original. Durability of the marks in other
> software outweighs immutability of the copy that was sent.

### Signing

**FR-8** — When the user signs a document, the system shall warn — before
signing — that the signed copy's marks will not be reopenable as editable, since
signing deliberately drops the sidecar.

## Acceptance criteria

**AC-1 — a normal round-trip still works**
Given a drawing with markups and measurements
When the user saves, closes and reopens it in FieldMark
Then every mark is present, selectable and movable, and the page is not
double-drawn.

**AC-2 — a failed base never produces a half file**
Given the base document cannot be built (e.g. `pdfBytes` is unavailable)
When the user saves
Then the written file contains **neither** sidecar attachment, and the user is
warned the marks will not be editable on reopen.

**AC-3 — a half sidecar is reported, not swallowed**
Given a file carrying a model attachment but no base
When the user opens it
Then a clear message states the marks cannot be restored over this copy, and the
document opens flat without double-drawing.

**AC-4 — the marks are still recoverable**
Given the situation in AC-3
When the user accepts the offered export
Then a JSON file is written containing every placement, measurement and
annotation from the model.

**AC-5 — marks stay live in other software**
Given the default settings
When the user saves a drawing and opens it in Bluebeam or Acrobat
Then markups appear as selectable annotations and measurements report their
calibrated values.

**AC-6 — signing warns first**
Given a document with marks
When the user applies a digital signature
Then they are told beforehand that the signed copy's marks will not be editable
on reopen, and can cancel.

**AC-7 — files with no sidecar are unaffected**
Given a PDF that never passed through FieldMark
When the user opens it
Then behaviour is exactly as it is today, with no new messages.

## Error handling

| Condition | Behaviour |
|---|---|
| Base cannot be built | Save proceeds with no sidecar at all; user warned marks won't be editable |
| Model attach succeeds, base attach fails | Model removed before save; treated as above |
| Model present, base absent on open | Open flat, explain, offer JSON export |
| Model present but unparseable | Existing behaviour: warn and open flat |
| Neither attachment present | Silent normal open |
| Sidecar dropped by another tool | Indistinguishable from "no sidecar"; real annotations (FR-6) carry the marks |

## Scope boundaries

**In scope:** sidecar atomicity, the silent-loss path, the `saveAnnots` default,
a signing warning, tests for all of it.

**Explicitly out of scope** — the five requests filed alongside this, each to be
specced separately: radius measurement (3-Point and Center Radius, per Bluebeam),
persisting page orientation by baking `/Rotate`, real PDF bookmarks with a side
panel, independent per-pane rotation in compare, and zoom-anchor accuracy.

**Not changing:** how marks are drawn or exported, the annotation subtypes, the
`/Measure` dictionaries, or the deliberate `sidecar.base` guard in `viewer.js`.

## Verification

- New unit tests over the pure parts of the model serialization.
- A new `SMOKE_*` scenario plus `test/e2e/run.js` assertion, per repo convention,
  covering AC-1, AC-2 and AC-3 — the last by constructing a half-sidecar file
  deliberately, which nothing does today.
- `npm run verify`, `npm run verify:web`, `npm run verify:tools` all green.
