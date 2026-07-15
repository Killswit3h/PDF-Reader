// Generate the iOS app-icon set from the SAME artwork as the desktop/Android
// icons: a blueprint-blue tile with a white FieldMark check + amber marker dot.
// Pure Node, no native deps — mirrors make-android-icons.js's PNG encoder.
//
// iOS is stricter than Android about app icons:
//   - NO alpha channel and NO rounded corners (the OS masks corners itself; a
//     transparent or pre-rounded icon is rejected by App Store / looks wrong).
// So this renders a FULL-BLEED, fully OPAQUE square and lets iOS do the masking.
//
// Modern Xcode (14+) accepts a single 1024×1024 "universal" icon, so we emit one
// PNG plus a matching Contents.json — far simpler than the legacy per-size grid.
//
// The generated ios/ project is git-ignored and recreated by `cap add ios`, so
// this runs after `cap sync ios` (see the ios:* npm scripts and CI) to overwrite
// Capacitor's default AppIcon in place.
//
//   node build/make-ios-icons.js [<AppIcon.appiconset dir>]
//   (defaults to ios/App/App/Assets.xcassets/AppIcon.appiconset)

'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SET = process.argv[2] ||
  path.join(__dirname, '..', 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');

// Blueprint blue (top of the desktop icon's gradient) + amber marker dot —
// identical palette to build/make-android-icons.js so all platforms match.
const BLUE = { r: 47, g: 111, b: 237 };
const AMBER = { r: 232, g: 163, b: 61 };

// ---- FieldMark check path, normalized [0,1] (same control points as Android) ----
const MK = { A: { x: 0.279, y: 0.545 }, B: { x: 0.430, y: 0.690 }, C: { x: 0.721, y: 0.372 } };
const DOT = { x: 0.721, y: 0.359, r: 0.052 };
function squigglePoint(u) {
  if (u < 0.5) { const t = u / 0.5; return { x: MK.A.x + (MK.B.x - MK.A.x) * t, y: MK.A.y + (MK.B.y - MK.A.y) * t }; }
  const t = (u - 0.5) / 0.5; return { x: MK.B.x + (MK.C.x - MK.B.x) * t, y: MK.B.y + (MK.C.y - MK.B.y) * t };
}

// Render an OPAQUE RGBA icon of side S: full-bleed blue gradient background, the
// white check drawn over it, amber dot at the tip. Every pixel is alpha 255.
function render(S) {
  const buf = Buffer.alloc(S * S * 4);
  // Opaque background: the same top→bottom blue gradient the desktop icon uses,
  // painted edge to edge (no rounding — iOS masks the corners).
  for (let y = 0; y < S; y++) {
    const t = y / S;
    const r = Math.round(BLUE.r + t * 10);
    const g = Math.round(BLUE.g - t * 20);
    const b = Math.round(BLUE.b - t * 40);
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  // Opaque paint helper (no blending needed — icon has no transparency).
  const px = (x, y, r, g, b) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  };

  const brushR = Math.max(1, (13 / 256) * S); // bold check, same weight as Android tile
  const brush = (x, y) => {
    const rr = Math.ceil(brushR);
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++)
      if (dx * dx + dy * dy <= brushR * brushR) px(x + dx, y + dy, 255, 255, 255);
  };
  let prev = null;
  for (let t = 0; t <= 1000; t++) {
    const p = { x: squigglePoint(t / 1000).x * S, y: squigglePoint(t / 1000).y * S };
    if (prev) {
      const steps = Math.max(1, Math.round(Math.max(Math.abs(p.x - prev.x), Math.abs(p.y - prev.y))));
      for (let s = 0; s <= steps; s++) brush(prev.x + (p.x - prev.x) * s / steps, prev.y + (p.y - prev.y) * s / steps);
    }
    prev = p;
  }
  // amber marker dot at the check's tip
  const dc = { x: DOT.x * S, y: DOT.y * S };
  const dr = DOT.r * S, drc = Math.ceil(dr);
  for (let dy = -drc; dy <= drc; dy++) for (let dx = -drc; dx <= drc; dx++)
    if (dx * dx + dy * dy <= dr * dr) px(dc.x + dx, dc.y + dy, AMBER.r, AMBER.g, AMBER.b);
  return buf;
}

// ---- PNG encoder (same approach as make-android-icons.js) ----
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
// Encode as 8-bit truecolor RGB (PNG color type 2) — NOT RGBA. App Store icon
// validation rejects any alpha channel, so we drop it here even though every
// source pixel is opaque. Input `buf` is the RGBA render buffer; we pack the
// R,G,B bytes and skip A per pixel.
function encodePng(buf, S) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const stride = S * 3 + 1; // 3 bytes/pixel + 1 filter byte per scanline
  const raw = Buffer.alloc(S * stride);
  for (let y = 0; y < S; y++) {
    let o = y * stride; raw[o++] = 0; // filter: none
    const rowStart = y * S * 4;
    for (let x = 0; x < S; x++) {
      const i = rowStart + x * 4;
      raw[o++] = buf[i]; raw[o++] = buf[i + 1]; raw[o++] = buf[i + 2];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- write the AppIcon.appiconset ----
if (!fs.existsSync(SET)) {
  console.error('[ios-icons] AppIcon set not found:', SET, '\n  run `npx cap add ios` first.');
  process.exit(1);
}

const ICON = 'AppIcon-1024.png';
fs.writeFileSync(path.join(SET, ICON), encodePng(render(1024), 1024));

// Single universal icon entry (Xcode 14+). Overwrites Capacitor's default grid.
const contents = {
  images: [{ filename: ICON, idiom: 'universal', platform: 'ios', size: '1024x1024' }],
  info: { author: 'xcode', version: 1 }
};
fs.writeFileSync(path.join(SET, 'Contents.json'), JSON.stringify(contents, null, 2) + '\n');

console.log('[ios-icons] wrote', ICON, '(1024×1024, opaque) + Contents.json to', SET);
