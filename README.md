# PDF Signer

A simple, **offline** app (**Windows + macOS desktop**, and now **Android**) to
open PDFs, **view** large plan sets fast, **mark them up** (arrows, shapes,
clouds, ink, text, highlight), **measure by scale**, add a **signature /
initials / date**, and save. Built with Electron on the desktop and
[Capacitor](https://capacitorjs.com/) on Android, both driving the *same*
renderer — the official PDF.js viewer (virtualized rendering) and pdf-lib
(writing/exporting).

> **Android:** the entire UI + PDF engine is platform-neutral web code, so the
> Android app reuses the desktop renderer verbatim inside a native WebView. The
> only platform-specific layer is file I/O: on desktop that's Electron IPC; on
> Android it's the system file picker plus the Capacitor Filesystem/Share
> plugins (`src/renderer/js/platform-web.js`). See
> [Build the Android app](#build-the-android-app-apk).

## ⬇ Download

### [**Download for Windows (64-bit)**](https://github.com/Killswit3h/PDF-Reader/releases/latest/download/PDF-Signer-Setup.exe)

Runs on Windows 10/11. Download, run the installer, and launch **PDF Signer**.
Windows SmartScreen may warn about an "unknown publisher" (the app is not
code-signed) — click **More info → Run anyway**.

### [**Download for Android (APK)**](https://github.com/Killswit3h/PDF-Reader/releases/latest/download/PDF-Signer.apk)

Sideload on Android 6+. Download `PDF-Signer.apk`, tap it, and allow
**"install unknown apps"** for your browser/Files app when prompted (the APK is
signed with a debug key, not a Play Store release key). Not yet on Google Play.

**macOS:** grab the `.dmg` from the [latest release](https://github.com/Killswit3h/PDF-Reader/releases/latest)
(universal, Intel + Apple Silicon). It's unsigned, so **right-click → Open** the
first time (or `xattr -dr com.apple.quarantine "/Applications/PDF Signer.app"`).

Windows, macOS, and Android builds are all built and published automatically on
every version tag — see
[Publishing a release](#publishing-a-release-one-time-setup). The app also checks
for updates on launch and shows a version badge in the toolbar (click it to check
manually); when a newer release exists it offers a one-click link to download it.

> **Note:** This is a *cosmetic* e-signature tool. Signatures are rendered as
> images and stamped onto the page. It does **not** create cryptographic /
> certificate-based (PKI) digital signatures.

Everything runs locally — no cloud, no login, no telemetry, no network access
at runtime. Handwriting fonts are bundled with the app.

---

## Features

- **Open & view** — Open button + native dialog, or **drag a `.pdf`** onto the
  window. Built on the official **PDF.js viewer** with **virtualized rendering**
  (only visible pages are rasterized) so large multi-hundred-page plan sets stay
  responsive. Includes **text selection**, **Find** (`Ctrl+F`), page navigation,
  zoom in/out, fit-to-width, and a live page counter.
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
- **Save** — overwrites the file you opened, in place, with no dialog
  (`Ctrl+S`). Nothing is written to disk until you press Save. **Save As…**
  (`Ctrl+Shift+S`) writes a copy to a location you choose (default
  `<original>-signed.pdf`). If the document was opened by dropping raw bytes with
  no file path, Save behaves like Save As the first time, then remembers it.
- **Markup tools** (Bluebeam-style) — under the **✏️ Markup** menu: **arrow, line,
  rectangle, ellipse, polyline, polygon, revision cloud, freehand ink, text box,
  callout, and highlight**. Select to move/resize, edit properties (stroke color,
  fill, line width, opacity) in the properties bar, **undo/redo** (`Ctrl+Z`/`Ctrl+Y`),
  and delete. A **Markups List** panel lists every markup (select, delete, export CSV).
  On save, markups are **flattened** by default, or written as **real, editable PDF
  annotations** (Square/Circle/Line/PolyLine/Polygon/Ink/FreeText) when you tick
  *"Save markups as editable PDF annotations"* in the Markups List — interoperable
  with other PDF tools. (Existing annotations from other apps are displayed and
  preserved on save; importing them for in-app editing is planned.)
- **Measure by scale** (Bluebeam-style takeoff) — under the **📐 Measure** menu:
  - **Set Scale** — calibrate by drawing a line of known length, or enter a
    ratio / pick a preset (`1/4" = 1'-0"`, `1:100`, …). Scale is stored per page.
  - **Length, Perimeter, Area, Angle, Count** — draw on the page and get live,
    real-world values (area in unit², angle in degrees). Snapping to existing
    vertices; hold **Shift** for orthogonal/45° lines. **Enter** finishes a
    polyline/polygon, **Esc** cancels.
  - **Add Scale Region** — a viewport with its own scale, so one sheet can carry
    multiple scales (measurements inside it use the region's scale).
  - **Measurements List** — a side panel of every measurement with per-type
    totals and **Export CSV**.
  - Measurements are flattened into the saved PDF alongside signatures.
- **Light & dark themes** — a cohesive design-token system with a **persisted
  theme toggle** (☾ / ☀) in the top bar; defaults to your OS preference and
  applies before first paint (no flash).
- **Editing safety & precision** — **unified undo/redo** across signatures,
  measurements *and* markups (`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`);
  **arrow-key nudging** of the selected item (hold **Shift** for ×10);
  **confirm dialogs** before "Clear all" and before the first overwrite of a
  file (offering *Save a copy…*); **snap-to-vertex** and Shift-orthogonal while
  dragging markups.
- **Preferences that stick** — your markup style defaults (color / fill / width /
  opacity), the *editable-annotations* toggle, snapping, and theme are
  remembered between launches.
- **Find & filter** — filter inputs in the Markups and Measurements panels
  narrow long lists by type / value / page.

## Layout & keyboard

The **top bar** carries Open · zoom · page navigation · Save / Save As · theme ·
version. A **left tool rail** holds the creation tools: **Sign · Initials · Date ·
Measure ▾ · Markup ▾**.

Keyboard: `Ctrl+O` open · `Ctrl+S` save · `Ctrl+Shift+S` save as · `Ctrl+F` find ·
`Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `+ / − / 0` zoom (0 = 100%) · `← / →` page ·
**arrow keys** nudge the selected item (**Shift** = ×10) · `Esc` cancel / close a
modal / deselect · `Delete` remove selected.

Zoom: trackpad **pinch-to-zoom** (macOS & Windows precision trackpads) and
**`Ctrl`/`Cmd` + scroll wheel** zoom toward the pointer.

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

## Testing

Two layers, both runnable before pushing:

```bash
npm test          # vitest unit tests over the shared pure logic
npm run test:e2e  # end-to-end smoke suite driving the real Electron app
npm run verify    # both, in sequence — the pre-push gate
```

- **Unit tests** (`test/unit/`) cover the extracted pure logic in `src/shared/`
  — geometry (length/area/angle/snap/arrow), measurement math + unit
  conversion, semver / repo-slug / launch-argv parsing, date formatting, and
  preferences. No Electron required; runs in milliseconds.
- **E2E smoke suite** (`test/e2e/run.js`) launches the real app headlessly via
  the `SMOKE_*` harness in `main.js` against committed fixtures
  (`test/fixtures/`, regenerate with `npm run fixtures`) and asserts nine
  scenarios: cold-start "Open with", warm document swap, trackpad/Ctrl-wheel
  zoom, virtualized rendering + find, all markup tools, scaled measurements,
  editable annotations, overlay rendering, and PDF save/flatten.
- CI (`.github/workflows/ci.yml`) runs the unit tests on Linux/Windows/macOS and
  the E2E suite headlessly (xvfb) on every push and PR; the release workflow
  gates every build on the same tests. A local `scripts/prepush.sh` runs
  `npm run verify` — symlink it as a `pre-push` hook if you like.

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

## Build the macOS app (`.dmg`)

Run **on a Mac**:

```bash
npm run dist:mac      # universal (Intel + Apple Silicon) -> release/PDF-Signer-<version>-universal.dmg (+ .zip)
```

The build is **unsigned** by default, so Gatekeeper will block a double-click the
first time — **right-click the app → Open → Open**, or run
`xattr -dr com.apple.quarantine "/Applications/PDF Signer.app"`. To ship a signed +
notarized build, set these before `npm run dist:mac` (Apple Developer account
required): `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Both platforms register **PDF Signer** as a handler for `.pdf` (Open With), and
macOS "Open with" is handled via the app's `open-file` event.

## Build the Android app (`.apk`)

The Android app wraps the desktop renderer in a native WebView via
[Capacitor](https://capacitorjs.com/). The build has two steps: bundle the web
renderer into a self-contained `www/`, then let Capacitor generate and build the
native Android project.

**Prerequisites:** Android SDK + a JDK (17 or 21). Easiest via
[Android Studio](https://developer.android.com/studio), which also gives you an
emulator and one-click Run.

```bash
npm ci                 # installs deps incl. Capacitor + the vendored web libs
npm run build:web      # assemble the self-contained www/ bundle
npm run android:add    # first time only: generate the native android/ project
npm run android:apk    # build -> android/app/build/outputs/apk/debug/app-debug.apk
```

After the first `android:add`, use `npm run android:sync` to push renderer
changes into the native project, `npm run android:open` to open it in Android
Studio (Run on a device/emulator from there), or `npm run android:apk` to
assemble a debug APK from the command line.

Two ways to get an APK without a local Android toolchain:

- **A published release** — every version tag builds `PDF-Signer.apk` and
  attaches it to the GitHub Release (see [Publishing a release](#publishing-a-release-one-time-setup)).
  The **Download for Android** button above points at the latest release's APK.
- **A CI artifact** — every push and PR also builds a debug APK in CI
  (`.github/workflows/android.yml`) and uploads it as a workflow artifact
  (`pdf-signer-debug-apk`); download it from the Actions run to sideload.

The generated `android/` directory and the `www/` bundle are **git-ignored**
(reproducible from source); commit only `capacitor.config.json` and the build
scripts.

How the port works:

- **`scripts/build-web.js`** copies the renderer, shared logic, fonts, and the
  vendored PDF.js / pdf-lib / signature_pad files into `www/`, rewriting the
  `node_modules` / `shared` paths so the bundle is self-contained, and injects
  the platform adapter + a mobile viewport.
- **`src/renderer/js/platform-web.js`** provides the same `window.api` surface
  the desktop gets from Electron's preload — open via the system file picker,
  save/export via the Capacitor Filesystem + Share plugins (or a browser
  download when run as a plain web page). None of the app modules change.
- **`npm run verify:web`** builds the bundle and drives it in a headless
  Chromium (the same engine the Android WebView uses) to confirm it boots, loads
  a PDF, renders, and exports — no Android SDK required.

> The Android build is a **debug**, unsigned APK. To publish to Google Play,
> generate a signed release build (`./gradlew bundleRelease` with a keystore) —
> out of scope for this repo's CI, which only produces a sideloadable debug APK.

## Publishing a release (one-time setup)

You don't need a Windows machine to publish — a GitHub Actions workflow
(`.github/workflows/release.yml`) builds the Windows installer, the macOS
`.dmg`/`.zip`, and the **Android `PDF-Signer.apk`** on their respective runners
and attaches all of them to a single GitHub Release. The **Download** buttons
above always point at the latest release's assets.

**To cut a release, push a version tag:**

```bash
# bump the "version" in package.json first (e.g. 1.0.0), then:
git tag v1.0.0
git push origin v1.0.0
```

The workflow publishes `PDF-Signer-Setup.exe`, the macOS artifacts, and
`PDF-Signer.apk` as release `v1.0.0`. Within a few minutes the download buttons
work for everyone.

> **The Download for Android button 404s until the first release built with the
> updated workflow exists** — earlier releases have no APK attached. Cut a new
> version tag (or re-run the release workflow) to publish the first APK.

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
├─ package.json            # deps (pinned) + electron-builder config + android:* scripts
├─ capacitor.config.json   # Capacitor (Android) config: appId, appName, webDir=www
├─ scripts/
│  ├─ prepush.sh           # local pre-push gate (npm run verify)
│  ├─ build-web.js         # assemble the self-contained www/ bundle (Capacitor webDir)
│  └─ verify-web.js        # drive www/ in headless Chromium (WebView-parity check)
├─ build/
│  ├─ icon.ico             # app/installer icon (256x256)
│  └─ make-icon.js         # regenerates the icon (pure Node)
├─ src/
│  ├─ main.js              # Electron main: window, file dialogs, fs bridge
│  ├─ preload.js           # contextBridge IPC surface (no raw node in renderer)
│  ├─ shared/              # pure logic — dual browser/Node export, unit-tested
│  │  ├─ geometry.js       # dist/polyLen/shoelace/angleAt/ortho/snap/arrowhead
│  │  ├─ measure-math.js   # units, fmtMeasure, computeValue, ratio→factor
│  │  ├─ date-util.js      # todayFormatted
│  │  ├─ prefs.js          # localStorage-backed App.Prefs (injectable store)
│  │  └─ update-utils.js   # semverCmp / repoSlug / fileFromArgv (main process)
│  ├─ assets/fonts/        # bundled OFL fonts + license files
│  └─ renderer/
│     ├─ index.html        # top bar + left tool rail + panels + modals
│     ├─ styles/tokens.css # design tokens + light/dark themes
│     ├─ styles.css        # component styles (token-driven)
│     └─ js/
│        ├─ theme-boot.js  # pre-paint theme apply (CSP-safe, runs in <head>)
│        ├─ platform-web.js# window.api for the WebView/browser (Android + web build)
│        ├─ util.js        # shared state + helpers (toast, loading, confirm)
│        ├─ history.js     # App.History: unified undo/redo across all layers
│        ├─ signature.js   # creation modal (type/initials/draw) -> PNG
│        ├─ placement.js   # click-to-place, drag/resize, nudge, date editing
│        ├─ viewer.js      # PDF.js render, zoom, fit, navigation
│        ├─ measure.js     # scale calibration, measurement tools, viewports, CSV
│        ├─ markup.js      # Bluebeam-style markup engine + Markups List panel
│        ├─ save.js        # pdf-lib export + coordinate mapping
│        └─ app.js         # toolbar/rail wiring, drag-drop, keyboard, theme, modes
├─ test/
│  ├─ unit/                # vitest suites over src/shared/*
│  ├─ e2e/run.js           # headless Electron smoke suite (SMOKE_* harness)
│  └─ fixtures/            # committed sample.pdf + big.pdf (make-fixtures.js)
├─ www/                    # (generated) self-contained web bundle — git-ignored
└─ android/                # (generated) Capacitor native project — git-ignored
```

On the desktop, libraries are loaded from `node_modules` as local UMD builds
(offline); `asar` is disabled so PDF.js's worker file loads reliably at runtime.
The Android build copies those same UMD files into `www/vendor/` so the bundle
is fully self-contained inside the WebView.

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
