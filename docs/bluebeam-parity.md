# FieldMark vs Bluebeam Revu 21 — parity matrix

Branch `feat/bluebeam-parity`, 2026-10-16. Companion to
`docs/bluebeam-revu21-inventory.md` (what Revu does, from its public docs) and
`docs/tool-parity.md` (does our output survive being opened in Revu).

**How this was done.** Revu's features were catalogued from Bluebeam's public
help, pricing page and release notes. The binary was not decompiled: Revu's
license forbids it, and it is not needed to match behaviour. Every feature
below is FieldMark's own code, written to the PDF standard (ISO 32000) so marks
made here open as live objects in Revu and Acrobat.

Legend: **NEW** = built on this branch · **HAD** = already in FieldMark ·
**PART** = partly there · **NEXT** = backlog, ranked below · **NO** = out of
scope, with the reason.

## Built on this branch

| Revu feature | FieldMark | How it saves | Where |
|---|---|---|---|
| Stamp tool (S) + stamp library | 14 review stamps (Approved, Approved as Noted, Revise & Resubmit, Rejected, Reviewed, For Review, As-Built, Completed, Void, Draft, Preliminary, Not for Construction, Confidential, Received) with date line, plus custom-text stamps; one click places, resize scales the lettering | `/Stamp` with Acrobat stamp `/Name` and a generated `/AP` (frame + text) | `src/shared/markup-tools.js`, `js/stamps.js`, `markup.js` `drawStamp`, `save.js` `stampAppearance` |
| Note (N) | Sticky note icon with a comment; double-click edits | `/Text` `/Name /Comment` | `markup.js` `drawNote` / `editComment` |
| Squiggly (Shift+U) | Wavy underline on selected text | `/Squiggly` + `/QuadPoints` + `/AP` | `markup.js` `squigglePoints`, `save.js` `squiggleWave` |
| Hyperlink (Shift+H) | Drag a box, link it to a page or an http(s)/mailto address; double-click follows | `/Link` with `/Dest [page /Fit]` or a `/URI` action; always live, even when flattening | `markup.js` `editLink` / `followLink`, `save.js` |
| Eraser (E; Revu Shift+E) | Click or drag over markups to erase them; locked ones stay | — | `markup.js` `eraseAt`, `App.topMarkupAt` |
| Mark for Redaction (Shift+R) + Apply Redactions | Draw redaction boxes; Document ▸ Apply Redactions rasterizes only the affected pages with the areas burned black, building a fresh PDF so no removed object survives in the file. Unapplied marks export as `/Redact`, never as a fake black box | `/Redact` (pending) / image page (applied) | `js/redact.js` |
| Set Status | None / For Review / Accepted / Rejected / Completed / Cancelled per markup | Hidden review-state reply (`/IRT`, `/StateModel Review`, `/State`), the way Acrobat and Revu store status | `src/shared/markup-meta.js`, `save.js` `writeStatusReply` |
| Subject, Comments | Editable per markup in the Markups List | `/Subj`, `/Contents` | `markup.js` `syncMetaProps` |
| Lock / Unlock | Locked markups cannot move, resize, nudge, delete, erase or be cleared | `/F` Locked flag (128) | `markup.js` guards |
| Line style | Solid / Dashed / Dotted / Dash-dot on every shape | `/BS /S /D /D [...]`; dashed when flattened | `App.dashArray`, props bar `#mk-dash` |
| Markups List columns, filter, sort | Status filter, sort by page / type / subject / status / date / comment, status and lock chips | — | `markup.js` `Panel.visible` |
| Markup Summary (PDF) | Landscape report of the listed markups: #, page, type, subject, status, comment, created, with status totals | New PDF via `savePdfDialog` | `Panel.buildSummaryBytes` |
| Markup Summary (CSV) | CSV now carries Subject, Status, Comment, Locked, Created | — | `App.markupRows` |
| Volume (area × depth) | Depth on an Area gives ft³ and cubic yards (concrete) | Label, panel totals, CSV | `App.depthResult`, `measure.js` `labelFor` |
| Depth → Wall Area | Height on a Length / Perimeter / Continuous / Arc gives surface area (fence fabric = run × height) | Same | same |
| Snapshot (G) | Drag a box: copied to the clipboard as PNG and armed to paste on any page | Pasted as an image placement | `js/snapshot.js` |
| Show Grid / Snap to Grid | 1/8, 1/4, 1/2, 1 in grid over the sheet; markup clicks snap to it | — | `js/grid.js` |
| Import from Revu/Acrobat | Sticky notes and squiggly marks made elsewhere now come in as editable FieldMark marks | — | `src/shared/annot-import.js` |
| Revu keys | N note, S stamp, E eraser, G snapshot, U underline, D strikeout, Shift+U squiggly, Shift+H hyperlink, Shift+R redaction | — | `app.js` `MARKUP_KEYS` |

Security fix alongside: the desktop `app:openExternal` bridge now passes only
http(s) and mailto URLs to the OS (`src/main.js`). Before, any scheme went
through; with hyperlinks coming out of PDFs that would have let a `file:` or
custom-protocol link launch programs.

