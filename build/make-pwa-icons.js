// Generate the PWA / "Add to Home Screen" icon set from the SAME artwork as the
// desktop and Android launchers (build/make-icon.js, build/make-android-icons.js):
// a blueprint-blue tile with the FieldMark check + amber marker dot. Pure Node,
// no native deps — mirrors the other icon scripts' PNG encoder so the whole app
// keeps one identity across Windows, macOS, Android and the hosted web app.
//
//   node build/make-pwa-icons.js <out-dir>
//   (defaults to dist-pwa/icons; created by scripts/build-pwa.js)
//
// Emits, into <out-dir>:
//   icon-192.png / icon-512.png            "any" purpose (rounded blue tile)
//   maskable-192.png / maskable-512.png    "maskable" purpose (full-bleed, safe-zone)
//   apple-touch-icon.png (180)             iOS home-screen icon (full-bleed, opaque)

'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join(__dirname, '..', 'dist-pwa', 'icons');

// Blueprint blue (top of the desktop icon's gradient) + FieldMark amber dot.
const BLUE = { r: 47, g: 111, b: 237 };
const AMBER = { r: 232, g: 163, b: 61 };

// ---- FieldMark check path, in normalized [0,1] coordinates (matches logo.svg) ----
const MK = { A: { x: 0.279, y: 0.545 }, B: { x: 0.430, y: 0.690 }, C: { x: 0.721, y: 0.372 } };
const DOT = { x: 0.721, y: 0.359, r: 0.052 };
function squigglePoint(u) {
  if (u < 0.5) { const t = u / 0.5; return { x: MK.A.x + (MK.B.x - MK.A.x) * t, y: MK.A.y + (MK.B.y - MK.A.y) * t }; }
  const t = (u - 0.5) / 0.5; return { x: MK.B.x + (MK.C.x - MK.B.x) * t, y: MK.B.y + (MK.C.y - MK.B.y) * t };
}
// Bounding box of the whole mark (path + dot) — used to re-center it in the
// maskable safe zone, exactly as make-android-icons.js does for adaptive icons.
const BBOX = (() => {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (let t = 0; t <= 1000; t++) {
    const p = squigglePoint(t / 1000);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  x0 = Math.min(x0, DOT.x - DOT.r); x1 = Math.max(x1, DOT.x + DOT.r);
  y0 = Math.min(y0, DOT.y - DOT.r); y1 = Math.max(y1, DOT.y + DOT.r);
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
})();

// Render an RGBA icon of side S.
//  - 'tile':     rounded-rect blue background + full-bleed mark (manifest "any")
//  - 'maskable': full-bleed square blue background + mark centered in the inner
//                ~60% safe zone (manifest "maskable" + iOS apple-touch-icon,
//                which both apply their own outer mask and dislike transparency)
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
  const bg = (x, y) => { const t = y / S; px(x, y, Math.round(BLUE.r + t * 10), Math.round(BLUE.g - t * 20), Math.round(BLUE.b - t * 40), 255); };

  // ---- background ----
  if (mode === 'maskable') {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) bg(x, y); // full bleed, opaque
  } else { // 'tile'
    const rad = 46 / 256 * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const cx = Math.min(Math.max(x, rad), S - 1 - rad);
      const cy = Math.min(Math.max(y, rad), S - 1 - rad);
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= rad * rad) bg(x, y);
    }
  }

  // ---- mark placement ----
  let map, scale;
  const baseBrush = 13 / 256; // bold check, as a fraction of the side
  if (mode === 'maskable') {
    scale = 0.60 / Math.max(BBOX.w, BBOX.h); // fit the mark into the inner 60%
    map = (p) => ({ x: (0.5 + (p.x - BBOX.cx) * scale) * S, y: (0.5 + (p.y - BBOX.cy) * scale) * S });
  } else {
    scale = 1;
    map = (p) => ({ x: p.x * S, y: p.y * S });
  }
  const brushR = Math.max(1, baseBrush * scale * S);
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
  const dr = DOT.r * scale * S, drc = Math.ceil(dr);
  for (let dy = -drc; dy <= drc; dy++) for (let dx = -drc; dx <= drc; dx++)
    if (dx * dx + dy * dy <= dr * dr) px(dc.x + dx, dc.y + dy, AMBER.r, AMBER.g, AMBER.b, 255);
  return buf;
}

// ---- PNG encoder (same approach as make-icon.js / make-android-icons.js) ----
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

function writePng(name, S, mode) {
  fs.writeFileSync(path.join(OUT, name), encodePng(render(S, mode), S));
}

fs.mkdirSync(OUT, { recursive: true });
writePng('icon-192.png', 192, 'tile');
writePng('icon-512.png', 512, 'tile');
writePng('maskable-192.png', 192, 'maskable');
writePng('maskable-512.png', 512, 'maskable');
writePng('apple-touch-icon.png', 180, 'maskable');

console.log('[pwa-icons] wrote icon-192/512, maskable-192/512, apple-touch-icon (180) to ' + OUT);
