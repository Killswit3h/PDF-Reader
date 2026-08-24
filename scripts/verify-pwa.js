'use strict';

/*
 * Sanity-check the published bundle. Fast, no browser — asserts the pieces a
 * browser needs to treat the app as an installable, offline PWA are actually
 * present and internally consistent. Mirrors the shape of verify-web.js /
 * verify-rotate.js.
 *
 * Handles both published layouts, because both builds are still supported:
 *
 *   npm run verify:pwa    build-pwa.js  -> dist-pwa/       is the app
 *   npm run verify:site   build-site.js -> dist-pwa/app/   is the app,
 *                                          dist-pwa/       is the landing page
 *
 * The app-bundle checks are identical either way; the landing-page checks only
 * run when a landing page is actually there. That keeps `build:pwa` usable on
 * its own (e.g. to test the app bundle in isolation) without this verifier
 * failing for a marketing page it was never asked to produce.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-pwa');
const pkg = require(path.join(ROOT, 'package.json'));

// The app lives under app/ in the full-site layout, at the root otherwise.
const APP = fs.existsSync(path.join(OUT, 'app', 'index.html')) ? path.join(OUT, 'app') : OUT;
const FULL_SITE = APP !== OUT;

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  ok  ' : ' FAIL ') + msg);
  if (!cond) failures++;
}
function exists(rel) { return fs.existsSync(path.join(APP, rel)); }
function read(rel) { return fs.readFileSync(path.join(APP, rel), 'utf8'); }
function rootExists(rel) { return fs.existsSync(path.join(OUT, rel)); }
function rootRead(rel) { return fs.readFileSync(path.join(OUT, rel), 'utf8'); }

console.log('[verify-pwa] checking', OUT);
console.log('[verify-pwa] layout:', FULL_SITE ? 'landing page at /, app at /app/' : 'app at /');

/* ------------------------------ app bundle ------------------------------ */

// Core files.
ok(exists('index.html'), 'app index.html present');
ok(exists('manifest.webmanifest'), 'manifest.webmanifest present');
ok(exists('sw.js'), 'sw.js present');
ok(exists('register-sw.js'), 'register-sw.js present');
ok(exists('.nojekyll'), '.nojekyll present (GitHub Pages)');

// Manifest is valid and complete.
let manifest = null;
try { manifest = JSON.parse(read('manifest.webmanifest')); ok(true, 'manifest is valid JSON'); }
catch (e) { ok(false, 'manifest is valid JSON — ' + e.message); }
if (manifest) {
  ok(manifest.display === 'standalone', "manifest display is 'standalone'");
  ok(typeof manifest.start_url === 'string' && manifest.start_url.length > 0, 'manifest has start_url');
  ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'manifest declares >=2 icons');
  const hasMaskable = (manifest.icons || []).some((i) => /maskable/.test(i.purpose || ''));
  ok(hasMaskable, 'manifest declares a maskable icon');
  ok(!!manifest.theme_color, 'manifest has theme_color');
  // Every declared icon file actually exists.
  for (const icon of manifest.icons || []) ok(exists(icon.src), 'icon file exists: ' + icon.src);
  // Relative start_url/scope are what let the same bundle work at a domain root,
  // a project sub-path, and now a sub-directory of either. An absolute path here
  // would silently break the /app/ relocation.
  ok(!String(manifest.start_url).startsWith('/'), 'manifest start_url is relative (sub-path safe)');
  ok(!String(manifest.scope || './').startsWith('/'), 'manifest scope is relative (sub-path safe)');
}

// iOS install requirements in the HTML.
const html = read('index.html');
ok(/rel="manifest"/.test(html), 'app index.html links the manifest');
ok(/apple-mobile-web-app-capable/.test(html), 'app index.html has apple-mobile-web-app-capable');
ok(/rel="apple-touch-icon"/.test(html), 'app index.html links an apple-touch-icon');
ok(/register-sw\.js/.test(html), 'app index.html registers the service worker');
ok(exists('icons/apple-touch-icon.png'), 'apple-touch-icon.png present');

