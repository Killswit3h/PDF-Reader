'use strict';

/*
 * Sanity-check the PWA bundle produced by scripts/build-pwa.js. Fast, no browser
 * — asserts the pieces a browser needs to treat dist-pwa/ as an installable,
 * offline app are actually present and internally consistent. Mirrors the shape
 * of verify-web.js / verify-rotate.js. Run: `npm run verify:pwa`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-pwa');
const pkg = require(path.join(ROOT, 'package.json'));

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  ok  ' : ' FAIL ') + msg);
  if (!cond) failures++;
}
function exists(rel) { return fs.existsSync(path.join(OUT, rel)); }
function read(rel) { return fs.readFileSync(path.join(OUT, rel), 'utf8'); }

console.log('[verify-pwa] checking', OUT);

// Core files.
ok(exists('index.html'), 'index.html present');
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
}

// iOS install requirements in the HTML.
const html = read('index.html');
ok(/rel="manifest"/.test(html), 'index.html links the manifest');
ok(/apple-mobile-web-app-capable/.test(html), 'index.html has apple-mobile-web-app-capable');
ok(/rel="apple-touch-icon"/.test(html), 'index.html links an apple-touch-icon');
ok(/register-sw\.js/.test(html), 'index.html registers the service worker');
ok(exists('icons/apple-touch-icon.png'), 'apple-touch-icon.png present');

// Service worker precaches the real bundle (index + a vendored lib), so a cold
// offline launch has everything it needs.
const sw = read('sw.js');
ok(sw.includes('fieldmark-pwa-v' + pkg.version), 'sw cache version tracks package.json');
ok(/"index\.html"/.test(sw) || /'index\.html'/.test(sw), 'sw precache includes index.html');
ok(/pdf\.worker\.min\.js/.test(sw), 'sw precache includes the PDF.js worker');
ok(!/"sw\.js"/.test(sw), 'sw does not precache itself');

if (failures) {
  console.error('\n[verify-pwa] ' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\n[verify-pwa] all checks passed');
