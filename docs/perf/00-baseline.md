# 00 — Baseline (Phase 0 of `BRIEF.md`)

Measured at v1.25.0 + the Phase 0 apparatus, before any product change. Every
later phase's PR reports its numbers against this table, produced by the same
probe (`bench/probe.js`) through the same three drivers. The raw JSON for each
row lives in `results/`.

## How to reproduce

```bash
npm run bench                 # www/ in headless Chromium, desktop shape (1440x900, dpr 1)
npm run bench:tablet-shape    # same engine shaped like an iPad: 1024x1366, dpr 2, touch
npm run bench:electron        # the real Electron app (wrap in xvfb-run on a headless Linux box)
npm run bench:serve           # LAN server for a real iPad / Android tablet: open the URL,
                              # tap "Bench", then "Upload"; the table prints in the terminal
```

Each run writes `docs/perf/results/<label>-<timestamp>.json` and prints the
markdown table (`App.PerfStats.reportRows`). `node test/e2e/run.js perf` runs
the Electron measurement as a test scenario and prints the same table in CI.

## Environment for the numbers below

| Column | What it is |
|---|---|
| **Chromium desktop** | Headless Chromium 141 (Playwright), 1440×900, dpr 1, `--no-sandbox`, software rendering. The engine the Android WebView runs. |
| **Chromium tablet-shape** | Same engine and machine, viewport 1024×1366, dpr 2, `pointer: coarse`. Shapes the canvas budget the app requests on a dpr 2 tablet; it is **not** a device measurement. |
| **Electron** | Electron 31.7.7 (Chrome 126) under Xvfb, 1280×873, dpr 1, software GL. |
| **iPad / Android** | **Pending a device run** — no tablet is reachable from the session that built this. Fill with `npm run bench:serve` (Safari on the iPad against the served build, Chrome or the Capacitor WebView on the Android tablet) and paste the printed table here. |

Host for all three: Linux, 4 cores, 8 GB (`navigator.deviceMemory`), no GPU.
Absolute numbers on a developer Mac or a tablet will differ; the ratios and the
failure modes are what the phases are measured on. Run the bench on the same
machine before and after a change.

## Fixtures

| Fixture | Content | Size |
|---|---|---|
| `dense-plans.pdf` | 120 ANSI D sheets; ≥ 44,000 path segments executed per page (guardrail runs in shared form XObjects placed per page, plus unique stationing, labels, border and title block) | 3.0 MB |
| `scanned-set.pdf` | 40 ANSI D sheets, each a unique 6600×10200 px 1-bit image (300 DPI) | 4.3 MB |
| `heavy-markup.pdf` | 1 ANSI D sheet + FieldMark sidecar: 500 ink (40–80 pts each), 500 polyline, 300 cloud, 400 rect, 300 text = 2,000 annotations; 180 length + 60 perimeter + 60 area = 300 measurements on a 1" = 20' scale | 0.3 MB |

All three are byte-deterministic (seeded PRNG, pinned dates). `scanned-set.pdf`
is not driven by the probe yet; it is committed for Phase 1's canvas budget and
Phase 8's OCR and compare work.

## The numbers

Targets are from `BRIEF.md` Phase 0. Bold values fail the target on that column.

| Metric | Target | Chromium desktop | Chromium tablet-shape | Electron | iPad | Android |
|---|---|---|---|---|---|---|
| First page painted, cold open (dense-plans.pdf) | — | 1,140 ms | 1,351 ms | 1,016 ms | pending | pending |
| First page painted, warm open (dense-plans.pdf) | < 1,500 ms (iPad) | 904 ms | 1,476 ms | 859 ms | pending | pending |
| Pinch end → current page sharp at 200% | — | **2,181 ms** | **15,779 ms** | **1,040 ms** | pending | pending |
| Pinch end → all visible pages sharp at 200% | — | 2,190 ms | 15,785 ms | 1,050 ms | pending | pending |
| Pinch end → current page sharp at 400% | < 300 ms | **3,125 ms** | 258 ms † | **2,300 ms** | pending | pending |
| Pinch end → all visible pages sharp at 400% | — | 3,130 ms | 263 ms † | 2,307 ms | pending | pending |
| Longest task during 3 s pan at 200% | ≤ 100 ms | **833 ms** | **2,716 ms** | 0 ms ‡ | pending | pending |
| Long tasks over 100 ms during pan | 0 | **2** | **5** | 0 | pending | pending |
| Longest frame gap during pan | — | 834 ms | 2,686 ms | 47 ms | pending | pending |
| Frames over 16.7 ms during pan | — | 50 of 53 | 2 of 2 | 87 of 174 | pending | pending |
| Total canvas memory at 400% | < 200 MB desktop, < 100 MB tablet | **523 MB** | **2,086 MB** | **528 MB** | pending | pending |
| Largest single canvas at 400% | ≤ 16.7 MP on any WebView | 67.1 MP | **268.5 MP** | 67.1 MP | pending | pending |
| Canvases in the DOM at 400% | — | 4 | 5 | 5 | pending | pending |
| Current page canvas actually painted at 400% | yes | yes | **NO (blank)** | yes | pending | pending |
| JS heap used after the dense set | — | 48 MB | 45 MB | 61 MB § | pending | n/a on Safari |
| Open heavy-markup.pdf (sidecar parse + first paint) | — | 788 ms | 870 ms | 686 ms | pending | pending |
| `App.Markup.repositionAll()` with 2,000 markups | — | 46 ms | 59 ms | 84 ms | pending | pending |
| `App.Measure.repositionAll()` with 300 measurements | — | 9 ms | 12 ms | 14 ms | pending | pending |
| Select one markup | < 16 ms | **107 ms** | **117 ms** | **230 ms** | pending | pending |
| Drag, 60 pointermoves: main-thread work per move (mean) | < 16 ms | **59 ms** | **75 ms** | **92 ms** | pending | pending |
| Drag, 60 pointermoves: worst move | < 16 ms | **156 ms** | **297 ms** | **235 ms** | pending | pending |
| Drag, 60 pointermoves: moves over 16 ms | 0 | **60** | **60** | **60** | pending | pending |
| Undo | < 16 ms | **211 ms** | **537 ms** | **262 ms** | pending | pending |
| JS heap used after heavy-markup.pdf | — | 49 MB | 206 MB | 61 MB § | pending | n/a on Safari |

