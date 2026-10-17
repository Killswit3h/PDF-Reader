# Bluebeam Revu 21 — public feature inventory (clean-room)

Compiled 2026-10-16 for the FieldMark Bluebeam-parity work (`docs/bluebeam-parity.md`).

**Method.** Everything here comes from Bluebeam's public help pages, its pricing
page, the Revu 21 release notes (through 21.11, 1 Sep 2026) and a few reputable
third-party pages. Nothing was downloaded, installed or decompiled. Revu is a
licensed commercial product whose terms forbid reverse engineering the binary,
so "reverse engineer Bluebeam" was done as a feature study from its public
documentation, and FieldMark's versions are written from scratch.

**Tier:** B = Basics and up, C = Core and up, Cp = Complete and up, M = Max only,
n/s = not stated. **Key** = default Windows shortcut.

## 1. Revu menu

| Feature | What it does | Key |
|---|---|---|
| Preferences | Settings dialog with search (21.1) | Ctrl+K |
| Profiles | Save / switch / import / export workspace layouts (.bpx) | — |
| Keyboard Shortcuts | Remap, export / import as XML | — |
| Administrator | Plugins, integrations | — |

## 2. File

| Feature | What it does | Key |
|---|---|---|
| New PDF / from template | Blank PDF, template PDFs | Ctrl+N |
| Open / Open Recent | Opens PDFs, converts images, builds 3D PDFs | Ctrl+O |
| Create from file(s), scanner/camera, layered PDF, PDF package | Conversions | — |
| Combine | Merge PDFs | — |
| Close / Close All | Tabs | Ctrl+F4 / Ctrl+Shift+W |
| Save / Save As / Save All | Save | Ctrl+S / Ctrl+Shift+S / Ctrl+F2 |
| Revert As | Roll back to an earlier revision | — |
| Publish As Flattened / Compressed / Uncompressed | Burn in markups, strip history | Ctrl+Alt+F / Ctrl+Shift+P |
| Email, email templates | Attach to mail | Ctrl+E |
| Export: PDF/A, images, text/RTF/HTML, Word/Excel/PowerPoint | Export formats | — |
| Print | Print | Ctrl+P |

## 3. Edit

