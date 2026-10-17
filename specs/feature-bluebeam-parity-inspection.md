# Inspection — Bluebeam parity wave 1

Branch `feat/bluebeam-parity` off `origin/main` 2465ce9. Spec:
`specs/feature-bluebeam-parity-spec.md`.

## Gates (run on macOS, 2026-10-16)

| Gate | Result |
|---|---|
| `npm test` | 617 passed (26 files), 30 new tests |
| `npm run test:e2e` | 75 passed, 0 failed (new `bluebeam` scenario) |
| `npm run verify:web` | PASS (run with `CHROMIUM_PATH` pointing at Google Chrome; the Playwright browser is not installed on this Mac) |
| `npm run verify:tools` | PASS, 20 tools, plus new review-field checks |

## Requirements

| FR | Status | Evidence |
|---|---|---|
| BB-1 stamps | Done | verify:tools `Stamp` + `/AP` renders 8,967 px; e2e stamp placed |
| BB-2 note | Done | verify:tools `Text`; e2e comment saved via prompt |
| BB-3 squiggly | Done | verify:tools `Squiggly` renders 1,135 px |
| BB-4 hyperlink | Done | verify:tools `/Dest`; e2e page target, `javascript:` refused; main.js allow-list |
| BB-5 eraser | Done | e2e: line erased, locked stamp kept |
| BB-6 redaction | Done | e2e: page 1 text 3 → 0 items, other marks kept, mark consumed |
| BB-7 review fields | Done | verify:tools `/IRT /State Accepted` hidden reply, `/Subj` |
| BB-8 lock | Done | e2e delete refused; verify:tools `/F & 128` |
| BB-9 line style | Done | verify:tools `/BS /D`; flatten passes dash arrays |
| BB-10 list filter/sort/summary | Done | unit tests; e2e status filter + summary PDF; screenshot 5 |
| BB-11 depth | Done | unit tests; e2e label `400.00 ft² · V 200.00 ft³ (7.41 yd³)` |
| BB-12 snapshot | Done | e2e capture + paste armed |
| BB-13 grid | Done | e2e grid shown, clicks snapped to 18 pt |
| BB-14 import | Done | unit tests for Text and Squiggly |
| BB-15 keys | Done | shortcuts sheet updated |

## Visual check

Screenshots in `docs/screenshots/bluebeam-parity/`. Two defects were found this
way and fixed before commit:

- The panel title's shared `flex: 0 0 100%` took the full height of the new
  column-flex properties box and pushed its fields over the list.
- The stamp label was sized from an average glyph width and could crowd the
  frame. It is now measured with canvas `measureText`, and that measurement
  drives both the screen and the PDF appearance.

## Known limits (documented, not defects)

- pdf.js draws no icon for `/Text` notes and ignores `/BS` dash on shapes that
  have no `/AP`. Acrobat and Revu draw both.
- Snapshot captures the page image, not FieldMark markups.
- Redaction removes the original file's own outline and form-field tree. The
  confirm dialog says so.
- Volume and wall area are not written into `/Measure`. Revu stores depth in
  private keys.

## Independent review (findings at 80%+ confidence, all fixed)

1. **Redaction leak through references.** A link, GoTo action, field /P, /IRT or
   /Popup on a kept page that pointed at a redacted page made pdf-lib copy the
   original page, content stream included. Fixed in three layers. Each redacted
   page is gutted and replaced by its image in place. Destinations are swapped
   to page numbers around the copy, then swapped back, so pdf-lib's unregistered
   page clones cannot fork an orphan copy. Annotation /P back-pointers into the
   pages are dropped. FieldMark marks that sit wholly under a redaction box are
   removed too, as Revu does. e2e now injects a page-2 link into the redacted
   page 1 and asserts four things: one page object per page, no content stream
   containing the page text, the link still lands on page 1, and the covered
   text box is gone.
2. **Flattened stamp could abort the save** when a page's /XObject was indirect
   or /Resources was missing. Now uses `page.node.newXObject`.
3. **One eraser click erased two stacked markups** (pointerdown, then the click).
   The click path now ignores the eraser. Covered by e2e with real pointer and
   click events.
4. **Lock bypasses.** Double-click text edit, note comment, link edit, and the
   style bar all respected no lock. They are all guarded now. e2e covers the
   style bar.
5. **Panel comment could land on another markup** when the selection changed
   mid-edit. Edits now go to the markup they started on, and selecting another
   markup blurs the field first.

Gates after the fixes: 617 unit, 75/75 e2e, verify:web PASS, verify:tools PASS.

## Not done here (needs the maintainer)

The branch is committed locally only. Pushing it and opening the draft PR is
held for Pedro's OK, per the GFC rules for this machine.