† **Not a pass.** The tablet-shape run at 400% asks PDF.js for a
12,672 × 19,584 px canvas (268 MP, within the app's 2^28 `maxCanvasPixels` at
dpr 2). Chromium reports the render FINISHED in 258 ms and the pixel readback
finds the canvas empty: the backing store was never allocated. This is the
"silently goes blank" failure `BRIEF.md` Phase 1 describes, reproduced on the
desktop engine. The same run's 15.8 s at 200% (a 67 MP canvas that *does*
allocate) is what the tablet pays before it blanks.

‡ Electron's pan produced no `longtask` entry (the observer's threshold is
50 ms) and a worst frame gap of 47 ms. The headless Chromium runs of the same
scroll hit 833 ms and 2,716 ms tasks: the difference is the page render that
lands mid-scroll (Chrome 126 vs 141, and Electron's compositor vs headless
software rendering), not the app. Treat the Chromium column as the WebView
number and the Electron column as the desktop number.

§ Electron's `performance.memory` is the quantized legacy API (values are
bucketed and rate-limited), which is why both heap rows read the same 61 MB.
Use the Chromium columns for heap deltas.

## What the baseline says, in the order the brief attacks it

1. **Phase 1 (canvas budget).** At dpr 2 the app requests a 268 MP canvas and
   gets a blank one; at dpr 1 it holds 523–528 MB of canvas at 400%, 2.6× the
   desktop target and 5× the tablet target. The largest canvas is 4× the WebView
   cap even on desktop. The paint readback row is the assertion Phase 1 must
   turn green on the tablet-shape run.
2. **Phase 3 (overlay rebuild).** With 2,000 markups the SVG holds 3,300 nodes
   and every interaction rebuilds it: select 107–230 ms, every one of 60 drag
   moves over 16 ms (mean 59–92 ms, worst 156–297 ms), undo 211–537 ms. All
   four are 4–30× the 16 ms target. `repositionAll` itself is 46–84 ms; the
   select and drag costs on top of it are the panel re-render and the
   per-move snap-candidate rebuild the brief calls out.
3. **Pinch.** 200% → 1.0–2.2 s, 400% → 2.3–3.1 s to a sharp page on the dense
   set, 8–10× the 300 ms target. The 140 ms settle timer is not the cost; the
   rasterization of a 45k-segment sheet into a 67 MP canvas is.
4. **Open.** Warm open is 0.86–1.48 s. The desktop shapes clear the 1.5 s iPad
   target with little margin on a 4-core host with no GPU; the tablet-shape
   run at dpr 2 does not.
5. **Heap.** 45–48 MB after the dense set in Chromium; 206 MB after the heavy
   fixture on the dpr 2 shape (49 MB at dpr 1), which is the 2 GB of canvas
   backing store showing up as GC pressure, not the markup model.

## Caveats

- Headless Chromium has no GPU here; frame-gap counts during pan are inflated
  by software compositing and should be read as "long tasks and worst frame",
  not as an FPS claim.
- The pan runs at 200% (the zoom the pinch just landed on), scrolling at
  900 px/s for 3 s, which brings two to three new pages into view.
- `long-animation-frame` is supported by both engines; its numbers are in the
  JSON (`pan.longAnimationFrames`). Safari supports neither it nor `longtask`,
  so the device rows will show `n/a` there and the frame-gap rows carry the
  signal.
- `App.VERSION` is not exposed to the renderer, so `env.version` is null in the
  JSON; the label and the user agent identify the build.
