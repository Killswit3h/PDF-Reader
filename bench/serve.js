'use strict';

/*
 * Device bench: serve the www/ build on the LAN with the probe and a one-tap
 * "Run bench" panel injected, so an iPad (Safari) or an Android tablet
 * (Chrome or the Capacitor WebView pointed at this URL) runs the identical
 * sequence bench/run-web.js runs and posts its numbers back here.
 *
 *   npm run bench:serve            # prints http://<lan-ip>:8787/
 *   open that URL on the tablet, tap "Run bench", then "Upload"
 *   → docs/perf/results/<device-label>-<timestamp>.json, and the markdown
 *     table is printed in this terminal.
 *
 * Only the served index.html is touched (two <script> tags before </body>);
 * the bundle on disk is the real one. Same-origin scripts and fetches satisfy
 * the app's CSP, so nothing is relaxed for the run.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const WWW = path.join(L.ROOT, 'www');
const port = parseInt(process.env.BENCH_PORT || '8787', 10);

(async () => {
  if (!fs.existsSync(path.join(WWW, 'index.html'))) {
    console.error('[bench:serve] no www/ bundle — run `npm run build:web` first (or `npm run bench:serve`).');
    process.exit(2);
  }
  const indexHtml = () => fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/bench/probe.js"></script><script src="/bench/device.js"></script></body>');

  const routes = {
    'GET /bench/device.js': (_req, res) => {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(__dirname, 'device.js'), 'utf8'));
    },
    'POST /bench/result': async (req, res) => {
      try {
        const body = JSON.parse((await L.readBody(req)).toString('utf8'));
        const label = body.label || 'device';
        const file = L.writeResult(body, label);
        console.log('\n' + L.markdown(body, label) + '\n\n[bench:serve] wrote ' + file + '\n');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, file: path.relative(L.ROOT, file) }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  };
  const server = await L.serve(WWW, { port, routes, indexHtml });
  const ips = L.lanAddresses();
  console.log('[bench:serve] FieldMark web build + bench probe');
  console.log('  local:  http://localhost:' + port + '/');
  ips.forEach((ip) => console.log('  tablet: http://' + ip + ':' + port + '/'));
  console.log('\nOn the tablet: open the URL, tap "Run bench" (bottom right), wait for "done", tap "Upload".');
  console.log('Results land in docs/perf/results/ and the table prints here. Ctrl+C to stop.');
  server.on('error', (e) => { console.error('[bench:serve]', e.message); process.exit(1); });
})();