| Feature | What it does | Key |
|---|---|---|
| Undo / Redo / Undo History | History | Ctrl+Z / Ctrl+Y |
| Cut / Copy / Paste / Paste in Place | Clipboard, in-place paste across pages | Ctrl+X/C/V, Ctrl+Shift+V |
| Offset, Multiply (21.0.50) | Offset copy, array copies | O |
| Hide (21.2) | Hide individual markups | — |
| Select / Select All / Lasso / Pan | Selection | V / Ctrl+A / Shift+O / Shift+V |
| Snapshot / Copy Page to Snapshot | Region or page to clipboard, paste as image | G / Ctrl+Alt+C |
| Format Painter | Copy appearance between markups | Ctrl+Shift+C |
| PDF Content: Snapshot / Cut / Erase content, Select / Edit text | Content-layer edits | Shift+G, Shift+T |
| Mark for Redaction / Mark Text / Apply Redactions | Redaction | Shift+R / Shift+K / Shift+A |
| Check Spelling | Spell check markups and fields | F7 |
| Align (L/R/T/B/center/middle), Center in Document, Align size | Alignment toolbar | Ctrl+Alt+L/R/T/B/E/M |
| Distribute H/V, Flip H/V | Arrange | Ctrl+Alt+H/V |
| Group / Ungroup | Groups | Ctrl+G / Ctrl+Shift+G |
| Bring forward / to front, Send backward / to back | Z-order | Ctrl+J, Ctrl+Shift+J, Ctrl+[, Ctrl+Shift+[ |
| Lock / Unlock | Freeze a markup | Ctrl+Shift+L |
| Set Status (Accepted, Rejected, Completed, Cancelled, None, custom) | Review status | custom |
| Check, Reply, Pop-up note | Checklist, threaded replies | — |
| Control points, Convert to Arc, Round Corners (21.8) | Vertex editing | — |
| Set As Default, Add to Tool Chest, Apply to All Pages, Change Colors | Properties | — |
| Autosize Text Box, Resume Count / Sequence, Edit Action, Flatten selected, Layer | Misc | Alt+Z, Ctrl+Shift+E |
| Legend from selection | Ad-hoc legend | — (C) |

## 4. View

| Feature | Key |
|---|---|
| Fit Page / Fit Width / Actual Size | Ctrl+9 / Ctrl+0 / Ctrl+8 |
| Single page, Continuous, Side-by-side, Continuous side-by-side | Ctrl+4/5/6/7 |
| Rotate view CW / CCW | Ctrl+Shift+Plus / Minus |
| Split vertical / horizontal, toggle, sync document / page | Ctrl+2 / Ctrl+H |
| Rulers, full-screen crosshair | Ctrl+R |
| Show Grid / Snap to Grid / Snap to Content / Snap to Markup | Shift+F9 / Ctrl+Shift+F9 / Ctrl+Shift+F8 / F7 |
| Dark mode, reply indicators, disable line weights, Dimmer | Ctrl+F5 (Dimmer) |
| Previous / next view, page navigation | Alt+Left/Right, Ctrl+Left/Right, Home/End |
| Zoom tool, refresh, web tab, remote files | Z, F5, Ctrl+T, Alt+K |

## 5. Document

| Feature | Key |
|---|---|
| Document properties, page setup | Ctrl+D |
| Rotate pages (permanent) | Ctrl+Shift+R |
| Insert blank page / pages from document / layered pages / scan | Ctrl+Shift+N / Ctrl+Shift+I |
| Extract / Split / Replace / Delete pages | Ctrl+Shift+X / — / Ctrl+Shift+Y / Ctrl+Shift+D |
| Crop pages, Deskew | Shift+Alt+O / Ctrl+Alt+D |
| Number pages, Create page labels (AutoMark from regions) | — |
| Headers & footers | — |
| Security (passwords, permissions) | Ctrl+L |
| Compare Documents, Overlay Pages (C); Stitching (M) | — |
| OCR (Cp), Script (Cp), Translate markups, Color processing | Ctrl+Shift+O |
| Reduce size, Repair, PDF/A | — |
| Flatten / Unflatten | Ctrl+Shift+M / Ctrl+Shift+U |
| Add bookmark, refresh document | Ctrl+B / Shift+F5 |
| File attachments | F |
| Bates, watermark | Not documented as Revu 21 commands (stamps / headers-footers instead) |

## 6. Batch

Crop & page setup, rotate, split, headers & footers, security, Sign & Seal (Cp),
apply stamp, Batch Link (Cp: auto-hyperlinks from page labels / file names /
regions), batch compare and overlay (C), Smart Overlay and Smart Review (M),
Slip Sheet (Cp), batch OCR (Cp), script (Cp), reduce, repair, flatten,
**Markup Summary** (CSV / XML / PDF / print; columns, filters, sort, replies,
latest status), batch print.

## 7. Tools — markups

| Tool | Key | Tier |
|---|---|---|
| Text Box / Typewriter / Note / Callout | T / W / N / Q | B |
| Pen / Highlight / Eraser | P / H / Shift+E | B |
| Line / Arrow / Arc / Polyline / Dimension | L / A / Shift+C / Shift+N / Shift+L | B |
| Rectangle / Ellipse / Polygon / Cloud / Cloud+ | R / E / Shift+P / C / K | B |
| Image (file, camera, scanner, crop) | I / Ctrl+Alt+I / Shift+I | B |
| Flag | Shift+F | n/s |
| Review text, Underline, Squiggly, Strikethrough | Shift+Alt+R / U / Shift+U / D | B |
| Create hyperlinks from URLs | — | n/s |
| Stamp (dynamic stamps, stamp folders) | S | B |
| Sketch to Scale (polygon, rectangle, ellipse, polyline) | — | C |
| Hyperlink (page, place, space, snapshot view, URL, file) | Shift+H | B |
| File Attachment | F | n/s |
| Custom line styles and hatch patterns | — | C |
| Capture (photos / video / 360° on a markup) | — | n/s |

## 8. Tools — measurement

| Tool | Key | Tier |
|---|---|---|
| Set Scale / Calibrate (separate Y scale, precision) | — | B |
| Length / Polylength (rise/drop) / Area / Perimeter | Shift+Alt+L / Q / A / P | B–C |
| Diameter / Center Radius / 3-Point Radius / Angle | Shift+Alt+D / U / U / G | C |
| Volume (area × depth) | Shift+Alt+V | C |
| Polygon / Ellipse Cutout | — | B/C |
| Count (symbols, resume, groups by Space) | Shift+Alt+C | C |
| Dynamic Fill (flood-fill to area / length / volume) | J | Cp |
| Viewports (per-region scale) | — | C |
| Slope; Depth → Wall Area | — | n/s |
| Measurement captions, custom captions, recalculate | — | n/s |
| Quantity Link (live Excel) | — | Cp |

## 9. Forms and signatures

Auto-create fields (Cp), text / radio / check / list / dropdown / button fields,
digital-signature field, form editor, FDF/CSV/XML import-export, field
highlighting / reset / JavaScript, sign, certify, validate, digital IDs.

## 10. Window

Full screen (F11), presentation (Ctrl+Enter), always on top, panels, detachable
tabs (Ctrl+Tab), navigation bar (F4), status bar (F8), menu bar (F9), JS console.

## 11. Panels

Markups List (columns incl. Subject, Page Label, Lock, Status, Checkmark, Author,
Date, Color, Comments, Length, Area, Volume, Wall Area, Count, Depth, Slope,
Layer, Space; filters, saved filters, sort, group by subject, replies, import /
export BAX/FDF, Summary), custom columns (text / number / date / choice /
formula), custom statuses, **Tool Chest** (tool sets, hot keys, properties vs
drawing mode, scale per set, legends, sync), **Properties**, **Thumbnails**,
**Bookmarks** (auto from page labels), **Layers** (OCG), **Measurements**,
**Search** (incl. Visual Search, Search & Replace, actions on results),
**Signatures**, **File Access**, **Links** (places, hyperlinks list), **Spaces**,
**Sets** (multi-file binder, revisions, slip sheets), **Studio** (sessions,
projects), Forms, Flags, Stitching, 3D model tree, Legends.

## 12. Cross-cutting

Punch / status workflow (Field Issues profile, statuses, checkmarks, Punch Key),
AutoMark, export to Excel (CSV, Quantity Link), Revu MCP (M), CAD/BIM plugins,
DMS integrations (SharePoint, ProjectWise, Procore …).

## 13. Bluebeam Cloud (web / iOS / Android)

Core markup set, pen eraser, length / area / polylength / count, Tool Chest sync,
markup status and replies, Studio sessions and projects, form and signature
fields, photo capture on markups, PDF templates.

## Sources

- Keyboard shortcuts: https://support.bluebeam.com/revu/resources/keyboard-shortcuts.html
- User manual (menus): https://support.bluebeam.com/user-manual/dashboard.html
- Edit / View / Document / Batch / Tools / Window menus: https://support.bluebeam.com/user-manual/menus/
- Markups List: https://support.bluebeam.com/user-manual/menus/window/markups-list.html
- Custom columns: https://support.bluebeam.com/user-manual/menus/window/custom-columns.html
- Tool Chest: https://support.bluebeam.com/user-manual/menus/window/tool-chest-panel.html
- Measurements panel: https://support.bluebeam.com/user-manual/menus/window/measurements-panel.html
- Count tool: https://support.bluebeam.com/user-manual/menus/tools/count-tool.html
- Dynamic Fill: https://support.bluebeam.com/user-manual/menus/tools/dynamic-fill.html
- Hyperlink tool: https://support.bluebeam.com/user-manual/menus/tools/hyperlink-tool.html
- Stamp tool: https://support.bluebeam.com/user-manual/menus/tools/stamp-tool.html
- Markups Legend: https://support.bluebeam.com/user-manual/menus/tools/markups-legend.html
- Alignment tools: https://support.bluebeam.com/revu/how-to/resize-and-arrange-markups-with-alignment-tools.html
- Batch Link: https://support.bluebeam.com/user-manual/menus/batch/link.html
- Slip Sheet: https://support.bluebeam.com/user-manual/menus/batch/slip-sheet.html
- Markup Summary: https://support.bluebeam.com/user-manual/menus/batch/summary.html
- Compare Documents: https://support.bluebeam.com/user-manual/menus/document/compare-documents.html
- Page labels / AutoMark: https://support.bluebeam.com/se/user-manual/menus/window/edit-page-labels-page-numbers.html
- Capture: https://support.bluebeam.com/revu/how-to/embed-images-and-video-into-markups.html
- Quantity Link: https://support.bluebeam.com/revu/how-to/enable-quantity-link.html
- Revu 21 release notes: https://support.bluebeam.com/revu/resources/revu-21-release-notes.html
- Bluebeam on mobile release notes: https://support.bluebeam.com/bluebeam-cloud/resources/bluebeam-cloud-release-notes.html
- Pricing and plans: https://www.bluebeam.com/pricing/
