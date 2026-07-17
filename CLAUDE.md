# CLAUDE.md

Guidance for AI assistants (and humans) working in this repo.

## Golden workflow rule — always branch for new features

- **Never commit new features directly to `main`.** Every feature (or non-trivial
  change) goes on its own **branch** and lands via a **pull request**.
- Open the PR as a **draft** unless told otherwise; let the maintainer merge it.
- **After a branch's PR is merged, start fresh from the latest `main`** for the
  next piece of work — do not stack new commits on already-merged history
  (`git fetch origin main && git checkout -B <branch> origin/main`).
- Only `main` is the source of truth; keep it releasable.

## What this project is

An **offline** PDF viewer / markup / measure / sign tool that ships on **Windows,
macOS (Electron)** and **Android (Capacitor)**. No cloud, no telemetry, no
network at runtime.

## The cross-platform rule (read before adding features)

**Android runs the desktop renderer verbatim.** `scripts/build-web.js` bundles
`src/renderer/` + `src/shared/` into a self-contained `www/` that Capacitor loads
in a WebView. The only platform-specific layer is file I/O, behind the
`window.api` contract.

- **Renderer-only features** (live in `src/renderer/js/` + `src/shared/`, draw on
  the page overlay, export via pdf-lib in `save.js`) ship to all three platforms
  for free — **prefer these**.
- **Features needing a new capability** across the file-I/O boundary: add **one**
  method to *both* `src/preload.js` (Electron) and
  `src/renderer/js/platform-web.js` (Capacitor/web), keeping the contract
  identical. Never branch on platform inside app modules.
- See `docs/feature-research.md` for the full feasibility model and a ranked
  backlog.

## Architecture pointers

- Geometry (placements/markups/measurements) is stored in **scale-1 viewport
  points, top-left origin**, and exported to PDF user space via PDF.js's
  `viewport.convertToPdfPoint` — this handles page rotation correctly. Don't
  hand-roll the Y-flip. (`src/renderer/js/save.js`, and the README's
  "Coordinate-mapping approach".)
- App modules hang off a global `App` object (no bundler); shared pure logic in
  `src/shared/` has a dual Node/browser export and is unit-tested.
- Key modules: `viewer.js` (PDF.js), `placement.js`, `markup.js`, `measure.js`,
  `organize.js` (page organizer), `docstamp.js` (numbering/watermark),
  `toolchest.js`, `save.js` (pdf-lib export + form fill/flatten).

## Testing — run before pushing

```bash
npm test          # vitest unit tests over src/shared (fast, no Electron)
npm run test:e2e  # headless Electron smoke suite (SMOKE_* harness in main.js)
npm run verify    # both — the pre-push gate
npm run verify:web # build www/ + drive it in headless Chromium (Android WebView parity)
```

- For a **new renderer feature**, add a `SMOKE_*` scenario in `src/main.js` and a
  matching assertion in `test/e2e/run.js` so CI covers it on real Electron across
  Linux/Windows/macOS.
- `npm run verify:web` is the fastest way to exercise renderer-only logic without
  Electron (it runs the same engine the Android WebView uses).

## Releases

Bump `version` in `package.json` and commit that to `main`, then kick the
**Build & Release** workflow. It gates on the tests, then builds and publishes
the Windows `.exe`, macOS `.dmg`/`.zip`, and Android `.apk` to a single GitHub
Release. The README download buttons and the in-app update check point at the
latest release automatically.

Two ways to start the build:

- **Preferred (works everywhere, incl. Claude Code web sessions):** run the
  workflow via `workflow_dispatch` (Actions tab → *Build & Release* → *Run
  workflow* on `main`, or `gh workflow run release.yml --ref main`). With no tag,
  the publish step derives `vX.Y.Z` from `package.json` and **creates the tag
  itself** with the runner's `GITHUB_TOKEN` (pinned to the release commit via
  `target_commitish`).
- **Push a tag `vX.Y.Z`** — fine locally, but **note:** in the Claude Code remote
  environment the session git remote is a scoped broker that allows branch pushes
  but **rejects tag pushes with a 403**. From those sessions, always use
  `workflow_dispatch` above — don't try to `git push` a tag.
</content>
