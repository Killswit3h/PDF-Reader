'use strict';

/*
 * Shared plumbing for the bench runners: the probe source (shared stats +
 * bench/probe.js, concatenated so one evaluate() installs both), the fixture
 * list, a static file server that also exposes the fixtures and the probe, and
 * result formatting/writing. Node-only; nothing here runs in the page.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const RESULTS_DIR = path.join(ROOT, 'docs', 'perf', 'results');
const FIXTURE_NAMES = ['dense-plans.pdf', 'heavy-markup.pdf', 'scanned-set.pdf'];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.map': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png'
};

// The code every runner injects into the page: the pure stats first (it
// defines App.PerfStats), then the probe (which defines window.__FMPerf).
function probeSource() {
  return fs.readFileSync(path.join(ROOT, 'src', 'shared', 'perf-stats.js'), 'utf8') + '\n;\n' +
    fs.readFileSync(path.join(ROOT, 'bench', 'probe.js'), 'utf8');
}

function fixturePath(name) {
  if (!FIXTURE_NAMES.includes(name)) throw new Error('unknown fixture ' + name);
  return path.join(FIXTURES, name);
}

// Serve `wwwDir` plus /fixtures/<name>.pdf and /bench/probe.js. `extra` may add
// routes: { 'GET /path': (req, res) => ..., 'POST /path': ... }. Resolves to the
// server once listening on `port` (0 = ephemeral) across all interfaces.
function serve(wwwDir, opts) {
  opts = opts || {};
  const extra = opts.routes || {};
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const handler = extra[req.method + ' ' + url];
    if (handler) return handler(req, res);
    if (url === '/bench/probe.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(probeSource());
    }
    if (url.startsWith('/fixtures/')) {
      const name = url.slice('/fixtures/'.length);
      if (!FIXTURE_NAMES.includes(name)) { res.statusCode = 404; return res.end('nf'); }
      res.setHeader('Content-Type', 'application/pdf');
      return fs.createReadStream(fixturePath(name)).pipe(res);
    }
    let rel = url === '/' ? '/index.html' : url;
    if (rel === '/index.html' && opts.indexHtml) {
      res.setHeader('Content-Type', 'text/html');
      return res.end(opts.indexHtml());
    }
    const file = path.join(wwwDir, rel);
    if (!file.startsWith(wwwDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404; return res.end('nf');
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(opts.port || 0, opts.host || '0.0.0.0', () => resolve(server)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// LAN addresses a tablet can reach, for bench:serve's banner.
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

function safeLabel(s) {
  return String(s || 'run').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run';
}

// Persist a result as docs/perf/results/<label>-<timestamp>.json; returns the path.
function writeResult(result, label) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = (result.finishedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const file = path.join(RESULTS_DIR, `${safeLabel(label)}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  return file;
}

// The markdown table every PR pastes, computed by the shared stats module.
function markdown(result, label) {
  const S = require(path.join(ROOT, 'src', 'shared', 'perf-stats.js'));
  const env = result.env || {};
  const head = `**${label || 'bench'}** — ${env.platform || '?'}, dpr ${env.dpr || '?'}, ` +
    `${env.viewport ? env.viewport.w + 'x' + env.viewport.h : '?'}, coarse pointer: ${env.coarse ? 'yes' : 'no'}` +
    (env.ua ? `\n<sub>${env.ua}</sub>` : '');
  return head + '\n\n' + S.markdownTable(S.reportRows(result));
}

module.exports = { ROOT, FIXTURES, RESULTS_DIR, FIXTURE_NAMES, MIME, probeSource, fixturePath, serve, readBody,
  lanAddresses, writeResult, markdown, safeLabel };