// Service worker precaches the real bundle (index + a vendored lib), so a cold
// offline launch has everything it needs.
const sw = read('sw.js');
ok(sw.includes('fieldmark-pwa-v' + pkg.version), 'sw cache version tracks package.json');
ok(/"index\.html"/.test(sw) || /'index\.html'/.test(sw), 'sw precache includes index.html');
ok(/pdf\.worker\.min\.js/.test(sw), 'sw precache includes the PDF.js worker');
ok(!/"sw\.js"/.test(sw), 'sw does not precache itself');

/* ---------------------------- landing page ------------------------------ */

if (FULL_SITE) {
  ok(rootExists('index.html'), 'landing index.html present at the site root');
  ok(rootExists('styles.css'), 'landing styles.css present');
  ok(rootExists('.nojekyll'), '.nojekyll present at the site root');
  ok(rootExists('404.html'), '404.html present (unknown paths fall back to the page)');
  ok(rootExists('app.html'), 'app.html redirect stub present (old bookmarks)');

  const landing = rootRead('index.html');

  // The primary conversion path: an in-browser trial ahead of any download.
  ok(/href="app\/(\?[^"]*)?"/.test(landing), 'landing links the app at app/');
  ok(/app\/\?demo=1/.test(landing), 'landing has a demo call to action (app/?demo=1)');

  // Download links must resolve through the releases/latest alias so they never
  // need editing when a version ships.
  const latest = (landing.match(/releases\/latest/g) || []).length;
  ok(latest >= 3, 'landing has >=3 releases/latest links (found ' + latest + ')');
  ok(/releases\/latest\/download\/Field-Mark-Setup\.exe/.test(landing), 'landing links the Windows installer');
  ok(/releases\/latest\/download\/FieldMark\.apk/.test(landing), 'landing links the Android APK');

  // No third-party origins, no scripts: the page is static by design and the
  // privacy claim it makes has to be true of the page itself.
  ok(!/<script/i.test(landing), 'landing ships no <script> (static, no analytics)');
  const offOrigin = (landing.match(/https?:\/\/(?!github\.com|killswit3h\.github\.io)[^"' )]+/gi) || []);
  ok(offOrigin.length === 0, 'landing references no third-party origins' +
     (offOrigin.length ? ' — found ' + offOrigin.slice(0, 3).join(', ') : ''));

  // Basic page hygiene.
  ok(/<title>[^<]+<\/title>/.test(landing), 'landing has a <title>');
  ok(/name="description"/.test(landing), 'landing has a meta description');
  ok(/<html lang="/.test(landing), 'landing declares a language');

  // Every screenshot the page references was actually copied in.
  const imgs = [...landing.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  ok(imgs.length > 0, 'landing references at least one screenshot');
  for (const src of imgs) {
    if (/^(https?:|data:)/.test(src)) continue;
    ok(rootExists(src), 'landing image resolves: ' + src);
  }

  // The demo drawing behind the hero CTA.
  ok(exists('demo/sample.pdf'), 'demo drawing present at app/demo/sample.pdf');

  // CNAME is optional, but if site/CNAME exists it must have been published.
  const srcCname = path.join(ROOT, 'site', 'CNAME');
  if (fs.existsSync(srcCname)) {
    ok(rootExists('CNAME'), 'CNAME published (site/CNAME exists)');
    if (rootExists('CNAME')) {
      ok(rootRead('CNAME').trim() === fs.readFileSync(srcCname, 'utf8').trim(), 'CNAME matches site/CNAME');
    }
  } else {
    ok(!rootExists('CNAME'), 'no CNAME published (site/CNAME absent) — default github.io domain');
  }
}

if (failures) {
  console.error('\n[verify-pwa] ' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\n[verify-pwa] all checks passed');