Screenshots: [page + Markups List](screenshots/bluebeam-parity/1-page-and-panel.png) ·
[Markup menu](screenshots/bluebeam-parity/2-markup-menu.png) ·
[stamp picker](screenshots/bluebeam-parity/3-stamp-picker.png) ·
[the saved PDF as pdf.js renders it](screenshots/bluebeam-parity/4-exported.png) ·
[Markup Summary PDF](screenshots/bluebeam-parity/5-summary.png).

## Already in FieldMark before this branch

Open / save / save as / print with paper sizes / recent files / tabs and
tear-off windows · fit width, marquee zoom, pinch zoom, pan, rotate view,
side-by-side split, dark mode, find · Line, Arrow, Rectangle, Ellipse,
Polyline, Polygon, Cloud, Pen, Highlighter, Text (typewriter style), Callout,
text Highlight / Underline / Strikeout · copy / paste / duplicate / nudge /
undo history · Markups List with CSV · Tool Chest with markup presets and image
stamps · favourite colours · calibrate / set scale with presets and detected
scales · Length, Continuous (polylength), Perimeter, Area, Arc Length, 3-Point
and Center Radius, Angle, Count with named tallies across pages, Viewports
(per-region scale), snap to drawing content, feet-inches, per-segment lengths,
Measurements panel and CSV · live `/Measure` export Revu reads ·
signatures, initials, date, digital (PKI) signature · organize pages (reorder,
rotate, delete, insert blank, merge, extract) · Bates / page numbers, header,
footer, watermark · Compare Documents, Overlay · OCR · form filling and flatten
· page bookmarks written to `/Outlines` · import other apps' markups as
editable.

## Backlog, ranked for GFC (fence / guardrail takeoffs and field review)

| # | Revu feature | Why it matters to GFC | Tier | Size |
|---|---|---|---|---|
| 1 | **Polygon / ellipse cutout** on Area and Volume | Takeoffs around islands and existing structures | A | M |
| 2 | **Multi-select, lasso, align / distribute, group, z-order, flip** | Moving a whole callout set; neat redline sheets | A | L (selection model is single-id today) |
| 3 | **Legend** built from markups / a Tool Chest set, live counts | Takeoff sheets for GCs | A | M |
| 4 | **Page labels + AutoMark** (sheet number / title from a region) and **Batch Link** (auto-link sheet references) | Plan sets with 100+ sheets | A | L |
| 5 | **Slope / Rise-Drop** on length and area | Guardrail on grade | A | S |
| 6 | **Sketch to Scale** (draw a shape at an exact length) | Layout of fence runs | A | M |
| 7 | **Dimension markup** (Shift+L) and **Cloud+** (cloud with callout) | Redline conventions | A | S |
| 8 | **Arrowhead choices** (start / end / both, styles) | Redline conventions | A | S |
| 9 | **Replies** (threaded comments) | Back-and-forth with CEI/GC inside the PDF | A | M |
| 10 | **Custom statuses and custom columns** (unit price, formula) | Estimating straight from the takeoff | A | M |
| 11 | **Visual Search** (find repeated symbols, apply count) | Counting posts / terminals on plans | A | L (template matching on the canvas) |
| 12 | **Dynamic Fill** (flood-fill an area) | Fast area takeoff | A | L |
| 13 | **Crop pages, split document, replace pages, page labels** | Document prep | A | M |
| 14 | **Layers (OCG)** show / hide | Busy civil sets | A | M |
| 15 | **Image markup from file / camera, photo Capture on a markup** | Field photos on punch items | B/C | M |
| 16 | **File attachments panel** | Submittal packages | B | M |
| 17 | **Sets** (several PDFs as one binder) and **Slip Sheet** | Plan revisions | B | L |
| 18 | **Profiles** (saved layouts), rulers, crosshair, dimmer, Fit Page, two-up view | Comfort | A | S each |
| 19 | **Security** (set passwords / permissions) | Sending locked PDFs | B | M |
| 20 | **Quantity export to Excel** (live link is Windows-COM only; a structured XLSX export is feasible) | Takeoff to estimate | A | M |

## Out of scope (and why)

| Revu feature | Reason |
|---|---|
| Studio Sessions / Projects, cloud sync, DMS integrations | FieldMark is offline by contract: no server, no network at runtime |
| Smart Review, Smart Overlay, Magic Markups, Revu MCP (Max tier AI) | Cloud AI services; would break the offline rule |
| Edit PDF content text with reflow, Export to Word/Excel/PowerPoint | Needs a commercial PDF engine (font subsetting, reflow) |
| Create PDF from CAD (AutoCAD / Revit plugins), 3D PDF, scripting / JavaScript console | Separate products / plugins outside a PDF viewer |
| Quantity Link (live Excel cell link) | Windows COM add-in; not portable to macOS / Android |
| Task Link (GoCanvas forms) | Third-party service |

## Verification on this branch

- `npm test`: 617 unit tests, including 27 new ones in `test/unit/bluebeam-parity.test.js` and 3 new import tests.
- `npm run verify:tools`: 20 tools export as the annotation they claim. New checks cover the status reply, `/Subj`, the lock flag, the dash pattern, link `/Dest`, and the stamp and squiggly appearance streams, which must change real pixels.
- `npm run test:e2e`: new `SMOKE_BLUEBEAM` scenario drives every new tool through the real Electron renderer, including a redaction that takes page 1 from 3 text items to 0.
- `npm run verify:web`: the same renderer in Chromium (Android WebView parity).
