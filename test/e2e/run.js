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
const SCALESET = path.join(FIX, 'scale-detect.pdf');
const SCALEHALF = path.join(FIX, 'scale-half.pdf');
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
    name: 'multi — Open-with several PDFs opens every one as a tab',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MULTI: '1' }, [SAMPLE, BIG]), 'multi');
      check(j.count === 2, `tab count ${j.count} != 2`);
      check(j.tabEls === 2, `rendered tabs ${j.tabEls} != 2`);
      check(j.names.includes('sample.pdf') && j.names.includes('big.pdf'),
        `opened docs ${JSON.stringify(j.names)}`);
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
    name: 'pan — right-click-and-hold drags the zoomed page, suppresses its menu',
    run: () => {
      const j = tagJson(runApp({ SMOKE_PAN: '1' }, [BIG]), 'pan');
      check(j.scrollable, 'page did not overflow when zoomed (nothing to pan)');
      check(j.panned, 'right-button drag did not pan the page');
      check(j.menuSuppressed, 'context menu not suppressed after a pan drag');
      check(j.menuKept, 'stationary right-click wrongly suppressed its menu');
      check(j.leftIgnored, 'left-button drag wrongly panned');
    }
  },
  {
    name: 'textrot — measurement label saves upright on a /Rotate page, not vertical',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TEXTROT: '1' }, [SAMPLE]), 'textrot');
      check(j.pageRot === 90, `page rotation not applied (${j.pageRot})`);
      check(j.labelMatchesRef, `label angle ${j.labelAngle} != reference text ${j.refAngle}`);
      check(j.labelRotated, `label angle ${j.labelAngle} not compensating page rotation`);
      check(j.flatHorizontal, `unrotated page: label ${j.flatLabel}, ref ${j.flatRef} — expected 0`);
      // The annotation export is the default, so its label must rotate too. Read
      // from the /AP stream's Tm, since getTextContent cannot see inside it.
      check(j.apAngle !== null, 'no Tm found in the measurement annotation /AP — label missing');
      check(j.apMatchesFlat, `annotation label angle ${j.apAngle} != flattened ${j.labelAngle}`);
      check(j.apFlatHorizontal, `unrotated page: annotation label ${j.flatApAngle} — expected 0`);
    }
  },
  {
    name: 'marquee — drag-a-box zooms to that region, one-shot mode',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MARQUEE: '1' }, [BIG]), 'marquee');
      check(j.noZoomWhenOff, 'left-drag zoomed while marquee was off');
      check(j.armed, 'marquee did not arm');
      check(j.boxShown, 'rubber-band box not shown during drag');
      check(j.zoomedIn, 'marquee drag did not zoom in');
      check(j.disarmed, 'marquee did not disarm after the zoom (one-shot)');
      check(j.centerErr <= 2, `region not centered (err ${j.centerErr})`);
      check(j.tinyIgnored, 'a tiny accidental drag wrongly zoomed');
      check(j.toolDisarms, 'arming a markup tool did not disarm marquee');
      check(j.escExits, 'Escape did not exit marquee mode');
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
    // The round-trip is the feature's whole point: marks that do not come back
    // are indistinguishable from marks that were never saved. Opening goes
    // through the tab manager, so this drives App.Viewer.load (not _loadInto)
    // deliberately — restoring only on the fallback path is the bug this covers.
    name: 'round-trip — saved marks reopen as editable objects',
    run: () => {
      const j = tagJson(runApp({ SMOKE_ROUNDTRIP: '1' }, [SAMPLE]), 'roundtrip');
      // AC-1: a normal save embeds both halves and reopening restores them.
      check(j.goodAtt.length === 2, `expected both attachments, got ${JSON.stringify(j.goodAtt)}`);
      check(j.dbg && j.dbg.sc && j.dbg.base, `sidecar unreadable on reopen: ${JSON.stringify(j.dbg)}`);
      check(j.reAnn === j.wantAnn, `restored ${j.reAnn} annotations, saved ${j.wantAnn}`);
      check(j.reMeas === j.wantMeas, `restored ${j.reMeas} measurements, saved ${j.wantMeas}`);
      check(j.restored === true, 'marks did not survive save + reopen');
      // AC-2: a base that cannot be built writes NEITHER attachment. loadCalls
      // proves the failure was injected at the base, not at the main document.
      check(j.loadCalls === 2, `expected the base load to be reached, loadCalls=${j.loadCalls}`);
      check(j.halfErr === '', `export should still succeed without a sidecar: ${j.halfErr}`);
      check(j.noHalfSidecar === true, `half sidecar written: ${JSON.stringify(j.halfAtt)}`);
      // AC-3: a model with no base is reported, never swallowed.
      check(j.askedAboutOrphan === true, 'orphan model opened flat with no message');
      check(j.orphanFlat === true, 'orphan model was drawn over an already-flattened page');
    }
  },
  {
    // Automatic per-page scale detection. A wrong auto-scale is worse than none
    // — it turns into confident numbers on a bid — so this asserts the value a
    // user reads off the page rather than an internal factor, and pins the two
    // refusals that keep a bad scale out: a sheet that declares AS NOTED, and a
    // ratio the word SCALE never introduced.
    name: 'auto-scale — per-page detection from embedded metadata and title blocks',
    run: () => {
      const j = tagJson(runApp({ SMOKE_AUTOSCALE: '1', SMOKE_AUTOSCALE_HALF: SCALEHALF }, [SCALESET]), 'autoscale');
      check(j.status === 'done', `detection did not finish: ${j.status}`);

      // FR-12 / FR-13 / AC-2: page 1's embedded /VP became a scaled region AND
      // a page scale, and 1 in = 20 ft means a 72-point line reads 20 ft.
      check(j.states[0] === 'applied', `p1 embedded scale not applied: ${j.states[0]}`);
      check(j.sources[0] === 'embedded', `p1 source ${j.sources[0]}, expected embedded`);
      check(j.reads[0] === 20, `p1 72pt line reads ${j.reads[0]} ft, expected 20`);
      check(j.regions.length === 1, `p1 should have 1 embedded region, has ${j.regions.length}`);
      check(j.regions[0].src === 'embedded', `region source ${j.regions[0].src}`);
      // The /BBox maps through convertToViewportPoint, so a hand-rolled Y flip
      // would put this box in the wrong half of the page.
      check(JSON.stringify(j.regions[0].box) === '[72,200,1440,2176]',
        `region box ${JSON.stringify(j.regions[0].box)}, expected [72,200,1440,2176]`);

      // FR-26 / AC-6: SCALE: 1/4" = 1'-0" -> a 72-point line reads 4 ft.
      check(j.states[1] === 'applied', `p2 note not applied: ${j.states[1]}`);
      check(j.sources[1] === 'note', `p2 source ${j.sources[1]}, expected note`);
      check(j.reads[1] === 4, `p2 72pt line reads ${j.reads[1]} ft, expected 4`);
      check(j.units[1] === 'ft', `p2 unit ${j.units[1]}, expected ft`);

      // FR-22 / AC-10: AS NOTED is a declaration, so the page stays unscaled.
      check(j.reads[2] === null, `p3 was scaled despite AS NOTED: ${j.reads[2]}`);
      check(/AS NOTED/.test(j.p3reason || ''), `p3 reason ${j.p3reason}`);

      // FR-24 / FR-27: a bare ratio is held for review, not applied.
      check(j.states[3] === 'review', `p4 state ${j.states[3]}, expected review`);
      check(j.reads[3] === null, `p4 applied an unlabelled ratio: ${j.reads[3]}`);
      check(j.p4cands.indexOf('1:50') >= 0, `p4 candidates ${JSON.stringify(j.p4cands)}`);

      // FR-35: the review list is reachable and the form footer gets out of its way.
      check(j.tabRows >= 4, `Detected tab rendered ${j.tabRows} rows, expected >= 4`);
      check(j.applyHidden === true, 'the Apply-scale button is still showing on the Detected tab');

      // FR-36 / AC-11: accepting the held candidate applies it. 1:50 in metres.
      check(j.p4after !== null, 'accepting the reviewed candidate did not apply it');
      check(j.p4unit === 'm', `p4 unit after accept ${j.p4unit}, expected m`);
      check(Math.abs(j.p4after - 1.27) < 0.001, `p4 reads ${j.p4after} m, expected 1.27`);
      check(j.p4src === 'note', `p4 source after accept ${j.p4src}`);

      // FR-37: clearing leaves the page genuinely unscaled.
      check(j.p2cleared === null, `clearing p2 left a scale: ${JSON.stringify(j.p2cleared)}`);

      // FR-4 / AC-15: the user's own scale survives an explicit re-detect, and
      // a re-run does not duplicate the embedded regions it already created.
      check(j.userKept === 'MINE', `re-detect overwrote the user's scale: ${j.userKept}`);
      check(j.userSrc === 'user', `user scale source became ${j.userSrc}`);
      check(j.regionsAfterRerun === 1, `re-detect duplicated regions: ${j.regionsAfterRerun}`);

      // ---- half-size set: every sheet 11x17, i.e. ANSI D with both dimensions
      // halved and no full-size sheet anywhere in the document.
      // AC-14 / FR-32: embedded metadata already describes the PRINTED
      // geometry, so it is applied as written. Doubling it here would count the
      // reduction twice and every takeoff on that sheet would be 2x out.
      check(j.halfEmbedded === 20,
        `half-size embedded scale was altered: reads ${j.halfEmbedded} ft, expected 20`);
      check(j.halfEmbeddedFlag === false, 'embedded scale wrongly flagged half-size');
      // AC-12 / FR-30: the title-block note describes the ORIGINAL sheet, so on
      // a half-size print 1/4" = 1'-0" really measures 8 ft to the inch, not 4.
      check(j.halfNote === 8, `half-size note not doubled: reads ${j.halfNote} ft, expected 8`);
      check(j.halfNoteFlag === true, 'doubled scale not marked halfSize');
      check(/half-size/.test(j.halfNoteLabel || ''),
        `half-size label missing: ${j.halfNoteLabel}`);
      // FR-31: applied, but never silently — it always asks to be checked.
      check(j.halfConfirm === true, 'half-size correction was not flagged for confirmation');
    }
  },
  {
    // A radius that is silently wrong prints on a sheet someone builds from,
    // so this checks the number, the refusal that keeps a bad one out of the
    // file, and that the value survives a save and reopen.
    // Rotate a sheet, save, reopen — it must still be the way you left it.
    // Built on a document whose pages START at different rotations, because a
    // fixture of all-zero pages cannot tell "added to what was there" apart
    // from "replaced with the view rotation".
    name: 'rotation — the orientation you save in is the orientation the file has',
    run: () => {
      const j = tagJson(runApp({ SMOKE_ROTPERSIST: '1' }, [SAMPLE]), 'rotpersist');
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      check(eq(j.original, [0, 90, 270]), `fixture rotations ${JSON.stringify(j.original)}`);
      // AC-6: an unrotated save moves nothing.
      check(eq(j.unrotated, j.original), `unrotated save changed /Rotate: ${JSON.stringify(j.unrotated)}`);
      // FR-1: the rotation is on the document, not only inside PDF.js.
      check(j.stateRot === 90 && j.viewRot === 90, `state ${j.stateRot} / view ${j.viewRot}, expected 90`);
      // AC-1 / AC-2: written, and ADDED to what each page already carried.
      check(eq(j.afterSave, [90, 180, 0]),
        `expected [90,180,0] (added), got ${JSON.stringify(j.afterSave)}`);
      // AC-3: reopened at that orientation, with the view back to square — a
      // document turned twice is as wrong as one not turned at all.
      check(eq(j.rePageRots, [90, 180, 0]), `reopened at ${JSON.stringify(j.rePageRots)}`);
      check(j.reViewRot === 0, `view rotation ${j.reViewRot} after reopen — document would show turned twice`);
      // AC-4: marks come through the rotated save unharmed.
      check(j.valueAfter === j.valueBefore,
        `measurement read ${j.valueBefore} before, ${j.valueAfter} after`);
      // AC-5: undone by the same action that made it.
      check(eq(j.backAgain, j.original),
        `rotating the rest of the way gave ${JSON.stringify(j.backAgain)}, expected ${JSON.stringify(j.original)}`);
    }
  },
  {
    // Real PDF outline entries, so bookmarks travel with the file. Two failures
    // matter more than the rest: bookmarks that reach Acrobat but vanish when
    // the file is reopened here (the sidecar base swap, i.e. the #98 shape), and
    // a save that damages an outline the document already carried.
    name: 'bookmarks — real PDF outline entries that survive save and reopen',
    run: () => {
      const j = tagJson(runApp({ SMOKE_BOOKMARK: '1' }, [SAMPLE]), 'bookmark');
      // AC-1 / AC-8: toggling marks the page and the document.
      check(j.litBefore === false, 'button lit before anything was bookmarked');
      check(j.litAfterAdd === true, 'button did not light after bookmarking the page');
      check(j.dirtyAfter === true, 'bookmarking left the document reporting no unsaved changes');
      // AC-2: it reports the page you are ON.
      check(j.litOnOther === false, 'button stayed lit on an unbookmarked page');
      check(j.litBack === true, 'button did not relight on returning to the bookmarked page');
      // AC-5 / FR-8: the shelf shows the document's own bookmarks too, marked.
      check(j.shelf.indexOf('Client Index') >= 0, `shelf missing the document's own bookmark: ${JSON.stringify(j.shelf)}`);
      check(j.shelf.indexOf('Page 3') >= 0, `shelf missing our bookmark: ${JSON.stringify(j.shelf)}`);
      check(j.foreignRows === 1, `expected 1 foreign row, found ${j.foreignRows}`);
      // AC-4: it reaches the file, pointing at the right page.
      check(j.titles2.indexOf('Page 3') >= 0, `saved outline missing our entry: ${JSON.stringify(j.titles2)}`);
      check(j.destPage === 3, `saved bookmark resolves to page ${j.destPage}, expected 3`);
      // AC-6: nothing the document already carried is lost or renamed.
      check(j.titles2.indexOf('Client Index') >= 0,
        `saving destroyed the document's own outline entry: ${JSON.stringify(j.titles2)}`);
      // AC-7: and it is still there after reopening HERE, not just in Acrobat.
      check(j.reTitles.indexOf('Page 3') >= 0, 'bookmark lost on reopen — the base swap dropped the outline');
      check(JSON.stringify(j.rePages) === '[2,3]', `reopened pages ${JSON.stringify(j.rePages)}, expected [2,3]`);
      check(JSON.stringify(j.reMine) === '[3]', `ownership not restored: ${JSON.stringify(j.reMine)}`);
      check(j.reLit === true, 'button not lit on the bookmarked page after reopen');
    }
  },
  {
    // The mode banner's actions must sit on the text's centre line. A later
    // .link-btn rule meant for the digital-signature panel set
    // align-self:flex-start and a smaller font, and being later it won here
    // too: "Finish shape" and "Cancel" rode 8.5-9.5px above the banner text.
    // Nothing else notices, so this guards it.
    name: 'mode banner — measure/markup actions align with the banner text',
    run: () => {
      const j = tagJson(runApp({ SMOKE_BANNER: '1' }, [SAMPLE]), 'banner');
      check(j.visible === true, 'mode banner did not show when a tool was armed');
      check(j.finShown === true, '"Finish shape" missing while measuring');
      check(j.dFinish < 1, `"Finish shape" is ${j.dFinish}px off the text centre line`);
      check(j.dCancel < 1, `"Cancel" is ${j.dCancel}px off the text centre line`);
      check(j.alignFinish === 'center', `align-self is ${j.alignFinish}, expected center`);
      check(j.insideBar === true, 'an action overflows the banner box');
      check(j.sameSize === true, 'actions are a different size from the banner text');
      check(j.underlined === false, 'actions still render as underlined links, not buttons');
    }
  },
  {
    // Length ALONG a curved run -- the linear-feet quantity a takeoff needs, and
    // the one the radius tools deliberately do not report.
    name: 'arc length — measures along the curve, not across to it',
    run: () => {
      const j = tagJson(runApp({ SMOKE_ARCLEN: '1' }, [SAMPLE]), 'arclen');
      // AC-1: half a 100pt circle at 0.5 ft/pt is 50*PI ft.
      check(Math.abs(j.value - j.want) < 1e-6, `arc length ${j.value} != ${j.want}`);
      check(j.label === '157.08 ft', `label "${j.label}" should read as a plain distance`);
      // The distinction the tool exists for: same three clicks, different number.
      check(Math.abs(j.asRadius - 50) < 1e-6, `radius off the same points was ${j.asRadius}`);
      check(j.value > j.asRadius * 3, 'arc length should far exceed the radius on a half circle');
      // AC-2: degenerate input creates nothing and leaves no non-finite number.
      check(j.refusedCollinear === true, 'collinear clicks created an arc length');
      check(j.anyBad === false, 'a non-finite number reached the measurement model');
      // FR-5: a real curve, and no radius spoke inviting the wrong number.
      check(j.curves >= 1, `expected a curve path, found ${j.curves}`);
      check(j.dashed === 0, 'arc length drew a radius spoke; it does not measure the radius');
      // AC-5 / AC-4.
      check(/^\d+'-/.test(j.fiLabel), `feet-inches label "${j.fiLabel}" not architectural`);
      check(j.reCount === 1, `${j.reCount} arc lengths restored, expected 1`);
      check(Math.abs(j.reVal - j.want) < 1e-6, `restored ${j.reVal} != saved ${j.want}`);
    }
  },
  {
    name: 'radius — 3-point and centre radius measure, refuse bad input, round-trip',
    run: () => {
      const j = tagJson(runApp({ SMOKE_RADIUS: '1' }, [SAMPLE]), 'radius');
      // AC-1 / AC-2: 100pt at 0.5 ft/pt is 50ft, by either construction.
      check(j.r3 === 50, `3-point radius ${j.r3} != 50`);
      check(j.rc === 50, `centre radius ${j.rc} != 50`);
      check(j.r3label === '50.00 ft', `label "${j.r3label}" should read as a plain distance`);
      // AC-3 / FR-10: degenerate input creates nothing and leaves no non-finite
      // number in the model -- the failure that would corrupt the saved file.
      check(j.refusedCollinear === true, 'collinear clicks created a measurement');
      check(j.refusedZero === true, 'a zero-length centre radius was stored');
      check(j.anyBad === false, 'a non-finite number reached the measurement model');
      // AC-4: full circle unless a section was swept.
      check(j.fullByDefault === true, 'centre radius did not default to a full circle');
      check(j.sectionNotFull === false, 'a swept section was treated as a full circle');
      // FR-11: drawn as real curves, not polylines.
      check(j.curves >= 2, `expected 2 curve paths, found ${j.curves}`);
      // AC-5: the feet-inches toggle reaches a radius like any length.
      check(/^\d+'-/.test(j.fiLabel), `feet-inches label "${j.fiLabel}" not architectural`);
      // AC-7: both survive save + reopen with their radii intact.
      check(j.reCount === 2, `${j.reCount} radius measurements restored, expected 2`);
      check(JSON.stringify(j.reVals) === JSON.stringify(j.wantVals),
        `restored ${JSON.stringify(j.reVals)} != saved ${JSON.stringify(j.wantVals)}`);
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
    name: 'interop — every markup + measure tool exports as a live annotation',
    run: async () => {
      const outFile = path.join(os.tmpdir(), `fieldmark-interop-${process.pid}.pdf`);
      try {
        const out = runApp({ SMOKE_INTEROP: outFile }, [SAMPLE]);
        const j = tagJson(out, 'interop');
        check(j.err === '', `buildBytes error: ${j.err}`);
        check(j.annCount === 14, `markup annotations ${j.annCount} != 14`);
        check(j.measCount === 5, `measurements ${j.measCount} != 5`);
        check(j.bytesLen > 0, 'no PDF bytes produced');
        check(fs.existsSync(outFile), 'interop sample PDF not written');
        const buf = fs.readFileSync(outFile);
        check(buf.slice(0, 5).toString() === '%PDF-', 'interop sample is not a PDF');
        // What makes this file worth opening in Revu: quad-based text markups,
        // a dimension intent, and a calibration dictionary. Read them from the
        // parsed structure — pdf-lib writes compressed object streams, so these
        // names are not plain text in the bytes.
        const { PDFDocument, PDFName } = require('pdf-lib');
        const doc = await PDFDocument.load(buf, { updateMetadata: false });
        const annots = doc.getPage(0).node.Annots();
        check(!!annots, 'exported PDF has no /Annots on page 1');
        const subtypes = [];
        let dimensions = 0, calibrated = 0;
        for (let i = 0; i < annots.size(); i++) {
          const a = annots.lookup(i);
          const st = a.get(PDFName.of('Subtype'));
          if (st) subtypes.push(String(st).replace(/^\//, ''));
          if (a.get(PDFName.of('IT'))) dimensions++;
          if (a.get(PDFName.of('Measure'))) calibrated++;
        }
        for (const want of ['Highlight', 'Underline', 'StrikeOut', 'Square', 'Circle', 'Ink', 'FreeText']) {
          check(subtypes.includes(want), `exported PDF carries no ${want} annotation`);
        }
        check(dimensions >= 3, `dimension annotations ${dimensions} < 3`);
        check(calibrated >= 3, `calibrated (/Measure) annotations ${calibrated} < 3`);
      } finally {
        try { fs.unlinkSync(outFile); } catch (_) { /* ignore */ }
      }
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
    name: 'document overlay — superimposes two docs; toggling a layer recomposites',
    run: () => {
      const j = tagJson(runApp({ SMOKE_DOCOVERLAY: '1' }, [SAMPLE]), 'docoverlay');
      check(j.modalOpen === true, 'overlay modal did not open');
      check(j.canvasW > 0 && j.canvasH > 0, `overlay canvas not rendered ${j.canvasW}x${j.canvasH}`);
      check(j.changed === true, `toggling layer B off did not change the blend (${j.both} == ${j.aOnly})`);
      check(j.fitW > 0 && j.fitActive === true, `fit did not size the overlay page (${j.fitW}, active=${j.fitActive})`);
      check(j.zoomW > j.fitW, `zoom in did not enlarge past fit (${j.zoomW} !> ${j.fitW})`);
      check(/Page 1 of/.test(j.pageTxt), `page readout missing (${j.pageTxt})`);
    }
  },
  {
    name: 'markup rail — right-hand tool strip arms tools, collapses, persists',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MRAIL: '1' }, [SAMPLE]), 'mrail');
      check(j.docOpenShown === true, 'markup rail not shown with a document open');
      check(j.rectArmed === true && j.toolIsRect === true, 'clicking Rectangle did not arm the rectangle tool');
      check(j.selArmed === true && j.rectDisarmed === true, 'Select did not become the armed tool');
      check(j.hiddenAfter === true && j.pref === true, 'collapse handle did not hide the rail / persist the choice');
      check(j.reopenShown === true, 'reopen tab not shown while rail is collapsed');
      check(j.shownAgain === true, 'reopen tab did not restore the rail');
    }
  },
  {
    name: 'onboarding — first-run tour + returning-user what\'s-new policy, spotlights, replays; ? toggles shortcuts',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TOUR: '1' }, [SAMPLE]), 'tour');
      check(j.smokeFlag === true, 'window.api.isSmokeTest not exposed under the harness');
      check(j.autoSuppressed === true, 'welcome tour auto-started under the smoke harness');
      check(j.opened === true, 'App.Tour.start() did not open the tour');
      check(j.dots > 1, `progress dots not rendered (${j.dots})`);
      check(j.backHiddenFirst === true, 'Back button visible on the first step');
      check(/welcome/i.test(j.firstTitle), `first step is not the welcome screen ("${j.firstTitle}")`);
      check(j.spotShown === true && j.anchored === true, 'spotlight did not anchor to the Open button on step 2');
      check(j.backShownNow === true, 'Back button not shown after advancing');
      check(j.doneLabel === 'Done', `last step Next button not labelled Done (${j.doneLabel})`);
      check(j.closedAfter === true, 'finishing the tour did not close it');
      check(j.seenPref === true, 'seenWelcome pref not recorded after finishing');
      check(j.helpMenuShown === true, 'Help menu did not open');
      check(j.replayed === true, 'Help → Take a quick tour did not replay the tour');
      check(j.scOpen === true && j.scClosed === true, '? did not toggle the keyboard-shortcuts sheet');
      // First-run policy: fresh install vs. returning updater vs. caught-up.
      check(j.decideFresh === 'tour', `fresh install should get the tour (got ${j.decideFresh})`);
      check(j.decideReturningNew === 'whatsnew', `returning user with unseen notes should get what's-new (got ${j.decideReturningNew})`);
      check(j.decideReturningSeen === 'none', `caught-up user should get nothing (got ${j.decideReturningSeen})`);
      check(j.wnOpen === true && j.wnItems > 0, "what's-new card did not open with highlights");
      check(j.wnAck === true, "what's-new did not record the acknowledged rev on open");
      check(j.wnClosed === true, "what's-new card did not close");
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
    name: 'dropdowns — only one rail/header flyout is ever open at a time',
    run: () => {
      const j = tagJson(runApp({ SMOKE_DROPDOWN: '1' }, [SAMPLE]), 'dropdown');
      check(j.s1.measure === true && !j.s1.markup && !j.s1.doc, 'Measure menu did not open alone');
      check(j.aria1 === 'true', 'trigger did not report aria-expanded=true when open');
      // The reported bug: opening Markup left the Measure flyout stacked behind it.
      check(j.s2.markup === true, 'Markup menu did not open');
      check(j.s2.measure === false, 'Measure menu stayed open behind the Markup menu');
      check(j.s3.doc === true && !j.s3.measure && !j.s3.markup, 'Document menu did not replace the others');
      check(j.s3b.help === true && j.s3b.doc === false, 'Help menu did not close the Document menu');
      check(j.selfOpen === true && j.selfClosed === true, 'self-click no longer toggles a menu shut');
      check(j.ariaOff === 'false', 'trigger did not report aria-expanded=false when closed');
      check(j.stickyOpen === true, 'ticking Snap wrongly closed the Measure menu');
      check(j.escClosed === true, 'Esc did not close the open menu');
      check(j.modeKept === true, 'Esc on an open menu also disarmed the active tool');
      check(j.focusBack === true, 'Esc did not return focus to the trigger');
      check(j.outsideClosed === true, 'clicking the page did not dismiss the menu');
      check(j.maxOpen <= 1, `${j.maxOpen} menus were open at once (expected at most 1)`);
    }
  },
  {
    name: 'a11y — dialogs trap focus, restore it, and tools report pressed state',
    run: () => {
      const j = tagJson(runApp({ SMOKE_A11Y: '1' }, [SAMPLE]), 'a11y');
      check(j.dialogCount >= 11, `only ${j.dialogCount} dialogs found`);
      check(j.badDialogs === 0, `${j.badDialogs} modals lack role/aria-modal/aria-labelledby`);
      // Tab used to walk straight out of a dialog into the toolbar behind it.
      check(j.movedIn === true, 'opening a dialog did not move focus into it');
      check(j.wrapped === true, 'Tab escaped the dialog instead of cycling inside it');
      check(j.restored === true, 'closing a dialog did not restore focus to its opener');
      check(j.pressedOn === true && j.pressedOff === true,
        'armed tools do not report aria-pressed');
      check(j.rowRole === 'option', `panel row role was "${j.rowRole}"`);
      check(j.rowTab === 0, 'panel row is not reachable by keyboard');
      check(j.rowActivates === true, 'Enter on a focused panel row did nothing');
    }
  },
  {
    name: 'failure path — errors survive, stamps undo, dirty reaches the title',
    run: () => {
      const j = tagJson(runApp({ SMOKE_FAILPATH: '1' }, [SAMPLE]), 'failpath');
      // The toast was a single slot with one shared timer, so a routine success
      // could erase an error the user had not read.
      check(j.errorStillShowing === true, 'a success toast overwrote an unread error');
      check(j.liveAssertive === true, 'error toast was not announced assertively');
      check(j.firstIsA === true, 'queued toasts did not show in order');
      // Applying stamps neither entered history nor marked the file dirty.
      check(j.dirtyBefore === false, 'document started dirty; test cannot prove anything');
      check(j.dirtyAfterStamp === true, 'a stamp change did not mark the document dirty');
      check(j.stampUndone === true, 'undo did not restore the previous stamp configuration');
      // With one document open the tab bar is hidden, so the title is the only
      // place an unsaved-changes indicator can appear.
      check(j.titleMarked === true, 'window title showed no unsaved-changes marker');
      check(j.titleClean === true, 'unsaved-changes marker stayed after saving');
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
    name: 'OCR — a scanned page becomes searchable text, offline, without losing marks',
    run: () => {
      const j = tagJson(runApp({ SMOKE_OCR: '1' }, [SAMPLE]), 'ocr');
      check(j.avail === true, 'OCR engine did not initialize from the bundled assets');
      check(j.before === '', `the synthetic scan already had text: ${JSON.stringify(j.before)}`);
      check(j.recognized === 1 && j.failed === 0,
        `expected 1 page recognized, got ${j.recognized} recognized / ${j.failed} failed`);
      check(j.words > 0, 'recognition produced no words');
      check(j.found === true, `recognized text does not contain the printed word: ${JSON.stringify(j.text)}`);
      // The invisible text must sit on the ink it was read from — otherwise
      // find highlights and selections land beside the word.
      check(j.positioned === true, 'recognized text is not positioned over the source image');
      // FR-A-12: unlike the page organizer's rebuild, OCR must not cost marks.
      check(j.m === 1 && j.a === 1, `marks lost across the OCR rebuild (m${j.m} a${j.a})`);
      check(j.dirty === true, 'document was not marked as having unsaved changes');
      // FR-A-8: the page now has text, so a second pass leaves it alone.
      check(j.skippedOnRerun === 1, `re-running OCR did not skip the now-texted page (${j.skippedOnRerun})`);
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
    name: 'markup prospective color — restyling with a tool armed hits the next markup, not the last one',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MKPROSPECT: '1' }, [SAMPLE]), 'mkprospect');
      check(j.armedSel === true, 'finalize() no longer selects the drawn markup — draw-then-nudge would be broken');
      check(j.afterProspective === j.before,
        `preset recolored the already-drawn highlight: ${j.before} -> ${j.afterProspective}`);
      check(j.defAfter === '#2f6fed', `preset did not become the default for the next markup: ${j.defAfter}`);
      check(j.selAfterSwitch === null, 'arming another tool left the markup selected');
      check(j.propsHidden === true, 'markup properties bar stayed up after switching tools — two toolbars');
      check(j.afterRetro === '#21a366', `restyling via Select was not retroactive: ${j.afterRetro}`);
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
    name: 'text rotation — a flattened text box follows a rotated page instead of going vertical',
    run: () => {
      const j = tagJson(runApp({ SMOKE_TROT: '1' }, [SAMPLE]), 'trot');
      check(j.plain && Math.abs(j.plain.b) < 0.5 && Math.abs(j.plain.c) < 0.5,
        `text on an unrotated page should be axis-aligned: ${JSON.stringify(j.plain)}`);
      check(j.rot && (Math.abs(j.rot.b) > 0.5 || Math.abs(j.rot.c) > 0.5),
        `text on a rotated page should rotate to stay horizontal on screen, not draw vertical: ${JSON.stringify(j.rot)}`);
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
      // The orientation hint (landscape for a wide sheet) must reach the print path.
      check(j.wantLandscape === (j.w > j.h), `orientation hint ${j.wantLandscape} != page shape (${j.w}x${j.h})`);
      check(j.gotLandscape === j.wantLandscape, 'orientation hint did not reach the print IPC');
      // Tabloid regression guard: the print document must BE the paper size, and
      // the matching page box must reach the print IPC. Leaving either to the
      // platform is what printed a 17x11 sheet at ~3/4 size in a corner.
      const longEdge = Math.max(j.tabW, j.tabH), shortEdge = Math.min(j.tabW, j.tabH);
      check(longEdge === 1224 && shortEdge === 792,
        `tabloid print doc should be 1224x792 points, got ${j.tabW}x${j.tabH}`);
      check(j.tabPages === j.numPages, `tabloid print doc has ${j.tabPages} pages, doc has ${j.numPages}`);
      check(!!j.micron && Math.max(j.micron.width, j.micron.height) === 431800 &&
        Math.min(j.micron.width, j.micron.height) === 279400,
        `pageSize should be 17x11in in microns, got ${JSON.stringify(j.micron)}`);
      check(!!j.gotPageSize, 'pageSize never reached the print IPC — tabloid geometry is back to a platform guess');
      check(Math.max(j.gotPageSize.width, j.gotPageSize.height) === 431800,
        `print IPC got the wrong page box: ${JSON.stringify(j.gotPageSize)}`);
    }
  },
  {
    name: 'print preview — thumbnails render, a page range / current page prints a subset, cancel closes it',
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
      // pass 3: "Current page" selects only the page that was being viewed
      const cur = j.numPages >= 2 ? 2 : 1;
      check(j.curLabel === `(${cur})`, `current-page radio should be labelled "(${cur})", got "${j.curLabel}"`);
      check(Array.isArray(j.curSelPages) && j.curSelPages.length === 1 && j.curSelPages[0] === cur,
        `current-page mode should select page ${cur} only, got ${JSON.stringify(j.curSelPages)}`);
      check(j.curExcluded === j.numPages - 1, `current-page mode should exclude ${j.numPages - 1} thumbnails, got ${j.curExcluded}`);
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
    name: 'measure resize — endpoint handles extend/shorten a line; color + thickness editable',
    run: () => {
      const j = tagJson(runApp({ SMOKE_MRESIZE: '1' }, [SAMPLE]), 'mresize');
      check(j.hasHandles === true, 'selected measurement did not expose vertex handles');
      check(j.resized === true, 'dragging an endpoint handle did not extend the line');
      check(j.handleScrolled === false, 'grabbing an endpoint handle scrolled the page (regression)');
      check(j.col === '#ff0000', `editing did not recolor the line: ${j.col}`);
      check(j.wid === 5, `editing did not change the line thickness: ${j.wid}`);
      check(j.stroke === '#ff0000', `rendered stroke ignored the edited color: ${j.stroke}`);
      // Selected shapes render a touch heavier (width + 0.8), so 5 -> 5.8px.
      check(parseFloat(j.sw) >= 5, `rendered stroke-width ignored the edited thickness: ${j.sw}`);
      check(j.exportOk === true, 'export threw after resize + restyle');
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

// Scenarios may be sync or async — awaiting a sync one's undefined is harmless,
// and a few need to parse an exported PDF, which is promise-based.
(async function main() {
  console.log(`E2E smoke suite — ${SCENARIOS.length} scenarios (electron: ${path.basename(electronPath)})\n`);
  for (const sc of SCENARIOS) {
    const t0 = Date.now();
    try {
      await sc.run();
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
