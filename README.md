# PDF Signer

A simple, **offline** Windows desktop app to open a PDF, add a **signature**,
**initials**, or a **date**, and save a new signed copy. Built with Electron,
PDF.js (viewing), and pdf-lib (writing/exporting).

## ⬇ Download

### [**Download for Windows (64-bit)**](https://github.com/Killswit3h/PDF-Reader/releases/latest/download/PDF-Signer-Setup.exe)

Runs on Windows 10/11. Download, run the installer, and launch **PDF Signer**.
Windows SmartScreen may warn about an "unknown publisher" (the app is not
code-signed) — click **More info → Run anyway**.

> No installer yet? It's published automatically the first time a version tag is
> pushed — see [Publishing a release](#publishing-a-release-one-time-setup).

> **Note:** This is a *cosmetic* e-signature tool. Signatures are rendered as
> images and stamped onto the page. It does **not** create cryptographic /
> certificate-based (PKI) digital signatures.

Everything runs locally — no cloud, no login, no telemetry, no network access
at runtime. Handwriting fonts are bundled with the app.

---

## Features

- **Open & view** — Open button + native dialog, or **drag a `.pdf`** onto the
  window. All pages render in a scrollable view with page navigation, zoom
  in/out, fit-to-width, and a live page counter.
- **Sign / Initials** — Create a signature three ways in one modal:
  - **Type** your name → rendered in a handwriting font (choose *Dancing Script*
    or *Great Vibes*), with a live preview.
  - **Initials** → same, tuned for a short initial block.
  - **Draw** → freehand pad (mouse/trackpad/touch) with ink-color + clear.
  - Every creation becomes a **transparent PNG**. The last signature/initials of
    the session are **remembered** so you can re-place them without recreating.
- **Place** — after creating, click where it goes. A **draggable, resizable**
  box lets you position and scale before/after committing. Place multiple items
  across multiple pages. Select an item to reveal a **✕ delete** button (or press
  **Delete**).
- **Date** — inserts today's date (default `MM/DD/YYYY`) at a clicked spot;
  **double-click to edit** the text before saving.
- **Save** — writes a **new** PDF (`<original>-signed.pdf`) via a native Save
  dialog. The original file on disk is never touched until you explicitly save.

## Toolbar

`Open · Sign · Initials · Date · Zoom − / + · Fit · Page ▲/▼ (with page box) · Save`

Keyboard: `Ctrl+O` open · `Ctrl+S` save · `+ / -` zoom · `← / →` page ·
`Esc` cancel/deselect · `Delete` remove selected.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (built and tested with Node 22).
- To **build the Windows installer from macOS/Linux**, electron-builder will
  auto-download a bundled Wine to run the NSIS step. Building **on Windows**
  needs nothing extra.

## Install

```bash
npm install
```

## Run in development

```bash
npm start
```

## Build the Windows installer (`.exe`)

```bash
npm run dist          # x64  -> release/PDF Signer Setup <version>.exe
npm run dist:arm64    # arm64 build (Windows on ARM), optional
```

The NSIS installer is written to `release/`. It is a standard user-choosable
installer (choose folder, desktop + start-menu shortcuts). A quick unpacked
build for local testing:

```bash
npm run pack          # -> release/win-unpacked/
```

## Publishing a release (one-time setup)

You don't need a Windows machine to publish — a GitHub Actions workflow
(`.github/workflows/release.yml`) builds the installer on a Windows runner and
attaches it to a GitHub Release. The **Download for Windows** button above always
points at the latest release's `PDF-Signer-Setup.exe`.

**To cut a release, push a version tag:**

```bash
# bump the "version" in package.json first (e.g. 1.0.0), then:
git tag v1.0.0
git push origin v1.0.0
```

The workflow builds `PDF-Signer-Setup.exe` and publishes it as release `v1.0.0`.
Within a few minutes the download button works for everyone.

**Or trigger it manually:** open the repo's **Actions** tab → *Build & Release
(Windows)* → **Run workflow**. It uses the version from `package.json` for the
tag.

No secrets to configure — it uses the automatic `GITHUB_TOKEN`. (The build is
not code-signed, so users get a one-time SmartScreen prompt; add a code-signing
certificate later if you want to remove it.)

---

## Project structure

```
PDF Reader/
├─ package.json            # deps (pinned) + electron-builder config
├─ build/
│  ├─ icon.ico             # app/installer icon (256x256)
│  └─ make-icon.js         # regenerates the icon (pure Node)
└─ src/
   ├─ main.js              # Electron main: window, file dialogs, fs bridge
   ├─ preload.js           # contextBridge IPC surface (no raw node in renderer)
   ├─ assets/fonts/        # bundled OFL fonts + license files
   └─ renderer/
      ├─ index.html        # single-window UI + toolbar + modal
      ├─ styles.css
      └─ js/
         ├─ util.js        # shared state + helpers (toast, loading)
         ├─ signature.js   # creation modal (type/initials/draw) -> PNG
         ├─ placement.js   # click-to-place, drag/resize, delete, date editing
         ├─ viewer.js      # PDF.js render, zoom, fit, navigation
         ├─ save.js        # pdf-lib export + coordinate mapping
         └─ app.js         # toolbar wiring, drag-drop, keyboard, modes
```

Libraries are loaded from `node_modules` as local UMD builds (offline). `asar`
is disabled so PDF.js's worker file loads reliably at runtime.

---

## Coordinate-mapping approach (PDF.js → pdf-lib)

This is the crux of stamping things where the user actually clicked.

**Storage.** Each placed item is stored in **scale-1 viewport points** with a
**top-left origin** (`vx, vy, vw, vh`), *not* screen pixels. Because the geometry
is zoom-independent, changing zoom or scrolling only re-positions the on-screen
box (`left = vx * zoom`, etc.) — no data conversion, no drift. Positions are kept
relative to each **page element**, so scroll offset never enters the math.

**Export.** pdf-lib draws in **PDF user space** with a **bottom-left origin**.
Rather than hand-rolling the Y-flip (and getting page **rotation** wrong), we
reuse PDF.js's own transform: every page's `PageViewport` exposes
`convertToPdfPoint(x, y)`, which maps any viewport point straight into PDF user
space for **any** page rotation.

For each item's on-screen axis-aligned box we map three corners:

```
A = top-left     (vx,        vy)
B = bottom-left  (vx,        vy + vh)   → the image/text anchor (lower-left)
C = bottom-right (vx + vw,   vy + vh)
```

then derive what pdf-lib needs:

```
width  = |C − B|
height = |A − B|
angle  = atan2(C.y − B.y, C.x − B.x)     // CCW from user-space +x
drawImage(png, { x: B.x, y: B.y, width, height, rotate: angle })
```

For an **unrotated** page this reduces to the textbook flip
`x = vx`, `y = pageHeight − vy − vh`, `angle = 0`, `width = vw`, `height = vh`.
For 90/180/270-rotated pages the same three-corner method yields the correct
position, size, and rotation automatically. Date text is anchored the same way
at its baseline. (Assumes a page MediaBox with a `[0 0 W H]` lower-left, which is
true of virtually all real-world PDFs.)

This was verified end-to-end: driving the real render→save pipeline on a 3-page
document places a signature at `x=100, y=112` (=`792−620−60`) at `200×60`, and a
date baseline at the expected point — matching the on-screen placement exactly.

---

## Error handling

Corrupt, unsupported, or password-protected/encrypted PDFs surface a clear
message instead of crashing. Save failures are reported via a toast. The source
document is only read, never modified.

## Notes on library choices

The requested free/open-source stack (Electron + PDF.js + pdf-lib +
signature_pad) covers every requirement here well. A commercial library would
only be materially better if you later need **true certificate-based digital
signatures** (e.g. PAdES/PKI), high-fidelity rendering of exotic/encrypted PDFs,
or built-in form-field handling — all out of scope for this cosmetic signer.

## License

Application code: MIT. Bundled fonts: SIL Open Font License 1.1 (see
`src/assets/fonts/`).
# PDF-Reader
