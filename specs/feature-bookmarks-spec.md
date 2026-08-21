# Spec — Page bookmarks

Phase 2. Contract. EARS requirements, Given/When/Then acceptance criteria.

## Goal

On any page of a drawing set, one click marks it. The button shows at a glance
whether the page you are on is marked, a shelf lists everything marked so you
can jump straight there — and because they are **real PDF bookmarks**, they
travel with the file: a client opening it in Acrobat or Bluebeam sees them, and
a set someone sends you shows theirs.

## Decisions taken

- **Real PDF outline entries**, not app-local flags. Chosen by the repo owner
  over the older backlog decision, for the same reason every other
  cross-app choice in this project has gone that way.
- **A dropdown shelf off the button**, not backlog item 2's left-docked
  Pages+Bookmarks panel. That panel remains a separate backlog item.
- **Our entries are titled `Page N`.** Sheet numbers cannot be reliably
  extracted from a drawing; renaming is a follow-up.
- **The shelf lists the document's whole outline**, ours and any that arrived
  with the file. The tree is read anyway, and hiding a client's bookmarks would
  make the shelf lie about what the file contains.

## Requirements

### The button

**FR-1** — The system shall provide a bookmark button in the top toolbar,
immediately beside the Rotate button.

**FR-2** — When the button is pressed, the system shall bookmark the page
currently being viewed, or remove that bookmark if the page already has one.

**FR-3** — The system shall show the button in an active state while the page
being viewed is bookmarked, and in its normal state otherwise, updating as the
user moves between pages.

**FR-4** — Where no document is open, the button shall be disabled, like the
other page-scoped toolbar buttons.

### The shelf

**FR-5** — The system shall provide a shelf listing every bookmark in the open
document, each showing its title and page number.

**FR-6** — When a shelf entry is chosen, the system shall navigate to that page.

**FR-7** — Where the document has no bookmarks, the shelf shall say so rather
than appearing empty and broken.

**FR-8** — The shelf shall list bookmarks that arrived with the file alongside
ones added here, so it reflects what the document actually contains.

### Durability — the point of the feature

**FR-9** — When a document is opened, the system shall read its existing PDF
outline and present those entries as bookmarks.

**FR-10** — When a document is saved, the system shall write the bookmarks into
the PDF's own outline, so other PDF applications show them.

**FR-11** — The system shall preserve an existing outline's structure and
titles. Entries that arrived with the file shall not be renamed, reordered,
flattened or dropped by saving from here.

> A received drawing set may carry a real nested outline. Modelling bookmarks as
> a flat page list and rewriting the outline from it would destroy that silently.
> Our own entries are tagged with a private key so repeated saves neither
> duplicate them nor disturb anything else.

**FR-12** — A bookmark shall survive save and reopen in FieldMark, not only in
other viewers.

> The sidecar's pristine base is what `Tabs.open` reopens. An outline written
> only into the flattened output would be visible in Acrobat and **gone** on
> reopening here — the same failure shape as #98. The outline is written into
> the base copy as well.

**FR-13** — When a bookmark is added or removed, the system shall mark the
document as having unsaved changes.

> Unlike an app-local flag, a real bookmark does not exist until the file is
> written. Without this the existing close prompt would let it be lost silently.

**FR-14** — Bookmarks shall be per document, so switching tabs shows the
bookmarks of the document in view.

## Acceptance criteria

**AC-1 — Toggle and state.** *Given* an open document on page 3, *when* the
button is pressed, *then* page 3 is bookmarked and the button shows active;
*when* pressed again, *then* the bookmark is removed and the button returns to
normal.

**AC-2 — Follows the page.** *Given* page 3 is bookmarked and page 4 is not,
*when* the user moves from 3 to 4, *then* the button goes from active to normal,
and back on returning.

**AC-3 — Shelf navigates.** *Given* bookmarks on pages 2 and 5, *when* the shelf
entry for page 5 is chosen, *then* the viewer is on page 5.

**AC-4 — They reach other applications.** *Given* a document saved with a
bookmark on page 2, *when* the saved PDF is parsed, *then* its catalog has an
`/Outlines` tree containing an entry whose destination resolves to page 2.

**AC-5 — Received bookmarks are read.** *Given* a PDF carrying an outline made
elsewhere, *when* it is opened, *then* those entries appear in the shelf.

**AC-6 — Nothing is destroyed.** *Given* a PDF whose outline is a nested tree
with titles, *when* a bookmark is added here and the file saved, *then* every
original entry keeps its title, nesting and destination, and the new one is
added alongside.

**AC-7 — Round-trip.** *Given* a document saved with bookmarks and reopened in
FieldMark, *then* the bookmarks are still present.

**AC-8 — Dirty.** *Given* a clean document, *when* a bookmark is toggled, *then*
the document reports unsaved changes.

## Error handling

| Condition | Response |
|---|---|
| Document has no outline | Treated as no bookmarks; a new tree is created on save |
| Outline entry points nowhere resolvable | Skipped when reading; left untouched when writing |
| Outline unreadable | Open normally with an empty shelf; never block the document |
| Outline write fails on save | Warn that bookmarks were not written, as the sidecar failure does |

## Scope boundaries

**In scope:** the button, its state, the shelf, reading an existing outline,
writing on save into both the output and the sidecar base, per-tab state, dirty
marking.

**Not in scope:**
- Backlog item 2's left-docked Pages + Bookmarks panel with thumbnails.
- Renaming a bookmark, or nesting one under another.
- Reordering the outline.
- Deriving sheet numbers for titles.

## Regression boundary — verified before merge

- A PDF with no outline opens, saves and reopens exactly as it does today.
- The #98 round-trip still restores every markup and measurement type.
- The `/Outlines` write does not disturb annotations, the sidecar attachments,
  form fields, or document stamps; `verify:tools` passes unmodified.
- Rotate and the other toolbar buttons keep their behaviour and layout.
