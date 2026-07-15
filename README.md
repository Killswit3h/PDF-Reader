# FieldMark

<sub>(formerly *PDF Signer*)</sub>

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

### [**Download for Windows (64-bit)**](https://github.com/Killswit3h/PDF-Reader/releases/latest/download/Field-Mark-Setup.exe)

Runs on Windows 10/11. Download, run the installer, and launch **FieldMark**.
Windows SmartScreen may warn about an "unknown publisher" (the app is not
code-signed) — click **More info → Run anyway**.

### [**Download for Android (APK)**](https://github.com/Killswit3h/PDF-Reader/releases/latest/download/FieldMark.apk)

Sideload on Android 6+. Download `FieldMark.apk`, tap it, and allow
**"install unknown apps"** for your browser/Files app when prompted (the APK is
signed with a debug key, not a Play Store release key). Not yet on Google Play.
The app **checks GitHub for a newer release on launch** (and via the version
badge in the top bar); when one exists it offers a one-tap **Download** of the
new APK to sideload over the top.

**macOS:** grab the `.dmg` from the [latest release](https://github.com/Killswit3h/PDF-Reader/releases/latest)
(universal, Intel + Apple Silicon). The app is **ad-hoc signed but not notarized**
(notarization needs a paid Apple Developer account), so macOS quarantines the
download. Right-click → **Open** the first time to launch it.

**To use it as your default PDF opener**, clear the quarantine flag once — without
this, macOS refuses to launch it as a document handler and shows *"«file».pdf is
damaged and can't be opened"* (the file is fine; Gatekeeper is blocking the
*app*). In Terminal:

```bash
xattr -cr "/Applications/FieldMark.app"
codesign --force --deep --sign - "/Applications/FieldMark.app"   # only needed on older downloads
```

Then right-click a PDF → **Get Info** → **Open with** → **FieldMark** → **Change
All…**. (Builds from v1.10.0 on are ad-hoc signed at release time, so the
`codesign` line is only needed for earlier downloads.)

