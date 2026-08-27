# Spec — Marketing site + in-app feedback link

Phase 2. The contract every later phase is checked against.
Source: `specs/feature-marketing-site-brief.md`.

## Summary

Publish a landing page at the root of the GitHub Pages deploy, move the live PWA
to `/app/`, and add two renderer-only affordances to the app itself: a "Try the
demo" sample-drawing loader and a "Send feedback" Help-menu item.

## Scope boundary

### In scope
- New `site/` source folder (landing page, stylesheet, optional `CNAME`).
- New `scripts/build-site.js` that assembles `dist-pwa/` as `site/` at the root
  plus the PWA under `app/`.
- `scripts/verify-pwa.js` updated for the new layout + landing-page assertions.
- `.github/workflows/pages.yml` updated to run the site build.
- Renderer: Help-menu "Send feedback" item; demo-drawing loader on the empty state.
- One new `SMOKE_*` E2E scenario covering the two renderer additions.
- README/docs updates describing the new layout.

### Explicitly out of scope
- Buying or configuring a domain (support the file; do not pick a name).
- Analytics of any kind.
- Renaming the repo or the npm package.
- Moving hosts off GitHub Pages.
- Any change to Electron packaging, Capacitor, or the Android/iOS builds.
- Blog, CMS, or any server-side component.

## Functional requirements (EARS)

### A — Site build

**FR A-1** The system shall provide `npm run build:site`, which produces
`dist-pwa/` containing the landing page at the root and the complete PWA bundle
under `dist-pwa/app/`.

**FR A-2** When `scripts/build-site.js` runs, the system shall invoke the
existing `scripts/build-pwa.js` unmodified in its contract, so the PWA bundle is
byte-identical to what it produces today apart from its location.

**FR A-3** The system shall write `.nojekyll` at the `dist-pwa/` root so GitHub
Pages serves the tree verbatim.

**FR A-4** Where a file `site/CNAME` exists, the system shall copy it to
`dist-pwa/CNAME`. Where it does not exist, the build shall succeed without it.

**FR A-5** The system shall emit `dist-pwa/404.html` that resolves to the landing
page, so unknown paths on the published site do not show GitHub's default 404.

**FR A-6** The system shall copy the screenshots the landing page references from
`docs/screenshots/` into `dist-pwa/img/`, and shall fail the build with a clear
message if a referenced screenshot is missing.

### B — Landing page content

**FR B-1** The landing page shall state, above the fold, what FieldMark is and
that it is free, offline, and requires no account.

**FR B-2** The landing page shall present a primary call to action linking to
`app/` labelled as an in-browser trial requiring no installation, ranked visually
above the download links.

**FR B-3** The landing page shall present download links for Windows, macOS and
Android that resolve through the GitHub `releases/latest/download/` alias, so
they never need editing on a release.

**FR B-4** The landing page shall include a comparison section positioning
FieldMark against paid subscription PDF markup tools, naming the capability
overlap (markup, measurement, takeoff, stamping, signing) without making claims
about a competitor's current pricing or features.

**FR B-5** The landing page shall render correctly at viewport widths from 320px
to 2560px with no horizontal page scroll.

**FR B-6** The landing page shall honour `prefers-color-scheme` and shall define
explicit background and foreground colours in both light and dark.

**FR B-7** The landing page shall reuse the "drafting table" identity from
`src/renderer/styles/tokens.css` — blueprint-blue accent, graphite base, system
font stack — without importing the app's stylesheet or adding a web font.

**FR B-8** The landing page shall state the privacy position explicitly: the app
performs no network calls at runtime and collects no telemetry.

**FR B-9** The landing page shall link to the GitHub repository, the issue
tracker, and the releases page.

### C — App relocation

**FR C-1** The published PWA shall be installable and fully functional when
served from the `app/` sub-path, on both a project sub-path host
(`…/PDF-Reader/app/`) and a domain root (`…/app/`).

**FR C-2** The system shall publish a redirect stub at `dist-pwa/app.html` and
honour a legacy entry so that a visitor who bookmarked the previous app URL
reaches the app rather than a dead page.

**FR C-3** The service worker's precache list shall continue to resolve against
its own registration scope, with no absolute paths introduced.

### D — In-app demo drawing

**FR D-1** When no document is open and the app is running from the web/PWA
build, the empty state shall offer an action that opens a bundled sample drawing.

