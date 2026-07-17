'use strict';

/*
 * Assemble a hosted, installable Progressive Web App (dist-pwa/) from the same
 * self-contained bundle the Android WebView uses.
 *
 * Why this exists: the renderer is already a complete offline web app — the
 * cross-platform rule (CLAUDE.md) says only the file-I/O layer is platform
 * specific, and platform-web.js already implements it for a plain browser
 * (a file input to Open, a download to Save). So the *only* thing standing
 * between www/ and "an app you install on an iPhone/iPad/Android/desktop from
 * the browser, for free, with no App Store" is PWA packaging:
 *
 *   1. a web manifest (name, icons, standalone display, theme),
 *   2. a service worker that precaches the whole bundle so it runs fully
 *      offline (honoring the "no network at runtime" promise), and
 *   3. the iOS "Add to Home Screen" meta tags + apple-touch-icon.
 *
 * This step is deliberately kept OUT of build-web.js: that bundle is shared by
 * Capacitor, whose own WebView shouldn't register a page service worker. Here we
 * take build-web.js's output, copy it to dist-pwa/, and layer the PWA files on
 * top — leaving Electron and Capacitor completely untouched.
 *
 * Run: node scripts/build-pwa.js   (or `npm run build:pwa`)
 * Deploy: publish dist-pwa/ to any static HTTPS host (GitHub Pages workflow
 *         included at .github/workflows/pages.yml).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const OUT = path.join(ROOT, 'dist-pwa');
const pkg = require(path.join(ROOT, 'package.json'));

// Splash/status-bar tint — the app's dark "drafting table" base (tokens.css).
const THEME_COLOR = '#0e1621';
const BG_COLOR = '#0e1621';

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
// Every file under `dir`, as forward-slash paths relative to `dir` (for the
// service worker precache list — resolved against the SW scope at runtime, so
// they work under a GitHub Pages sub-path like /PDF-Reader/ too).
function walkRel(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRel(full, base, acc);
    else acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

// 1. Build the shared web bundle (www/). Run it as a child so build-web.js's
//    top-level side effects stay isolated and any error surfaces verbatim.
console.log('[build-pwa] building shared web bundle (www/) …');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web.js')], { stdio: 'inherit' });

// 2. Copy www/ -> dist-pwa/.
console.log('[build-pwa] output ->', OUT);
rmrf(OUT);
copyDir(WWW, OUT);

// 3. Icons (any + maskable + apple-touch), generated from the shared artwork.
execFileSync(process.execPath, [path.join(ROOT, 'build', 'make-pwa-icons.js'), path.join(OUT, 'icons')], { stdio: 'inherit' });

// 4. Web manifest. Relative start_url/scope + relative icon paths keep it valid
//    whether the app is served from a domain root or a project sub-path.
const manifest = {
  name: 'FieldMark — PDF markup, measure & sign',
  short_name: 'FieldMark',
  description: pkg.description,
  id: './',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  background_color: BG_COLOR,
  theme_color: THEME_COLOR,
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
};
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// 5. Service worker registration (a separate file, because the bundle's CSP is
//    script-src 'self' — no inline scripts allowed).
fs.writeFileSync(path.join(OUT, 'register-sw.js'),
  "'use strict';\n" +
  "// Register the offline service worker. Best-effort: the app works without it\n" +
  "// (just not offline), so a failure here is silent.\n" +
  "if ('serviceWorker' in navigator) {\n" +
  "  window.addEventListener('load', function () {\n" +
  "    navigator.serviceWorker.register('sw.js').catch(function () { /* offline unavailable */ });\n" +
  "  });\n" +
  "}\n", 'utf8');

// 6. Service worker: precache the whole bundle for full offline use. The list is
//    generated now, after every asset (incl. icons + manifest) is in place.
const assets = walkRel(OUT).filter((p) => p !== 'sw.js' && p !== 'register-sw.js');
// './' is the start_url the browser actually navigates to; cache it explicitly
// so a cold offline launch resolves to index.html.
const precache = ['./'].concat(assets);
const sw =
  "'use strict';\n" +
  "// FieldMark offline service worker — generated by scripts/build-pwa.js.\n" +
  "// Cache-first for same-origin assets so the app runs with no network at all\n" +
  "// (matching the desktop/Android 'offline, no telemetry' promise). Cross-origin\n" +
  "// requests (e.g. the optional GitHub update check) are left to the network and\n" +
  "// simply fail gracefully when offline.\n" +
  'const CACHE = ' + JSON.stringify('fieldmark-pwa-v' + pkg.version) + ';\n' +
  'const ASSETS = ' + JSON.stringify(precache) + ';\n' +
  '\n' +
  "self.addEventListener('install', (e) => {\n" +
  '  e.waitUntil(\n' +
  '    caches.open(CACHE)\n' +
  '      .then((c) => Promise.all(ASSETS.map((a) => c.add(new Request(new URL(a, self.registration.scope), { cache: \'reload\' })).catch(() => {}))))\n' +
  '      .then(() => self.skipWaiting())\n' +
  '  );\n' +
  '});\n' +
  '\n' +
  "self.addEventListener('activate', (e) => {\n" +
  '  e.waitUntil(\n' +
  '    caches.keys()\n' +
  '      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))\n' +
  '      .then(() => self.clients.claim())\n' +
  '  );\n' +
  '});\n' +
  '\n' +
  "self.addEventListener('fetch', (e) => {\n" +
  '  const req = e.request;\n' +
  "  if (req.method !== 'GET') return;\n" +
  '  const url = new URL(req.url);\n' +
  '  if (url.origin !== self.location.origin) return; // let cross-origin pass to network\n' +
  '  e.respondWith(\n' +
  '    caches.match(req).then((hit) => hit || fetch(req).then((res) => {\n' +
  '      const copy = res.clone();\n' +
  '      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});\n' +
  '      return res;\n' +
  '    }).catch(() => {\n' +
  "      // Offline navigation fallback: serve the app shell.\n" +
  "      if (req.mode === 'navigate') return caches.match(new URL('index.html', self.registration.scope).href);\n" +
  '      return Response.error();\n' +
  '    }))\n' +
  '  );\n' +
  '});\n';
fs.writeFileSync(path.join(OUT, 'sw.js'), sw, 'utf8');

// 7. Patch index.html: manifest link, theme-color, iOS home-screen meta tags,
//    apple-touch-icon, and the SW registration script.
const htmlPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

const head =
  '\n  <link rel="manifest" href="manifest.webmanifest" />' +
  '\n  <meta name="theme-color" content="' + THEME_COLOR + '" />' +
  '\n  <meta name="mobile-web-app-capable" content="yes" />' +
  '\n  <meta name="apple-mobile-web-app-capable" content="yes" />' +
  '\n  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />' +
  '\n  <meta name="apple-mobile-web-app-title" content="FieldMark" />' +
  '\n  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />\n';
if (!html.includes('rel="manifest"')) {
  html = html.replace(/<\/head>/, head + '</head>');
}
if (!html.includes('register-sw.js')) {
  html = html.replace(/<\/body>/, '  <script src="register-sw.js"></script>\n</body>');
}
fs.writeFileSync(htmlPath, html, 'utf8');

// 8. GitHub Pages serves the bundle as-is (no Jekyll processing needed).
fs.writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf8');

console.log('[build-pwa] done. Installable PWA is self-contained at dist-pwa/ (' + assets.length + ' precached assets).');
