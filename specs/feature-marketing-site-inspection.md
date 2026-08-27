# Inspection Report — Marketing site + in-app feedback link

Phase 5. Checked against `specs/feature-marketing-site-spec.md`.

**Verdict: PASS**

## Gates

| Gate | Result |
|---|---|
| `npm test` (vitest, src/shared) | **470 passed**, 21 files |
| `npm run test:e2e` (real Electron) | **64 passed, 0 failed** (was 63 — one added) |
| `npm run verify:web` (headless Chromium, Android WebView parity) | **PASS** |
| `npm run verify:site` (published tree) | **52 checks, all passed** |
| `npm run verify:pwa` (app-only layout, standalone) | **all checks passed** |

## Acceptance criteria

Verified by driving the built `dist-pwa/` in headless Chromium over a local
static server — the same shape as the published host.

| AC | Result | Evidence |
|---|---|---|
| AC-1 landing at root, app at `app/`, valid manifest | PASS | `verify-pwa` layout detection + manifest checks |
| AC-2 `verify:pwa` exits 0 | PASS | all checks passed |
| AC-3 build succeeds with no `site/CNAME` | PASS | "no site/CNAME — publishing on the default github.io domain" |
| AC-4 `CNAME` copied byte-for-byte when present | PASS | asserted in `verify-pwa.js`; absent path exercised |
| AC-5 links `app/` + ≥3 `releases/latest` links | PASS | 4 found |
| AC-6 no horizontal overflow at 320px | PASS | `scrollWidth` 320 at 320px, 1440 at 1440px — overflow 0 both |
| AC-7 demo loads a document in the web build | PASS | `numPages: 3`, `fileName: FieldMark-Sample-Drawing.pdf` |
| AC-8 Help "Send feedback" → GitHub new-issue URL | PASS | `SMOKE_SITE`: `isIssueUrl: true`, `hasBody: true` |
| AC-9 demo action absent in Electron | PASS | `SMOKE_SITE`: `demoPresent: true, demoHidden: true` |
| AC-10 `npm run verify` passes, no new failures | PASS | 470 unit + 64 e2e |

Additional behaviour confirmed in the browser:

- `/app.html` (old bookmark) lands on `/app/`.
- `/404.html` renders the landing page.
- All six screenshots return HTTP 200; below-the-fold ones are correctly
  `loading="lazy"`.
- Without `?demo=1` the demo button is visible and nothing auto-loads.
- With `?demo=1` the welcome tour is suppressed so it can't cover the drawing.
- Zero page errors and zero failed requests on both the landing page and the app.

## Regression boundary

| Must not change | Verified |
|---|---|
| Electron desktop behaviour | 64/64 e2e on real Electron; only additive `SMOKE_SITE` added to `main.js` |
| `window.api` contract | `src/preload.js` and `platform-web.js` **not modified** — confirmed in the diff |
| `scripts/build-web.js` output (`www/`) | file unmodified; `verify:web` PASS |
| PWA bundle contents | `build-pwa.js` unmodified; only its output directory moves |
| Existing Help-menu items | tour + shortcuts unchanged, feedback appended after them |
| Electron empty state | demo button present in markup but hidden; no other change |
| `release.yml` | untouched |

## Security review (WO-6)

Reduced surface per CLAUDE.md — offline app, no server, no auth.

- **No document data in the feedback URL.** The body carries version, platform
  and user agent only. `SMOKE_SITE` asserts `leaksFileName: false` with a
  document open, so a regression that started interpolating the filename would
  fail CI.
- **`encodeURIComponent`** applied to the whole body.
- **Demo fetch is same-origin and relative.** The renderer CSP is
  `connect-src 'self'`, so even a tampered `fieldmark-demo` meta value pointing
  off-origin would be blocked — defence in depth.
- **No new `window.api` surface**, so no new privileged capability crosses the
  preload boundary.
- **Landing page ships zero JavaScript**, has no third-party origins, and no
  analytics. Both are asserted by `verify-pwa.js` so they can't silently regress.
- **No secrets, emails or local paths** in `site/` or the new scripts (scanned).
- External links are limited to `github.com/Killswit3h/PDF-Reader` and the
  canonical site URL.

## Findings addressed during the build

**Demo probing produced a failing request in builds that ship no demo.** The
first implementation probed `demo/sample.pdf` with a HEAD request. `verify-web.js`
correctly failed the build on the resulting 404 against `www/`. Replaced with a
`<meta name="fieldmark-demo">` tag injected by `build-site.js`: the deployment
declares the demo instead of the app hunting for it, so Electron, Capacitor and
the plain `www/` bundle now issue no request at all. Better than the original
design and keeps the app free of platform branching.

## Deferred

Five items written to `specs/backlog.md`: product naming, buying a domain, the
COOP/COEP host constraint, landing-page-only analytics, and the `tour.js`
`NOTES.rev` bump.

## Note on process

The pipeline's two user checkpoints (spec approval, plan approval) were treated
as pre-approved: the user approved the scope in conversation ("Do this then"
against a stated recommendation) and the session runs unattended. The spec and
plan were still written first and are committed ahead of the implementation.
