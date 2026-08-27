# Build Plan — Marketing site + in-app feedback link

Phase 3. Source: `specs/feature-marketing-site-spec.md`.

## Stack decision

None to make. Existing conventions govern:

- Plain HTML + CSS, **no bundler, no framework, no new npm dependency**.
- Node CommonJS build scripts under `scripts/`, matching `build-pwa.js` style
  (`'use strict'`, top-of-file rationale comment, `console.log('[tag] …')`).
- Renderer code hangs off the global `App` object; no ES modules.
- `react-best-practices` is not applicable here; its generic `js-*` rules are.

## Architecture

```
site/                      NEW — landing page source
  index.html               the page
  styles.css               drafting-table palette, self-contained
  CNAME                    OPTIONAL, absent for now (FR A-4)

scripts/build-site.js      NEW — orchestrates the published tree
  1. run build-pwa.js  -> dist-pwa/            (existing behaviour)
  2. move dist-pwa/*   -> dist-pwa/app/        (relocation, FR C-1)
  3. copy site/*       -> dist-pwa/            (landing at root, FR A-1)
  4. copy docs/screenshots/* -> dist-pwa/img/  (FR A-6)
  5. .nojekyll, 404.html, app.html redirect    (FR A-3, A-5, C-2)
  6. CNAME if present                          (FR A-4)

dist-pwa/                  PUBLISHED ARTIFACT
  index.html   404.html   app.html   styles.css   img/   .nojekyll  [CNAME]
  app/  index.html manifest.webmanifest sw.js register-sw.js icons/ js/ …
```

The relocation happens **after** `build-pwa.js` finishes, so that script needs no
edit and the PWA bundle stays byte-identical (FR A-2, regression boundary #4).

## Work orders

### WO-1 — frontend-agent — `site/` landing page
**Files:** `site/index.html`, `site/styles.css`
**Covers:** FR B-1 … B-9
- Semantic HTML: `header`, `main`, `section`, `footer`. One `h1`.
- Hero: name, one-sentence positioning, primary CTA → `app/`, secondary → downloads.
- Sections: instant-try, feature grid, screenshot gallery, comparison, privacy, install/download, FAQ, footer.
- CSS: custom properties mirroring `tokens.css` semantics; `:root` light,
  `@media (prefers-color-scheme: dark)` overrides; grid/flex; `max-width:100%`
  on images; no horizontal overflow at 320px.
- No inline `<script>`, no web fonts, no external assets — matches the offline
  ethos and keeps the page trivially cacheable.
- Download links use `https://github.com/Killswit3h/PDF-Reader/releases/latest/download/<asset>`
  with asset names taken from the release: `Field-Mark-Setup.exe`, the macOS
  `.dmg`, `FieldMark.apk`.

### WO-2 — frontend-agent — `scripts/build-site.js`
**Files:** `scripts/build-site.js`, `package.json` (scripts only)
**Covers:** FR A-1 … A-6, C-2
- Reuse the `rmrf` / `copyDir` helpers' shape from `build-pwa.js`.
- Add `"build:site"` and `"verify:site"` npm scripts. Leave `build:pwa` /
  `verify:pwa` working standalone.
- Screenshot manifest is an explicit list so a missing file fails loudly (FR A-6).

### WO-3 — frontend-agent — verifier update
**Files:** `scripts/verify-pwa.js`
**Covers:** AC-1, AC-2, AC-3, AC-4, AC-5
- Introduce an `APP` root (`dist-pwa/app`) for every existing PWA assertion.
- Add landing-page assertions: root `index.html` exists, links `app/`, has ≥3
  `releases/latest/download/` links, `404.html` present, `.nojekyll` at root,
  `img/` populated, CNAME copied iff `site/CNAME` exists.
- Keep the existing `ok()` / failure-count / exit-code contract intact.

### WO-4 — frontend-agent — in-app demo drawing
**Files:** `src/renderer/index.html`, `src/renderer/js/app.js`,
`scripts/build-site.js` (ships the sample), `src/renderer/styles/*` as needed
**Covers:** FR D-1 … D-4
- Empty-state button, hidden by default; revealed only when `window.api` came
  from the web adapter (Electron sets its own `window.api` via preload, so gate
  on the absence of the Electron-only marker rather than sniffing platform).
- Handler: `fetch('demo/sample.pdf')` → `arrayBuffer()` → `App.Viewer.load(buf,
  'FieldMark-Sample-Plan.pdf')`, wrapped in try/catch → existing toast on failure.
- `build-site.js` copies `test/fixtures/sample.pdf` to `dist-pwa/app/demo/`.

### WO-5 — frontend-agent — Help-menu feedback item
**Files:** `src/renderer/index.html`, `src/renderer/js/app.js`
**Covers:** FR E-1 … E-5
- New `button[data-help="feedback"]` after the shortcuts item, reusing an
  existing `<symbol>` icon.
- Extend the existing `if/else` chain in `setupHelpMenu` — no restructuring.
- Build the issue URL with `encodeURIComponent`; body carries version, platform,
  user-agent. Call `window.api.openExternal(url).catch(() => {})`.

### WO-6 — security-agent review
**Covers:** the whole diff
Reduced surface per CLAUDE.md (offline app, no server). Focus:
- The feedback URL is constructed from **app-local values only** — never from
  document content or a filename — so no user data leaks into a URL.
- `encodeURIComponent` applied to every interpolated segment.
- The demo fetch is same-origin and relative; it cannot be redirected off-origin
  under the renderer CSP.
- Landing page has no third-party origins, no analytics, no inline script.
- Confirm no secret, path, or email address is embedded in `site/`.

### WO-7 — E2E coverage
**Files:** `src/main.js`, `test/e2e/run.js`
**Covers:** AC-8, AC-9
- New `SMOKE_SITE` scenario, additive, following the `SMOKE_MENU` shape.
- Assert: the Help menu contains a feedback item; clicking it resolves an
  `openExternal` URL matching `github.com/.+/issues/new`; the demo button is
  **absent** in Electron.
- Stub `window.api.openExternal` inside the scenario to capture the URL rather
  than actually launching a browser on the CI runner.

### WO-8 — docs
**Files:** `README.md`, `docs/pwa-hosting.md`, `specs/backlog.md`
- Document the published layout, `npm run build:site`, and how to add a domain.

## Integration contract

**New published paths:** `/` (landing), `/app/` (PWA), `/404.html`, `/app.html`,
`/img/*`, `/app/demo/sample.pdf`.

**Changed npm scripts:** `+build:site`, `+verify:site`. `build:pwa`/`verify:pwa`
retained.

**Changed CI:** `pages.yml` runs `npm run verify:site` and uploads `dist-pwa` (path
unchanged, contents restructured).

**Existing behaviours that must still pass** (regression boundary, spec §):
`npm test`, `npm run test:e2e`, `npm run verify:web`, unchanged `www/`, unchanged
`window.api`, unchanged Electron empty state and Help-menu ordering, untouched
`release.yml`.

## Sequencing

WO-2 → WO-1 → WO-3 (build pipeline before content before verifier)
WO-4 ∥ WO-5 (independent renderer edits)
WO-7 after WO-4/WO-5. WO-6 reviews as code lands. WO-8 last.

## Commits

Conventional Commits, one per work order, each referencing its FR range. Branch
`feat/marketing-site` off `main`. Draft PR on PASS — **never merge to `main`**
(CLAUDE.md overrides git-workflow's merge step).
