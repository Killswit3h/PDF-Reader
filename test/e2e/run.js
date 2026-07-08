'use strict';

/*
 * End-to-end smoke suite.
 *
 * Drives the REAL Electron app headlessly by spawning it with the SMOKE_*
 * env-var harness baked into src/main.js. Each scenario opens a committed
 * fixture PDF, exercises a feature, and prints a `[tag] {json}` line that this
 * runner parses and asserts. Non-zero exit on any failure so CI + the pre-push
 * hook can gate on it.
 *
 * Notes
 *  - This sandbox sets ELECTRON_RUN_AS_NODE=1 globally, which makes the electron
 *    binary behave as plain Node. We delete it from the child env so a real
 *    Electron window launches.
 *  - The write path is exercised via SMOKE_DRIVE / buildBytes (which produce PDF
 *    bytes without touching disk-in-place). SMOKE_SAVE is intentionally not run:
 *    Save now prompts before overwriting the original (see save.js), which would
 *    block a headless run.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const electronPath = require('electron'); // resolves to the binary path under Node
const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const SAMPLE = path.join(FIX, 'sample.pdf');
const BIG = path.join(FIX, 'big.pdf');
const PER_TEST_TIMEOUT = 45000;

let passed = 0, failed = 0;
let spawnSeq = 0;

// Run Electron once with the given SMOKE_* env + argv; return captured stdout.
// Each spawn gets its own --user-data-dir so the single-instance lock never
// makes a fresh scenario quit because a previous one hasn't fully released it.
function runApp(env, argv) {
  const childEnv = Object.assign({}, process.env, { SMOKE_TEST: '1' }, env);
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const profile = path.join(os.tmpdir(), `pdfsigner-e2e-prof-${process.pid}-${++spawnSeq}`);
  // Headless-CI Chromium flags: the sandbox needs a SUID helper that isn't set
  // up on CI runners, and /dev/shm is often too small — without --no-sandbox
  // Electron exits instantly with no output. Harmless on macOS/Windows.
  const ciFlags = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  const res = spawnSync(electronPath, ['.', ...(argv || []), ...ciFlags, `--user-data-dir=${profile}`], {
    cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: PER_TEST_TIMEOUT
  });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  if (res.error && res.error.code === 'ETIMEDOUT') {
    throw new Error(`timed out after ${PER_TEST_TIMEOUT}ms`);
  }
  return (res.stdout || '') + (res.stderr || '');
}

// Extract the JSON object following a `[tag] ` marker.
function tagJson(out, tag) {
  const line = out.split('\n').find((l) => l.includes(`[${tag}]`));
  if (!line) throw new Error(`no [${tag}] line found. Output:\n${out.slice(-800)}`);
  const brace = line.indexOf('{');
  if (brace < 0) throw new Error(`[${tag}] line has no JSON: ${line}`);
  return JSON.parse(line.slice(brace));
}

function check(cond, msg) { if (!cond) throw new Error(msg); }

const SCENARIOS = [
  {
    name: 'launch — Open-with cold start renders the doc',
    run: () => {
      const j = tagJson(runApp({ SMOKE_LAUNCH: '1' }, [SAMPLE]), 'launch');
      check(j.numPages === 3, `numPages ${j.numPages} != 3`);
      check(j.fileName === 'sample.pdf', `fileName ${j.fileName}`);
      check(j.emptyHidden === true, 'empty state not hidden');
      check(j.canvases >= 1, 'no page canvas rendered');
    }
  },
  {
    name: 'warm — second file swaps the open document',
    run: () => {
      const out = runApp({ SMOKE_WARM: BIG }, [SAMPLE]);
      const m = out.match(/first=(\{.*?\})\s+second=(\{.*?\})/);
      check(!!m, `no warm line. Output:\n${out.slice(-800)}`);
      const first = JSON.parse(m[1]), second = JSON.parse(m[2]);
      check(first.name === 'sample.pdf', `first ${first.name}`);
      check(second.name === 'big.pdf', `second ${second.name}`);
      check(second.numPages === 12, `second numPages ${second.numPages}`);
    }
  },
  {
    name: 'zoom — ctrl/pinch wheel zooms, plain wheel ignored',
    run: () => {
      const j = tagJson(runApp({ SMOKE_ZOOM: '1' }, [SAMPLE]), 'zoom');
      check(j.zoomedIn, 'zoomByAt did not zoom in');
      check(j.zoomedOut, 'zoomByAt did not zoom out');
      check(j.wheelZoomed, 'ctrl+wheel did not zoom');
      check(j.plainIgnored, 'plain wheel wrongly zoomed');
    }
  },
  {
    name: 'viewer — virtualized render + find on a 12-page doc',
    run: () => {
      const j = tagJson(runApp({ SMOKE_VIEWER: '1' }, [BIG]), 'viewer');
      check(j.numPages === 12, `numPages ${j.numPages}`);
      check(j.pageDivs > 0, 'no page divs');
      check(j.renderedCanvases > 0, 'no rendered canvases');
      check(j.findOk === true, 'find threw');
    }
  },
  {
    name: 'markup — all 11 tools draw + export to PDF bytes',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MARKUP: '1' }, [SAMPLE]), 'markup');
      check(j.annCount === 11, `annCount ${j.annCount} != 11`);
      check(j.err === '', `buildBytes error: ${j.err}`);
      check(j.bytesLen > 0, 'no PDF bytes produced');
    }
  },
  {
    name: 'organize — reorder/rotate/delete rebuilds the page set',
    run: () => {
      const j = tagJson(runApp({ SMOKE_ORGANIZE: '1' }, [BIG]), 'organize');
      check(j.start === 12, `start ${j.start} != 12`);
      check(j.pages === 11, `rebuilt pages ${j.pages} != 11`);
      check(j.rot === 90, `rotated page angle ${j.rot} != 90`);
      check(j.extract === 2, `extract page count ${j.extract} != 2`);
      check(j.err === '', `assemble error: ${j.err}`);
    }
  },
  {
    name: 'stamp — numbering/watermark preview + flatten export',
    run: () => {
      const j = tagJson(runApp({ SMOKE_STAMP: '1' }, [SAMPLE]), 'stamp');
      check(j.previews > 0, `stamp previews ${j.previews}`);
      check(j.bytesLen > 0, 'no PDF bytes produced');
      check(j.err === '', `buildBytes error: ${j.err}`);
    }
  },
  {
    name: 'measure — length/area/angle/count + region scale export',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MEASURE: '1' }, [BIG]), 'measure');
      check(Array.isArray(j.out) && j.out.length === 5, `measurements ${JSON.stringify(j.out)}`);
      check(j.err === '', `buildBytes error: ${j.err}`);
      check(j.bytesLen > 0, 'no PDF bytes produced');
    }
  },
  {
    name: 'annotations — editable annotations export cleanly',
    run: () => {
      const j = tagJson(runApp({ SMOKE_ANNOT: '1' }, [SAMPLE]), 'annot');
      check(j.annCount === 7, `annCount ${j.annCount}`);
      check(j.err === '', `buildBytes error: ${j.err}`);
      check(j.bytesLen > 0, 'no PDF bytes produced');
    }
  },
  {
    name: 'overlay — placement + measurement render into the layer',
    run: () => {
      const j = tagJson(runApp({ SMOKE_OVERLAY: '1' }, [SAMPLE]), 'overlay');
      check(j.placedInLayer === 1, `placedInLayer ${j.placedInLayer}`);
      check(j.measurePolylines >= 1, 'no measurement polyline');
      check(j.measureLabels >= 1, 'no measurement label');
    }
  },
  {
    name: 'menu — native application menu installed + commands dispatch',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MENU: '1' }, [SAMPLE]), 'menu');
      check(j.hasMenu === true, 'no application menu installed');
      check(j.hasEdit === true, 'no Edit menu (macOS copy/paste roles)');
      check(j.hasView === true, 'no View menu');
      check(j.hasOpenRecent === true, 'no Open Recent submenu');
      check(j.zoomed === true, 'Zoom In menu command did not reach the renderer');
    }
  },
  {
    name: 'update — in-app download IPC wired, resolves to fallback in dev',
    run: () => {
      // Unpackaged dev build: electron-updater can't self-install, so the IPC
      // must resolve to { started:false } (UI then opens the download page) and
      // never throw — this also proves requiring electron-updater didn't brick
      // the main process.
      const j = tagJson(runApp({ SMOKE_UPDATE: '1' }, [SAMPLE]), 'update');
      check(!!j.version, 'no version reported');
      check(j.dlErr === '', `startUpdateDownload threw: ${j.dlErr}`);
      check(j.dl && j.dl.started === false, 'in-app download should be unavailable in the dev build');
    }
  },
  {
    name: 'text markup — highlight/underline/strikeout render + export',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TMARK: '1' }, [SAMPLE]), 'tmark');
      check(j.ann === 3, `annotations ${j.ann} != 3`);
      check(j.rects >= 1, 'no highlight rect rendered');
      check(j.lines >= 1, 'no underline/strikeout line rendered');
      check(j.err === '', `buildBytes error: ${j.err}`);
      check(j.bytesLen > 0, 'no PDF bytes produced');
    }
  },
  {
    name: 'compare — overlay renders a diff canvas; identical docs show no diff',
    run: () => {
      const j = tagJson(runApp({ SMOKE_COMPARE: '1' }, [SAMPLE]), 'compare');
      check(j.modalOpen === true, 'compare modal did not open');
      check(j.canvasW > 0 && j.canvasH > 0, `diff canvas not rendered ${j.canvasW}x${j.canvasH}`);
      check(j.changed === 0 && j.noDiff === true, `identical docs reported a diff (${j.changed})`);
    }
  },
  {
    name: 'measure drag — a placed measurement can be grabbed and moved',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MDRAG: '1' }, [SAMPLE]), 'mdrag');
      check(j.hasHit === true, 'no draggable hit area on the measurement');
      check(j.moved === true, 'dragging did not move the measurement');
      check(j.selected === true, 'dragging did not select the measurement');
    }
  },
  {
    name: 'tabs — open two PDFs, switch, each keeps isolated state',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TABS: BIG }, [SAMPLE]), 'tabs');
      check(j.count === 2, `tab count ${j.count}`);
      check(j.tabEls === 2, `tab elements ${j.tabEls}`);
      check(j.one.name === 'sample.pdf' && j.one.pages === 3, `tab1 ${JSON.stringify(j.one)}`);
      check(j.one.placements === 0 && j.one.dirty === false, `tab1 not isolated ${JSON.stringify(j.one)}`);
      check(j.two.name === 'big.pdf' && j.two.pages === 12, `tab2 ${JSON.stringify(j.two)}`);
      check(j.two.placements === 1 && j.two.dirty === true, `tab2 state lost ${JSON.stringify(j.two)}`);
    }
  },
  {
    name: 'reopen — file opens after the window was closed (macOS lifecycle)',
    run: () => {
      const j = tagJson(runApp({ SMOKE_REOPEN: BIG }, [SAMPLE]), 'reopen');
      check(j.first.name === 'sample.pdf', `first ${JSON.stringify(j.first)}`);
      check(j.createdWindow === true, 'no window was recreated for the reopened file');
      check(j.second.name === 'big.pdf', `second ${JSON.stringify(j.second)}`);
      check(j.second.pages === 12, `second pages ${j.second.pages}`);
    }
  },
  {
    name: 'digital signature — real PKCS#7 signature embeds in the renderer',
    run: () => {
      // Generates a throwaway identity in-renderer and signs the fixture via the
      // real App.PdfSign path (node-forge running in Electron's renderer).
      const j = tagJson(runApp({ SMOKE_SIGN: '1' }, [SAMPLE]), 'sign');
      check(j.err === '', `sign error: ${j.err}`);
      check(j.hasSig === true, 'no adbe.pkcs7.detached signature embedded');
      check(j.br === true, 'no real ByteRange in the signed PDF');
      check(j.len > 0, 'no signed bytes produced');
    }
  },
  {
    name: 'save/flatten — signed PDF written to disk is valid',
    run: () => {
      const outFile = path.join(os.tmpdir(), `pdfsigner-e2e-${process.pid}.pdf`);
      try {
        runApp({ SMOKE_DRIVE: outFile }, [BIG]);
        check(fs.existsSync(outFile), 'no output PDF written');
        const buf = fs.readFileSync(outFile);
        check(buf.length > 1000, `output PDF too small (${buf.length} bytes)`);
        check(buf.slice(0, 5).toString() === '%PDF-', 'output is not a PDF');
      } finally {
        try { fs.unlinkSync(outFile); } catch (_) { /* ignore */ }
      }
    }
  }
];

(function main() {
  console.log(`E2E smoke suite — ${SCENARIOS.length} scenarios (electron: ${path.basename(electronPath)})\n`);
  for (const sc of SCENARIOS) {
    const t0 = Date.now();
    try {
      sc.run();
      passed++;
      console.log(`  ✓ ${sc.name}  (${Date.now() - t0}ms)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${sc.name}\n      ${e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
