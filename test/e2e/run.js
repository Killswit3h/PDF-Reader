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
const FORM = path.join(FIX, 'form.pdf');
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
      // Smooth-zoom preview: GPU transform during the gesture, single commit after.
      check(j.previewTransformed, 'zoom gesture did not ride a CSS transform');
      check(j.previewNoRerender, 'zoom gesture re-rendered mid-gesture (should be 0)');
      check(j.commitOneRerender, 'zoom did not commit exactly one re-render');
      check(j.commitCleared, 'zoom transform not cleared / scale not committed');
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
    name: 'freehand — highlighter + pen paint multi-point strokes; hold snaps straight',
    run: () => {
      const j = tagJson(runApp({ SMOKE_FREEHAND: '1' }, [SAMPLE]), 'freehand');
      check(j.hlType === 'highlight', `highlight type ${j.hlType}`);
      check(j.hlPts >= 4, `highlighter stroke only ${j.hlPts} pts — not freehand`);
      check(j.inkType === 'ink', `ink type ${j.inkType}`);
      check(j.inkPts >= 3, `ink stroke only ${j.inkPts} pts`);
      check(j.straightMid === 2, `hold-to-straighten left ${j.straightMid} pts, expected 2`);
      check(j.straightPts === 2, `straightened stroke committed ${j.straightPts} pts`);
      check(j.polylines >= 2, `expected freehand polylines, got ${j.polylines}`);
      // curve-fit smoothing densifies the raw pen stroke, but leaves a 2-pt line alone
      check(j.inkSmoothPts > j.inkPtsRaw, `smoothing didn't densify: ${j.inkSmoothPts} <= ${j.inkPtsRaw}`);
      check(j.straightSmoothPts === 2, `straight stroke should stay 2 pts, got ${j.straightSmoothPts}`);
      // single-key tool shortcuts
      check(j.kA === 'arrow', `key 'a' armed ${j.kA}, expected arrow`);
      check(j.kH === 'highlight', `key 'h' armed ${j.kH}, expected highlight`);
      check(j.kV === null && j.kVmode === null, `key 'v' should disarm to select (tool=${j.kV}, mode=${j.kVmode})`);
      check(j.err === '', `buildBytes error: ${j.err}`);
      check(j.bytesLen > 0, 'no PDF bytes produced');
    }
  },
  {
    name: 'split view — side-by-side pane renders a second doc; tile API present',
    run: () => {
      const j = tagJson(runApp({ SMOKE_SPLIT: '1' }, [SAMPLE]), 'split');
      check(j.tabs === 2, `expected 2 tabs, got ${j.tabs}`);
      check(j.paneVisible === true, 'split pane not visible');
      check(j.canvases > 0, 'right pane rendered no page canvas');
      check(j.options >= 3, `doc picker options ${j.options} < 3`);
      check(j.closed === true, 'split did not close');
      check(j.apiTile === true, 'tileSideBySide API missing');
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
    name: 'measure — length/continuous/area/angle/count + region scale export',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MEASURE: '1' }, [BIG]), 'measure');
      check(Array.isArray(j.out) && j.out.length === 6, `measurements ${JSON.stringify(j.out)}`);
      // the continuous run sums its two 200-pt legs at 0.5 ft/pt → 200 ft
      check(j.out.includes('continuous=200.00 ft'), `continuous total wrong: ${JSON.stringify(j.out)}`);
      check(j.err === '', `buildBytes error: ${j.err}`);
      check(j.bytesLen > 0, 'no PDF bytes produced');
    }
  },
  {
    name: 'measure — snap-to-drawing, feet-inches, and per-segment breakdown',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MSNAP: '1' }, [SAMPLE]), 'msnap');
      check(j.snapPoints >= 4, `content snap harvested too few points (${j.snapPoints})`);
      check(j.snapHit && Math.abs(j.snapHit.vx - 72) <= 3 && Math.abs(j.snapHit.vy - 92) <= 3,
        `cursor did not snap to the border-box corner: ${JSON.stringify(j.snapHit)}`);
      check(j.decimal === '30.00 ft', `decimal label ${j.decimal}`);
      check(j.ftin === "30'-0\"", `feet-inches label ${j.ftin}`);
      check(JSON.stringify(j.segs) === JSON.stringify([40, 30]), `segments ${JSON.stringify(j.segs)}`);
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
    name: 'select — Select tool disarms drawing tools and enables item selection',
    run: () => {
      const j = tagJson(runApp({ SMOKE_SELECT: '1' }, [SAMPLE]), 'select');
      check(j.exists === true, 'no #btn-select button in the tool rail');
      check(j.enabled === true, 'Select button not enabled with a document open');
      check(j.toolActiveWhileDrawing === true, 'arming a drawing tool did not set tool-active');
      check(j.selectArmedWhileDrawing === false, 'Select should not be armed while a drawing tool is active');
      check(j.modeAfterSelect === null, `clicking Select did not disarm the tool (mode ${j.modeAfterSelect})`);
      check(j.toolActiveAfterSelect === false, 'Select left tool-active on (items would stay un-grabbable)');
      check(j.selectArmedAfterSelect === true, 'Select not highlighted after activating it');
      check(j.annoSelectedId === j.addedId, `selecting an item failed (${j.annoSelectedId} != ${j.addedId})`);
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
      check(j.fitW > 0 && j.fitActive === true, `fit did not size the diff page (${j.fitW}, active=${j.fitActive})`);
      check(j.zoomW > j.fitW && j.fitInactive === false, `zoom in did not enlarge past fit (${j.zoomW} !> ${j.fitW})`);
    }
  },
  {
    name: 'rail collapse — tool rail shrinks to icons, persists, expands back',
    run: () => {
      const j = tagJson(runApp({ SMOKE_RAIL: '1' }, [SAMPLE]), 'rail');
      check(j.collapsed === true, 'rail did not collapse');
      check(j.narrow < j.wide, `rail did not narrow (${j.narrow} !< ${j.wide})`);
      check(j.txtHidden === true, 'button labels still visible when collapsed');
      check(j.pref === true, 'collapsed state not persisted to prefs');
      check(j.expanded === true, 'rail did not expand back');
      check(j.wideAgain === j.wide, `rail width not restored (${j.wideAgain} != ${j.wide})`);
    }
  },
  {
    name: 'sharp zoom — page past the old 16.7M cap renders crisp, not downscaled',
    run: () => {
      const j = tagJson(runApp({ SMOKE_SHARP: '1' }, [SAMPLE]), 'sharp');
      check(j.cssArea > j.oldCap, `zoom did not exceed old cap (${j.cssArea} <= ${j.oldCap})`);
      check(j.canvasPx > j.oldCap, `canvas still clamped at old cap (${j.canvasPx})`);
      // Crisp => rendered pixels per CSS px ≈ dpr. The old cap would clamp this
      // below dpr (here ~0.77) and the browser would upscale it → blur.
      check(j.sharpness >= j.dpr - 0.05, `page downscaled/blurry: sharpness ${j.sharpness} < dpr ${j.dpr}`);
    }
  },
  {
    name: 'round-trip — saved marks reopen as editable objects (not baked in)',
    run: () => {
      const j = tagJson(runApp({ SMOKE_RT: '1' }, [SAMPLE]), 'rt');
      check(j.hasModel === true && j.hasBase === true, 'saved PDF is missing the editable sidecar');
      check(j.m === 1 && j.a === 1 && j.p === 1, `marks did not rehydrate (m${j.m} a${j.a} p${j.p})`);
      check(j.baseLen < j.savedLen, `reopened doc is not the pristine base (${j.baseLen} !< ${j.savedLen})`);
      check(j.moved === true, 'rehydrated measurement could not be moved');
      check(j.p === 1 && j.pAfter === 0, 'rehydrated placement could not be deleted');
    }
  },
  {
    name: 'measure color — chosen color applies only to later measurements; Reset restores default',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MCOLOR: '1' }, [SAMPLE]), 'mcolor');
      check(j.n === 3, `expected 3 measurements, got ${j.n}`);
      check(j.c[0] === '#2f6fed', `first measurement lost the default color: ${j.c[0]}`);
      check(j.c[1] === '#ff0000', `chosen color did not apply to the next measurement: ${j.c[1]}`);
      check(j.c[2] === '#2f6fed', `Reset did not restore the default color: ${j.c[2]}`);
      check(j.strokes[1] === '#ff0000', `rendered stroke did not use the chosen color: ${JSON.stringify(j.strokes)}`);
      check(j.exportOk === true, 'export threw with a custom measurement color');
    }
  },
  {
    name: 'duplicate — Ctrl+D / Ctrl+C+V clone the selected object into an offset copy',
    run: () => {
      const j = tagJson(runApp({ SMOKE_DUP: '1' }, [SAMPLE]), 'dup');
      check(j.place.after === 2, `Ctrl+D did not duplicate the placement (count ${j.place.after})`);
      check(j.place.offX === 14 && j.place.offY === 14, `placement copy not offset: ${j.place.offX},${j.place.offY}`);
      check(j.place.text === 'HELLO' && j.place.newId === true, 'placement copy lost text or reused id');
      check(j.place.selected === true, 'placement copy was not selected after duplicate');
      check(j.markup.after === 3, `Ctrl+C+V+V did not paste two markup copies (count ${j.markup.after})`);
      check(j.markup.offX === 14, `first markup copy not offset: ${j.markup.offX}`);
      check(j.markup.cascadeOff === 14, `repeated paste did not cascade offset: ${j.markup.cascadeOff}`);
      check(j.markup.text === 'NOTE' && j.markup.newId === true, 'markup copy lost text or reused id');
    }
  },
  {
    name: 'markup presets — Line color has 6 quick presets; clicking one applies it; wheel still works',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MKPRESET: '1' }, [SAMPLE]), 'mkpreset');
      check(j.count === 6, `expected 6 line-color presets, got ${j.count}`);
      check(j.inputVal === '#2f6fed', `clicking a preset did not set the color input: ${j.inputVal}`);
      check(j.defStroke === '#2f6fed', `preset did not become the default line color: ${j.defStroke}`);
      check(j.active.length === 1 && j.active[0] === '#2f6fed', `active swatch not marked: ${JSON.stringify(j.active)}`);
      check(j.customDef === '#abcdef', `custom color-wheel value did not apply: ${j.customDef}`);
    }
  },
  {
    name: 'text copy — selecting PDF text shows the copy button',
    run: () => {
      const j = tagJson(runApp({ SMOKE_COPY: '1' }, [SAMPLE]), 'copy');
      check(j.spans >= 3, `text layer not rendered (${j.spans} spans)`);
      check(j.textLen > 0, 'no text captured from the selection');
      check(j.fabShown === true, 'copy button did not appear on selection');
    }
  },
  {
    name: 'text one-shot — placing a text box disarms the tool; no runaway boxes',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TEXT1: '1' }, [SAMPLE]), 'text1');
      check(j.armed === true, 'text tool did not arm');
      check(j.disarmed === true, 'text tool stayed armed after placing a box');
      check(j.draggable === true, 'placed text box is not grabbable');
      check(j.after1 === 1, `expected 1 box after placing, got ${j.after1}`);
      check(j.after2 === 1, `a second click added another box (${j.after2})`);
    }
  },
  {
    name: 'text independence — a second box does not copy the first; each edits its own text',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TEXT2: '1' }, [SAMPLE]), 'text2');
      check(j.count === 2, `expected 2 text boxes, got ${j.count}`);
      check(j.edit1 === true && j.edit2 === true, 'a placed text box did not open its own editor');
      check(j.t1 === 'AAA', `first box text wrong: ${JSON.stringify(j.t1)}`);
      check(j.t2 === 'BBB', `second box copied/overwrote text: ${JSON.stringify(j.t2)}`);
      check(j.edit3 === true, 'could not re-open the second box for editing');
      check(j.r2 === 'CCC', `re-editing the second box failed: ${JSON.stringify(j.r2)}`);
      check(j.r1 === 'AAA', `editing the second box changed the first: ${JSON.stringify(j.r1)}`);
    }
  },
  {
    name: 'text font — a text box exposes font family + size that update the box and survive export',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TFONT: '1' }, [SAMPLE]), 'tfont');
      check(j.hiddenBefore === true, 'font controls should be hidden with no text context');
      check(j.shownWhenSelected === true, 'font controls should appear for a selected text box');
      check(j.styFam === 'Times', `font family did not apply to the annotation: ${JSON.stringify(j.styFam)}`);
      check(j.stySize === 28, `font size did not apply to the annotation: ${JSON.stringify(j.stySize)}`);
      check(/times/i.test(j.cssFam), `on-screen box did not switch font: ${JSON.stringify(j.cssFam)}`);
      check(j.daHasFont === true, 'exported FreeText annotation lost the chosen font/size in its DA');
      check(j.flatOk === true, 'flattened export produced no bytes');
    }
  },
  {
    name: 'rotate — the Rotate button turns the view and overlays follow the canvas',
    run: () => {
      const j = tagJson(runApp({ SMOKE_ROTATE: '1' }, [SAMPLE]), 'rotate');
      check(j.rerendered === true, `view did not re-render on rotate (${JSON.stringify(j.d0)} -> ${JSON.stringify(j.d1)})`);
      check(j.rotated === true, 'markup overlay layer did not pick up a rotation transform');
      check(j.boxErr <= 2, `markup layer drifted off the rotated canvas (${j.boxErr}px)`);
    }
  },
  {
    name: 'forms — typing into a prefilled field persists on save',
    run: () => {
      const j = tagJson(runApp({ SMOKE_FORM: '1' }, [FORM]), 'form');
      check(j.storeSize > 0, 'form edit not captured in annotationStorage');
      check(j.edited === true, `saved PDF lost the form edit: ${JSON.stringify(j.vals)}`);
    }
  },
  {
    name: 'print — hands the OS PDF app the full, non-blank exported document',
    run: () => {
      const j = tagJson(runApp({ SMOKE_PRINT: '1', SMOKE_NO_PRINT_OPEN: '1' }, [SAMPLE]), 'print');
      check(j.printPages === j.numPages && j.printPages >= 1, `printed PDF has ${j.printPages} pages, doc has ${j.numPages}`);
      check(j.w > 0 && j.h > 0, 'first page has no size');
      check(j.darkPx > 500, `first page looks blank (${j.darkPx} dark px)`);
      check(j.printOk === true, 'print IPC did not report ok');
      check(j.hasFile === true, 'print IPC wrote no temp PDF file');
    }
  },
  {
    name: 'print preview — thumbnails render, a page range prints a subset, cancel closes it',
    run: () => {
      const j = tagJson(runApp({ SMOKE_PRINTPREVIEW: '1' }, [SAMPLE]), 'printpreview');
      // pass 1: modal + thumbnails + cancel
      check(j.open === true, 'print-preview modal did not open');
      check(j.thumbs === j.numPages && j.thumbs >= 1, `thumbnail count ${j.thumbs} != pages ${j.numPages}`);
      check(j.drawn >= 1, 'no thumbnail finished rendering');
      check(j.darkPx > 500, `first thumbnail looks blank (${j.darkPx} dark px)`);
      check(j.proceed === null, 'cancel should resolve preview() to null');
      check(j.closed === true, 'modal did not close after cancel');
      // pass 2: page-range selection prints only the chosen page(s)
      check(Array.isArray(j.selPages) && j.selPages.length === 1 && j.selPages[0] === 1,
        `range "1" should select page 1 only, got ${JSON.stringify(j.selPages)}`);
      check(j.printDisabled === false, 'Print should be enabled for a valid range');
      check(j.excluded === j.numPages - 1, `expected ${j.numPages - 1} excluded thumbnails, got ${j.excluded}`);
      check(j.subPages === 1, `subset PDF should have 1 page, got ${j.subPages}`);
    }
  },
  {
    name: 'wysiwyg — a clicked text mark flattens where it shows on screen',
    run: () => {
      const j = tagJson(runApp({ SMOKE_WYSIWYG: '1' }, [SAMPLE]), 'wysiwyg');
      check(j.flFx >= 0, 'no flattened text found');
      check(Math.abs(j.dfx) < 0.02, `horizontal drift ${(j.dfx * 100).toFixed(1)}% (scale bug?)`);
      check(Math.abs(j.dfy) < 0.03, `vertical drift ${(j.dfy * 100).toFixed(1)}%`);
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
    name: 'tab reorder — dragging a tab reorders the sessions and the tab DOM',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TABREORDER: BIG }, [SAMPLE]), 'tabreorder');
      check(j.before.join(',') === 'sample.pdf,big.pdf', `initial order ${JSON.stringify(j.before)}`);
      check(j.after.join(',') === 'big.pdf,sample.pdf', `reordered wrong ${JSON.stringify(j.after)}`);
      check(j.activeStayed === 'big.pdf', `reorder changed the active doc (${j.activeStayed})`);
    }
  },
  {
    name: 'tear-off — a tab pops into a second window carrying its unsaved edits',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TEAROFF: '1' }, [SAMPLE]), 'tearoff');
      check(j.setup.canTear === true, 'tear-off was not allowed with two tabs open');
      check(j.setup.ok === true, 'tearOff did not report success');
      check(j.setup.before === 2 && j.setup.after === 1, `source tab count wrong (before ${j.setup.before}, after ${j.setup.after})`);
      check(j.windows === 2, `expected a second window, saw ${j.windows}`);
      check(j.child && j.child.name === 'second.pdf', `new window opened the wrong doc: ${JSON.stringify(j.child)}`);
      check(j.child.m === 1, `torn-off edits did not travel to the new window (measurements ${j.child && j.child.m})`);
      check(j.child.tabs === 1, `new window tab count wrong (${j.child && j.child.tabs})`);
      check(j.child.dirty === true, 'new window lost the dirty (unsaved) state');
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
    name: 'digital signature UI — saved IDs, placement modes, and preview wire up',
    run: () => {
      const j = tagJson(runApp({ SMOKE_DSIGN: '1' }, [SAMPLE]), 'dsign');
      check(j.emptyShowsNew === true, 'attach form not shown with no saved IDs');
      check(j.emptyHidesSaved === true, 'saved-ID section shown with no saved IDs');
      check(j.modeCount === 3, `expected 3 placement modes, got ${j.modeCount}`);
      check(j.cornerBtns === 4, `expected 4 corner buttons, got ${j.cornerBtns}`);
      check(j.cornerOptsShown === true, 'corner options not revealed in corner mode');
      check(j.previewShown === true, 'preview not shown for a visible placement');
      check(j.tlSelected === true, 'corner picker did not select the clicked corner');
      check(j.previewHiddenOnNone === true, 'preview shown for an invisible signature');
      check(j.savedShown === true, 'saved-ID section not shown after saving one');
      check(j.chipCount === 1, `expected 1 saved-ID chip, got ${j.chipCount}`);
      check(j.namePrefilled === true, 'saved ID did not prefill the signer name');
      check(j.goEnabled === true, 'Sign disabled despite a saved password');
      check(j.afterForget === 0, 'forgetting a saved ID did not remove it');
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
