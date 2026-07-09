// Generate the Android launcher icon set from the SAME artwork as the desktop
// icon (build/make-icon.js): a blueprint-blue tile with a white signature
// squiggle. Pure Node, no native deps — mirrors make-icon.js's PNG encoder.
//
// The generated android/ project is git-ignored and recreated by `cap add`, so
// this runs after `cap sync` (see the android:* npm scripts and CI) to overwrite
// Capacitor's default launcher icons in place.
//
//   node build/make-android-icons.js <res-dir>
//   (defaults to android/app/src/main/res)

'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const RES = process.argv[2] || path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

// Blueprint blue (top of the desktop icon's gradient); used as the adaptive
// background color and the tile fill.
const BLUE = { r: 47, g: 111, b: 237 };
const AMBER = { r: 232, g: 163, b: 61 }; // FieldMark marker dot

// ---- FieldMark check path, in normalized [0,1] coordinates ----
// A bold two-segment check (matches src/assets/logo.svg, scaled from its 1024
// space). The marker dot sits at the check's tip (point C).
const MK = { A: { x: 0.279, y: 0.545 }, B: { x: 0.430, y: 0.690 }, C: { x: 0.721, y: 0.372 } };
const DOT = { x: 0.721, y: 0.359, r: 0.052 };
function squigglePoint(u) {
  if (u < 0.5) { const t = u / 0.5; return { x: MK.A.x + (MK.B.x - MK.A.x) * t, y: MK.A.y + (MK.B.y - MK.A.y) * t }; }
  const t = (u - 0.5) / 0.5; return { x: MK.B.x + (MK.C.x - MK.B.x) * t, y: MK.B.y + (MK.C.y - MK.B.y) * t };
}
// Bounding box of the path (precomputed by sampling) — used to re-center and
// scale the mark into the adaptive foreground's safe zone.
const BBOX = (() => {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (let t = 0; t <= 1000; t++) {
    const p = squigglePoint(t / 1000);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  // include the marker dot so the whole mark centers in the safe zone
  x0 = Math.min(x0, DOT.x - DOT.r); x1 = Math.max(x1, DOT.x + DOT.r);
  y0 = Math.min(y0, DOT.y - DOT.r); y1 = Math.max(y1, DOT.y + DOT.r);
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
})();

// Render an RGBA icon of side S. mode: 'tile' | 'round' | 'foreground'.
//  - tile:       rounded-rect blue background + full-bleed squiggle (legacy)
//  - round:      blue circle background + squiggle (legacy round)
//  - foreground: transparent background + squiggle centered in the safe zone
//                (adaptive foreground; the blue comes from the background color)
function render(S, mode) {
  const buf = Buffer.alloc(S * S * 4);
  const px = (x, y, r, g, b, a) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const na = a / 255, ia = 1 - na;
    buf[i] = Math.round(r * na + buf[i] * ia);
    buf[i + 1] = Math.round(g * na + buf[i + 1] * ia);
    buf[i + 2] = Math.round(b * na + buf[i + 2] * ia);
    buf[i + 3] = Math.max(buf[i + 3], a);
  };

  // ---- background ----
  if (mode === 'tile') {
    const rad = 46 / 256 * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const cx = Math.min(Math.max(x, rad), S - 1 - rad);
      const cy = Math.min(Math.max(y, rad), S - 1 - rad);
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= rad * rad) {
        const t = y / S;
        px(x, y, Math.round(BLUE.r + t * 10), Math.round(BLUE.g - t * 20), Math.round(BLUE.b - t * 40), 255);
      }
    }
  } else if (mode === 'round') {
    const c = (S - 1) / 2, rr = S / 2;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x - c, dy = y - c;
      if (dx * dx + dy * dy <= rr * rr) {
        const t = y / S;
        px(x, y, Math.round(BLUE.r + t * 10), Math.round(BLUE.g - t * 20), Math.round(BLUE.b - t * 40), 255);
      }
    }
  }

  // ---- placement of the squiggle ----
  // tile/round use the artwork's native placement; foreground re-centers it into
  // the central ~60% (Android masks the outer ring of an adaptive icon).
  let map, brushR;
  const baseBrush = 13 / 256; // brush radius as a fraction of side (bold check)
  if (mode === 'foreground') {
    const scale = 0.60 / Math.max(BBOX.w, BBOX.h);
    map = (p) => ({ x: (0.5 + (p.x - BBOX.cx) * scale) * S, y: (0.5 + (p.y - BBOX.cy) * scale) * S });
    brushR = Math.max(1, baseBrush * scale * S);
  } else {
    map = (p) => ({ x: p.x * S, y: p.y * S });
    brushR = Math.max(1, baseBrush * S);
  }
  const brush = (x, y) => {
    const rr = Math.ceil(brushR);
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++)
      if (dx * dx + dy * dy <= brushR * brushR) px(x + dx, y + dy, 255, 255, 255, 255);
  };
  let prev = null;
  for (let t = 0; t <= 1000; t++) {
    const p = map(squigglePoint(t / 1000));
    if (prev) {
      const steps = Math.max(1, Math.round(Math.max(Math.abs(p.x - prev.x), Math.abs(p.y - prev.y))));
      for (let s = 0; s <= steps; s++) brush(prev.x + (p.x - prev.x) * s / steps, prev.y + (p.y - prev.y) * s / steps);
    }
    prev = p;
  }
  // amber marker dot at the check's tip
  const dc = map(DOT);
  const dr = DOT.r * (mode === 'foreground' ? (0.60 / Math.max(BBOX.w, BBOX.h)) : 1) * S;
  const drc = Math.ceil(dr);
  for (let dy = -drc; dy <= drc; dy++) for (let dx = -drc; dx <= drc; dx++)
    if (dx * dx + dy * dy <= dr * dr) px(dc.x + dx, dc.y + dy, AMBER.r, AMBER.g, AMBER.b, 255);
  return buf;
}

// ---- PNG encoder (same approach as make-icon.js) ----
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(buf, S) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- write the launcher icon set ----
// Baseline 48dp legacy icons and 108dp adaptive foregrounds, per density.
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

function writePng(dir, name, S, mode) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), encodePng(render(S, mode), S));
}

if (!fs.existsSync(RES)) {
  console.error('[android-icons] res dir not found:', RES, '\n  run `npx cap add android` first.');
  process.exit(1);
}

for (const [d, mult] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${d}`);
  writePng(dir, 'ic_launcher.png', Math.round(48 * mult), 'tile');
  writePng(dir, 'ic_launcher_round.png', Math.round(48 * mult), 'round');
  writePng(dir, 'ic_launcher_foreground.png', Math.round(108 * mult), 'foreground');
}

// Adaptive background: the white default → app blue, so the masked icon is a
// blue tile with the white mark (matching the desktop icon).
const hex = '#' + [BLUE.r, BLUE.g, BLUE.b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
fs.writeFileSync(path.join(RES, 'values', 'ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">' + hex + '</color>\n</resources>\n');

console.log('[android-icons] wrote launcher icons (5 densities) + background ' + hex + ' to ' + RES);
