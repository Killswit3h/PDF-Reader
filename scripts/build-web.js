'use strict';

/*
 * Assemble a self-contained web bundle (www/) from the Electron renderer.
 *
 * The renderer normally loads its libraries via ../../node_modules/... and its
 * shared logic via ../shared/... — paths that only resolve inside the source
 * tree. Capacitor (and any static web host) needs one flat, self-contained
 * directory, so this script copies the renderer, shared logic, fonts, and the
 * few vendored library files into www/ and rewrites the index.html/styles.css
 * paths to match. It also injects the platform adapter (platform-web.js) and a
 * mobile viewport. No source files are modified.
 *
 * Run: node scripts/build-web.js   (or `npm run build:web`)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');
const pkg = require(path.join(ROOT, 'package.json'));

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function copyDir(src, dest) {
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

console.log('[build-web] output ->', OUT);
rmrf(OUT);
mkdirp(OUT);

// 1. Renderer (js/, styles/, styles.css, platform-web.js) at the www root.
copyDir(path.join(ROOT, 'src/renderer'), OUT);

// 2. Shared pure logic -> www/shared (index.html references ../shared -> shared).
copyDir(path.join(ROOT, 'src/shared'), path.join(OUT, 'shared'));

// 3. Fonts -> www/assets/fonts (styles.css references ../assets/fonts -> assets/fonts).
copyDir(path.join(ROOT, 'src/assets'), path.join(OUT, 'assets'));

// 4. Vendored libraries -> www/vendor (only the files the renderer actually loads).
const VENDOR = [
  ['node_modules/pdfjs-dist/build/pdf.js', 'vendor/pdfjs/build/pdf.js'],
  ['node_modules/pdfjs-dist/build/pdf.worker.js', 'vendor/pdfjs/build/pdf.worker.js'],
  ['node_modules/pdfjs-dist/web/pdf_viewer.js', 'vendor/pdfjs/web/pdf_viewer.js'],
  ['node_modules/pdfjs-dist/web/pdf_viewer.css', 'vendor/pdfjs/web/pdf_viewer.css'],
  ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib/pdf-lib.min.js'],
  ['node_modules/signature_pad/dist/signature_pad.umd.min.js', 'vendor/signature_pad/signature_pad.umd.min.js'],
  ['node_modules/node-forge/dist/forge.min.js', 'vendor/node-forge/forge.min.js']
];
for (const [from, to] of VENDOR) {
  const src = path.join(ROOT, from);
  if (!fs.existsSync(src)) {
    console.error('[build-web] missing vendored file:', from, '\n  run `npm ci` first.');
    process.exit(1);
  }
  copyFile(src, path.join(OUT, to));
}

// pdf_viewer.css references image assets under web/images/ (loading spinner,
// annotation icons). Copy the whole dir so the viewer has no 404s.
const imagesSrc = path.join(ROOT, 'node_modules/pdfjs-dist/web/images');
if (fs.existsSync(imagesSrc)) copyDir(imagesSrc, path.join(OUT, 'vendor/pdfjs/web/images'));

// 5. Rewrite index.html: repoint node_modules/shared paths, add a mobile
//    viewport + version, widen the CSP for the WebView bridge, and inject the
//    platform adapter just before the app modules (so it defines window.api
//    and window.PDFJS_VENDOR before viewer.js/app.js run).
const htmlPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

html = html
  .replace(/\.\.\/\.\.\/node_modules\/pdfjs-dist\/web\//g, 'vendor/pdfjs/web/')
  .replace(/\.\.\/\.\.\/node_modules\/pdfjs-dist\/build\//g, 'vendor/pdfjs/build/')
  .replace(/\.\.\/\.\.\/node_modules\/pdf-lib\/dist\//g, 'vendor/pdf-lib/')
  .replace(/\.\.\/\.\.\/node_modules\/signature_pad\/dist\//g, 'vendor/signature_pad/')
  .replace(/\.\.\/\.\.\/node_modules\/node-forge\/dist\//g, 'vendor/node-forge/')
  .replace(/\.\.\/shared\//g, 'shared/');

// Mobile viewport (once, after the charset meta).
html = html.replace(
  /<meta charset="UTF-8" \/>/,
  '<meta charset="UTF-8" />\n  <meta name="viewport" ' +
  'content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />'
);

// The Capacitor bridge injects its runtime and talks over capacitor:/https
// schemes; allow them (still local-first, no remote code). Harmless in a plain
// browser. Also permit gap:// for the file bridge.
html = html.replace(
  /connect-src 'self' blob: data:;/,
  "connect-src 'self' blob: data: https: capacitor: gap:;"
);

// The CSP allows scripts only from 'self' (no inline), so the app version and
// the GitHub repo slug (for the in-app update check) are exposed via a generated
// file rather than an inline <script>.
const repoUrl = (pkg.repository && pkg.repository.url) || '';
const repoMatch = repoUrl.match(/github\.com[/:]+([^/]+)\/([^/.]+)/i);
const repoSlug = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : '';
fs.writeFileSync(
  path.join(OUT, 'js', 'app-config.js'),
  'window.APP_VERSION=' + JSON.stringify(pkg.version) + ';\n' +
  'window.APP_REPO=' + JSON.stringify(repoSlug) + ';\n', 'utf8');

// Inject app-config.js + the platform adapter right before the first app
// module (util.js), so window.APP_VERSION / window.api / window.PDFJS_VENDOR
// are all defined before viewer.js and app.js run.
html = html.replace(
  /(\s*)<script src="js\/util\.js"><\/script>/,
  '$1<!-- Platform adapter: defines window.api for the WebView/browser -->' +
  '$1<script src="js/app-config.js"></script>' +
  '$1<script src="js/platform-web.js"></script>' +
  '$1<script src="js/util.js"></script>'
);

fs.writeFileSync(htmlPath, html, 'utf8');

// 6. Rewrite styles.css font path (../assets/fonts -> assets/fonts).
const cssPath = path.join(OUT, 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');
css = css.replace(/\.\.\/assets\/fonts\//g, 'assets/fonts/');
fs.writeFileSync(cssPath, css, 'utf8');

console.log('[build-web] done. Bundle is self-contained at www/.');
