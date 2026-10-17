# Spec — Bluebeam parity, wave 1 (review tools)

Phases 1–3 in one document. Pedro Garcia-Romo (GFC) asked on 2026-10-16 for
Bluebeam to be "reverse engineered" and every feature added to FieldMark. He was
away and the card ran on full auto, so the two user checkpoints (spec approval,
plan approval) were taken as approved by the card itself. That is recorded here
as an assumption for the maintainer to confirm at PR review.

## Research (Phase 1)

- What Revu does: `docs/bluebeam-revu21-inventory.md`, compiled from public
  docs only. Decompiling Revu was ruled out because its license forbids it.
- What FieldMark already does, with the gap list:
  `docs/bluebeam-parity.md` (sections "Already in FieldMark" and "Backlog").
- "Every feature" includes cloud collaboration (Studio), Max-tier AI and CAD
  plugins. Those break the offline rule in `CLAUDE.md` and are listed as out of
  scope with reasons. The remaining gaps are too many for one PR, so wave 1 takes
  the review and punch-list tools a field contractor uses daily. Everything else
  is ranked in the backlog.

## Requirements (Phase 2)

**FR-BB-1** Stamp library: 14 standard review stamps plus custom text and colour,
optional date line. One click places a stamp. Exported as `/Stamp` with an `/AP`.

**FR-BB-2** Note tool: a sticky note with a comment, exported as a `/Text`
annotation. Cancelling the first comment removes the note.

**FR-BB-3** Squiggly text markup, exported as `/Squiggly` with an `/AP`.

**FR-BB-4** Hyperlink tool: a rectangle linked to a page in this document or an
http(s)/mailto URL. Double-click follows it. Exported as `/Link` in both editable
and flattened saves. Every other scheme is refused, in the renderer and in the
desktop main process.

**FR-BB-5** Eraser: click or drag removes the topmost markup under the pointer,
one undo step per gesture, and skips locked markups.

**FR-BB-6** Redaction: a Mark for Redaction tool, then Document ▸ Apply
Redactions. Applying rasterizes the affected pages with the boxes burned black,
copies every other page into a new document, and keeps every other mark. It
asks for confirmation and names the trade-offs. Unapplied marks export as
`/Redact` and are never drawn as a black box in a flattened save.

**FR-BB-7** Review fields on every markup: subject, status (None, For Review,
Accepted, Rejected, Completed, Cancelled), comment, locked flag, creation time.
Status exports as a hidden `/IRT` review-state reply. Subject exports as `/Subj`,
the lock as the `/F` Locked flag, and the comment as `/Contents`.

**FR-BB-8** Lock: a locked markup cannot be moved, resized, nudged, deleted,
erased, cleared or edited until it is unlocked.

**FR-BB-9** Line style (solid / dashed / dotted / dash-dot) on shapes, shown on
screen, exported in `/BS`, and drawn dashed when flattened.

**FR-BB-10** Markups List: status filter and sort (page, type, subject, status,
date, comment). The CSV and the PDF Markup Summary export exactly the rows shown.

**FR-BB-11** Depth on measurements. Area × depth gives volume (plus cubic yards
when the unit is feet). Length, perimeter, continuous or arc × height gives wall
area. Both show in the label, the panel totals and the CSV.

**FR-BB-12** Snapshot: drag a box over a page. The image is copied to the
clipboard (best effort) and armed as an image placement.

**FR-BB-13** Grid: show the grid and snap markup clicks to it, with spacing of
1/8, 1/4, 1/2 or 1 in, remembered between sessions.

**FR-BB-14** Import: notes (`/Text`, not replies) and `/Squiggly` from other apps
become editable FieldMark marks.

**FR-BB-15** Keys: N, S, E, G, U, D, Shift+U, Shift+H, Shift+R, all listed in the
shortcuts sheet.

### Acceptance criteria

- Given a stamp, note, link, squiggly, redaction, locked dashed rectangle and an
  accepted status, when the document is saved with editable annotations, then a
  re-parse finds `Stamp`, `Text`, `Link`, `Squiggly`, `Redact`, the `/IRT` state
  reply, `/Subj`, `/F & 128`, and `/BS /D`. The stamp and squiggly appearance
  streams change pixels when rendered (`verify:tools`).
- Given page 1 with a redaction box over the whole page, when Apply Redactions
  runs, then page 1 yields 0 text items and every other mark is kept
  (`SMOKE_BLUEBEAM`).
- Given an area of 400 ft² with depth 0.5 ft, the label reads
  `400.00 ft² · V 200.00 ft³ (7.41 yd³)`.

## Plan (Phase 3)

Stack unchanged: vanilla JS on `App`, no new dependencies, renderer-only. That
means all three platforms get it with no `window.api` additions.

| Piece | Files |
|---|---|
| Pure logic + unit tests | `src/shared/markup-meta.js`, `src/shared/markup-tools.js`, `src/shared/measure-math.js` (depth), `test/unit/bluebeam-parity.test.js` |
| Markup engine | `src/renderer/js/markup.js` (types, eraser, lock, links, panel, summary) |
| New modules | `js/stamps.js`, `js/grid.js`, `js/snapshot.js`, `js/redact.js` |
| Export | `src/renderer/js/save.js` |
| Wiring, keys, menus | `src/renderer/js/app.js`, `index.html`, `styles.css`, `util.js` (`App.promptText`), `history.js` (`discardLast`) |
| Security | `src/main.js` openExternal allow-list |
| Gates | `scripts/verify-tools.js` matrix, `SMOKE_BLUEBEAM` in `src/main.js` + `test/e2e/run.js` |