**FR D-2** When the user activates that action, the system shall fetch the sample
from a same-origin path and load it via `App.Viewer.load`, producing the same
state as opening that file from disk.

**FR D-3** If the sample cannot be fetched, the system shall surface the existing
failure-toast path and leave the empty state usable.

**FR D-4** The demo action shall not appear in the Electron desktop build, where
the native Open dialog is the correct entry point.

### E — In-app feedback link

**FR E-1** The Help menu shall contain a "Send feedback" item, placed after the
existing tour and shortcuts items.

**FR E-2** When activated, the system shall call `window.api.openExternal` with a
GitHub "new issue" URL for this repository.

**FR E-3** The URL shall carry a prefilled body containing the app version, the
platform, and the user-agent, so a report arrives with diagnostics attached.

**FR E-4** The feedback item shall be available with no document open, matching
the rest of the Help menu.

**FR E-5** The system shall not add any method to the `window.api` contract; it
shall use the existing `openExternal` on both the Electron and web adapters.

## Acceptance criteria (Given/When/Then)

**AC-1** Given a clean checkout, when `npm run build:site` runs, then
`dist-pwa/index.html` is the landing page, `dist-pwa/app/index.html` is the app,
and `dist-pwa/app/manifest.webmanifest` is valid JSON with `display: standalone`.

**AC-2** Given the built tree, when `npm run verify:pwa` runs, then every check
passes and the process exits 0.

**AC-3** Given `site/CNAME` does not exist, when the build runs, then it
completes successfully and `dist-pwa/CNAME` is absent.

**AC-4** Given `site/CNAME` exists, when the build runs, then `dist-pwa/CNAME`
matches it byte for byte.

**AC-5** Given the landing page, when it is parsed, then it contains a link whose
target is `app/` and at least three `releases/latest/download/` links.

**AC-6** Given the landing page rendered at 320px width, when measured, then
`document.documentElement.scrollWidth` does not exceed the viewport width.

**AC-7** Given the app running in the web build with no document open, when the
demo action is activated, then a document loads and `App.state.numPages` is
greater than zero.

**AC-8** Given the app running in Electron, when the Help menu is opened, then a
"Send feedback" item is present and its activation calls `openExternal` with a
URL matching `github.com/.+/issues/new`.

**AC-9** Given the Electron build, when the empty state renders, then no demo
action is present.

**AC-10** Given the whole change, when `npm run verify` runs, then unit and E2E
suites pass with no new failures.

## Error handling

| Condition | Behaviour | Surface |
|---|---|---|
| Referenced screenshot missing at build time | Build exits non-zero naming the file | stderr, CI fails |
| `www/` build fails inside `build-pwa.js` | Error propagates verbatim; `dist-pwa/` is not left half-written | stderr, CI fails |
| Demo PDF fetch fails (offline, 404) | Existing toast: "Couldn't open the sample drawing." Empty state stays interactive | in-app toast |
| Demo PDF parses but is corrupt | Existing `Viewer.load` failure path, unchanged | in-app toast |
| `openExternal` rejects or is absent | Caught; no unhandled rejection; menu closes normally | silent, console only |
| `site/CNAME` present but empty | Copied as-is; Pages ignores it. Not a build error | none |

## Regression boundary — what must NOT change

These are verified explicitly in Phase 5:

1. **Electron desktop behaviour** — `npm run verify` (unit + E2E) passes
   unchanged. No file under `src/main.js`'s packaging path is touched except the
   additive `SMOKE_*` scenario.
2. **The `window.api` contract** — `src/preload.js` and
   `src/renderer/js/platform-web.js` gain no methods.
3. **`scripts/build-web.js` output** — `www/` is unchanged, so Capacitor/Android
   and `npm run verify:web` behave exactly as before.
4. **The PWA bundle contents** — `build-pwa.js` still produces the same manifest,
   service worker, icons and iOS meta tags; only the destination directory moves.
5. **Existing Help-menu items** — the tour and shortcuts entries keep their
   labels, order relative to each other, and behaviour.
6. **The empty state in Electron** — visually and behaviourally unchanged.
7. **Release workflow** — `.github/workflows/release.yml` is untouched.

## Deferred to `specs/backlog.md`

- Repo/package rename to FieldMark.
- Purchasing a domain and populating `site/CNAME`.
- Evaluating Cloudflare Pages if OCR needs COOP/COEP cross-origin isolation.
- Privacy-respecting analytics on the landing page only.
- `tour.js` `NOTES.rev` bump for the What's-New card.