Windows, macOS, and Android builds are all built and published automatically on
every version tag — see
[Publishing a release](#publishing-a-release-one-time-setup). The app checks for
updates on launch and shows a version badge in the toolbar (click it to check
manually). When a newer release exists:

- **Windows** downloads and installs the update **in-app** (electron-updater):
  the update dialog shows download progress, then **Restart & Install** applies
  it — no manual re-download. Powered by the `latest.yml` + `.blockmap` the
  release workflow ships next to the installer.
- **macOS** and **Android** open the download page for the new `.dmg` / `.apk`
  instead. (In-app install on macOS needs a signed, notarized build, which the
  release is not yet — it falls back rather than shipping a broken updater.)

> **Two kinds of signature.** The **Sign / Initials** tools are *cosmetic* —
> your signature is rendered as an image and stamped onto the page (it looks
> signed but carries no cryptographic proof). Separately, **Document → Digital
> Signature** applies a *real* certificate-based **PKI / PAdES** signature using
> your own digital ID (`.p12`/`.pfx`): it cryptographically binds your identity
> to the document and makes any later change detectable. See
> [Digital signatures](#digital-signatures-pki--pades) below.

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
  box lets you position and scale before/after committing, **anywhere on the
  page** — including flush in the margins or overhanging any edge (no forced
  keep-on-page). Place multiple items across multiple pages. Select an item to
  reveal a **✕ delete** button (or press **Delete**).
- **Date** — inserts today's date (default `MM/DD/YYYY`) at a clicked spot;
  **double-click to edit** the text before saving.
- **Save** — overwrites the file you opened, in place, with no dialog
  (`Ctrl+S`). Nothing is written to disk until you press Save. **Save As…**
  (`Ctrl+Shift+S`) writes a copy to a location you choose (default
  `<original>-signed.pdf`). If the document was opened by dropping raw bytes with
  no file path, Save behaves like Save As the first time, then remembers it.
- **Markup tools** (Bluebeam-style) — under the **✏️ Markup** menu: **arrow, line,
  rectangle, ellipse, polyline, polygon, revision cloud, freehand ink, text box,
  callout, and highlight**, plus **text-anchored Highlight / Underline /
  Strikethrough** — select text in the page and apply, and the markup snaps to the
  exact word rectangles (multi-line aware). Select to move/resize, edit properties (stroke color,
  fill, line width, opacity) in the properties bar, **undo/redo** (`Ctrl+Z`/`Ctrl+Y`),
  and delete. A **Markups List** panel lists every markup (select, delete, export CSV).
  On save, markups are **flattened** by default, or written as **real, editable PDF
  annotations** (Square/Circle/Line/PolyLine/Polygon/Ink/FreeText) when you tick
  *"Save markups as editable PDF annotations"* in the Markups List — interoperable
  with other PDF tools. (Existing annotations from other apps are displayed and
  preserved on save; importing them for in-app editing is planned.)
- **Marks stay editable after saving** — a saved file embeds an editable copy of
  your measurements, markups, and text placements (plus a pristine copy of the base
  PDF). Reopen it in FieldMark and every mark comes back as a **live, movable /
  deletable object** — nothing is stuck to the page. Other apps (Adobe/Bluebeam)
  still see the flattened marks as usual; the editable data rides along as an inert
  attachment. (This roughly doubles a marked-up file's size, since it carries both
  the flattened view and the editable source.)
- **Select & copy text** — drag to select text on any PDF page and a floating
  **📋 Copy** button appears; click it or press **Ctrl/Cmd+C** to copy the text to
  your clipboard.
- **Measure by scale** (Bluebeam-style takeoff) — under the **📐 Measure** menu:
  - **Set Scale** — calibrate by drawing a line of known length, or enter a
    ratio / pick a preset (`1/4" = 1'-0"`, `1:100`, …). **Applies to all pages by
    default** (choose *This page* in the dialog to scope it to one sheet); scale
    regions still override per-area.
  - **Length, Perimeter, Area, Angle, Count** — draw on the page and get live,
    real-world values (area in unit², angle in degrees). Snapping to existing
    vertices; hold **Shift** for orthogonal/45° lines. **Enter** finishes a
    polyline/polygon, **Esc** cancels.
  - **Add Scale Region** — a viewport with its own scale, so one sheet can carry
    multiple scales (measurements inside it use the region's scale).
  - **Measurements List** — a side panel of every measurement with per-type
    totals and **Export CSV**.
  - **Reposition after placing** — with no measure tool armed, click a
    measurement (or markup) to select it, then **drag to move** it (or use the
    arrow keys; **Shift** locks to an axis). Handy for fixing a misplaced item.
  - Measurements are flattened into the saved PDF alongside signatures.
- **Light & dark themes** — a cohesive design-token system with a **persisted
  theme toggle** (☾ / ☀) in the top bar; defaults to your OS preference and
  applies before first paint (no flash).
- **Collapsible tool rail** — a chevron at the top of the left rail collapses it
  to an **icon-only strip** so the page gets more width, while every tool stays
  one click away (hover for its label). The choice is remembered between launches.
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
- **Organize pages** (Document ▾ → Organize) — a thumbnail panel to **reorder** (◀ ▶),
  **rotate** (⟳), **delete**, and **insert blank** pages; **Merge** another PDF's
  pages in; and **Extract** ticked pages to a new file. *Apply* rebuilds the
  document with pdf-lib (`copyPages`) and reloads it.
- **Fill interactive forms** — real **AcroForm** fields render as native inputs
  (PDF.js `ENABLE_FORMS`); type into them and the values are baked into the saved
  PDF (`saveDocument` → pdf-lib), or **flatten** them to static content on save.
- **Numbering & stamps** (Document ▾ → Numbering & Stamps) — **Bates / page numbering** (prefix, start,
  zero-padding, corner), **header / footer** text, and a rotated **watermark**
  (text, size, angle, opacity, color) — applied across all pages or a range, with
  a live preview. Drawn into the PDF at save time.
- **Tool Chest** (Document ▾ → Tool Chest) — save a markup tool's **type + style** as a reusable
  tool, or add an image as a reusable **stamp**; click to re-apply. Stored locally
  (localStorage) so it persists across launches.
- **Compare Documents** (Document ▾ → Compare Documents) — overlay the open PDF (A)
  against a chosen PDF (B) page-by-page. Shared content renders gray, content only
  in **A** is red, content only in **B** is blue, with a per-page count of the
  pixels that differ — a fast way to spot revisions between two versions of the
  same drawing. Renderer-only (PDF.js canvas + pixel diff), so it runs on all three
  platforms.

## Digital signatures (PKI / PAdES)

**Document ▾ → Digital Signature** applies a real, certificate-based signature —
distinct from the cosmetic Sign/Initials tools — using your own **digital ID**
(a `.p12`/`.pfx` file that holds your private key + certificate):

- Import your digital ID, enter its password, optionally add a **visible
  signature block** on a chosen page/corner, then **Sign & Save**. The visible
  block mirrors Adobe's default layout — your **name large on the left**, and
  **"Digitally signed by … / Date … / Reason / Location"** on the right. The
  output carries a standard `adbe.pkcs7.detached` signature.
- **Fully offline & private.** Signing runs entirely in the app (node-forge +
  pdf-lib in the renderer, so Windows/macOS/Android all use one implementation).
  Your key and password stay in memory for the signing operation only — they are
  never written to disk or sent anywhere.
- **Tamper-evident + identity-bound.** Any change after signing invalidates the
  signature. If your certificate chains to a trusted CA (e.g. an **Adobe AATL**
  member such as IdenTrust/DigiCert/GlobalSign), Adobe shows the green *"Signed
  and all signatures are valid"* automatically; a self-signed ID is equally
  tamper-evident but shows *"validity unknown"* until the recipient trusts it.

**Good to know:**
- **Sign last.** A digital signature must be the final step — editing or
  re-marking the document afterward breaks it. (Place any cosmetic
  signature/markup first, then digitally sign.)
- **No trusted timestamp.** Because the app never touches the network, signatures
  are not RFC-3161 timestamped; their time comes from your system clock and they
  don't embed long-term-validation (LTV) data.
- You need your **own** digital ID — the app doesn't issue certificates. Buy one
  from a CA for public trust, or generate a self-signed one for internal use.

## Layout & keyboard

The **top bar** carries Open · zoom · page navigation · Save / Save As · theme ·
version. A **left tool rail** holds the creation tools in three groups:
**Stamp** (Sign · Initials · Date), **Take-off** (Measure ▾ · Markup ▾), and
**Document ▾** (Organize Pages · Numbering & Stamps · Tool Chest).

Keyboard: `Ctrl+O` open · `Ctrl+S` save · `Ctrl+Shift+S` save as · `Ctrl+P` print ·
`Ctrl+F` find · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `+ / − / 0` zoom (0 = 100%) ·
`← / →` page · **arrow keys** nudge the selected item (**Shift** = ×10) · `Esc`
cancel / close a modal / deselect · `Delete` remove selected. Press **`?`** (or
`F1`) any time — or **Help → Keyboard Shortcuts** on desktop — for the full list.

Zoom: trackpad **pinch-to-zoom** (macOS & Windows precision trackpads) and
**`Ctrl`/`Cmd` + scroll wheel** zoom toward the pointer.

**Multiple documents (tabs).** Open several PDFs at once — each opens in its own
tab; a tab bar appears once a second document is open. Opening a PDF (the toolbar
**Open**, drag-drop, the tab bar's **＋**, or an **"Open with" / Outlook
attachment**) adds a tab instead of replacing the current document, so nothing
clobbers your unsaved work. Each tab keeps its own pages, markups, measurements,
zoom, and undo history. Close a tab with its **✕** (or `Ctrl/Cmd+W`); you're
prompted if it has unsaved changes.

**Desktop (Windows / macOS)** adds a native **menu bar** — File · Edit · View ·
Window · Help — so every shortcut above is discoverable and works even when
focus is outside the page (on macOS the Edit menu also restores the standard
`Cmd+C/V/X/A` in text fields). **File → Open Recent** lists the last documents
you opened (also surfaced in the Windows Jump List and the macOS Dock), the
window **remembers its size, position and maximized state** between launches,
and **File → Print** (`Ctrl/Cmd+P`) renders the finished document — every
placement, markup and measurement baked in — to the system print dialog (which
can also save-as-PDF). Android exposes Print through its system print sheet.

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
  (`test/fixtures/`, regenerate with `npm run fixtures`) and asserts eleven
  scenarios: cold-start "Open with", warm document swap, trackpad/Ctrl-wheel
  zoom, virtualized rendering + find, all markup tools, page organize
  (reorder/rotate/delete/extract), numbering/watermark + form flatten, scaled
  measurements, editable annotations, overlay rendering, and PDF save/flatten.
- CI (`.github/workflows/ci.yml`) runs the unit tests on Linux/Windows/macOS and
  the E2E suite headlessly (xvfb) on every push and PR; the release workflow
  gates every build on the same tests. A local `scripts/prepush.sh` runs
  `npm run verify` — symlink it as a `pre-push` hook if you like.

## Build the Windows installer (`.exe`)

```bash
npm run dist          # x64  -> release/Field-Mark-Setup.exe
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
npm run dist:mac      # universal (Intel + Apple Silicon) -> release/FieldMark-<version>-universal.dmg (+ .zip)
```

The build is **unsigned** by default, so Gatekeeper will block a double-click the
first time — **right-click the app → Open → Open**, or run
`xattr -dr com.apple.quarantine "/Applications/FieldMark.app"`. To ship a signed +
notarized build, set these before `npm run dist:mac` (Apple Developer account
required): `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Both platforms register **FieldMark** as a handler for `.pdf` (Open With), and
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

- **A published release** — every version tag builds `FieldMark.apk` and
  attaches it to the GitHub Release (see [Publishing a release](#publishing-a-release-one-time-setup)).
  The **Download for Android** button above points at the latest release's APK.
- **A CI artifact** — every push and PR also builds a debug APK in CI
  (`.github/workflows/android.yml`) and uploads it as a workflow artifact
  (`fieldmark-debug-apk`); download it from the Actions run to sideload.

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

> The Android build is a **debug** APK, signed with the **committed, stable debug
> keystore** at `build/debug.keystore` (standard Android debug credentials).
> `build/inject-signing.js` writes an explicit `signingConfigs.debug` into the
> generated `android/app/build.gradle` pointing at that keystore, so every release
> is signed with the **same** key and installs as an **in-place update** over the
> previous version — no uninstall needed. (Copying the keystore to
> `~/.android/debug.keystore` is **not** enough: the CI runner's `setup-android`
> sets `ANDROID_USER_HOME`, so Gradle would otherwise auto-generate a fresh random
> debug key each build.) CI then runs `build/apk-cert-sha256.js` to **assert** the
> built APK's signing cert matches the keystore, failing the build on any drift.
> (It's a debug key with public credentials, so it provides no authenticity
> guarantee — the accepted trade-off for a sideloaded, offline app. **Not** a
> release key.)
>
> **One-time note (through v1.8.3):** earlier releases were each signed with a
> *different* auto-generated key, so upgrading from any build **≤ v1.8.3** to the
> first correctly-keyed build (**v1.8.4+**) needs a single uninstall/reinstall.
> Every update from v1.8.4 onward installs over the top.
>
> To publish to Google Play, generate a signed **release** build
> (`./gradlew bundleRelease` with a real release keystore held in GitHub Secrets)
> — out of scope for this repo's CI, which only produces a sideloadable debug APK.

## Build the iPad / iPhone app (TestFlight)

iOS is the **same Capacitor target as Android** — `cap add ios` wraps the exact
same self-contained `www/` bundle in a WKWebView, so the whole UI + PDF engine
ships to iPad for free. The only iOS-specific pieces are an opaque app icon
(`build/make-ios-icons.js`), a couple of `Info.plist` keys
(`build/patch-ios.js`), and the signing/upload lane (`fastlane/`). Like
`android/`, the generated `ios/` project is **git-ignored** and rebuilt from
config each run.

Distribution is via **TestFlight** — no public App Store release required, and
frequent builds land on your iPad in minutes with no per-build review. The whole
pipeline is automated: merging a PR to `main` triggers
`.github/workflows/ios.yml`, which builds, signs, and uploads a new TestFlight
build; the TestFlight app then delivers it as an update (so the in-app updater is
a no-op on iOS — see `checkUpdates` in `platform-web.js`).

**Prerequisites:** a Mac + Xcode for local builds; an Apple Developer account and
seven GitHub secrets for the automated pipeline. The full one-time setup and the
everyday loop are documented in **[`docs/ios-testflight.md`](docs/ios-testflight.md)**.

```bash
npm ci
npm run ios:add     # first time only: generate the native ios/ project (needs macOS)
npm run ios:open    # open in Xcode → Run on a simulator or a connected iPad
npm run ios:beta    # build + upload to TestFlight from your Mac (needs the Apple env vars)
```

Every push and PR also runs an **unsigned build-check** on a macOS CI runner to
keep the iOS port compiling — no secrets required.

## Publishing a release (one-time setup)

You don't need a Windows machine to publish — a GitHub Actions workflow
(`.github/workflows/release.yml`) builds the Windows installer, the macOS
`.dmg`/`.zip`, and the **Android `FieldMark.apk`** on their respective runners
and attaches all of them to a single GitHub Release. The **Download** buttons
above always point at the latest release's assets.

**To cut a release, push a version tag:**

```bash
# bump the "version" in package.json first (e.g. 1.0.0), then:
git tag v1.0.0
git push origin v1.0.0
```

The workflow publishes `Field-Mark-Setup.exe`, the macOS artifacts, and
`FieldMark.apk` as release `v1.0.0`. Within a few minutes the download buttons
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
│  ├─ icon.ico             # desktop app/installer icon (256x256)
│  ├─ make-icon.js         # regenerates the desktop icon (pure Node)
│  └─ make-android-icons.js# same artwork → Android launcher icons (legacy + adaptive)
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
│        ├─ organize.js    # Page Organizer: reorder/rotate/delete/insert/merge/extract
│        ├─ docstamp.js    # Bates numbering, header/footer, watermark (preview + export)
│        ├─ toolchest.js   # saved markup tools + reusable image stamps (Prefs-backed)
│        ├─ save.js        # pdf-lib export + coordinate mapping (+ form fill / flatten)
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
