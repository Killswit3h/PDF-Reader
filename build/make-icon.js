// Generates build/icon.ico (256x256 PNG wrapped in an ICO container).
// Pure Node, no native deps. Run: node build/make-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 256;
const buf = Buffer.alloc(S * S * 4);
function px(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a / 255, ia = 1 - na;
  buf[i]   = Math.round(r * na + buf[i]   * ia);
  buf[i+1] = Math.round(g * na + buf[i+1] * ia);
  buf[i+2] = Math.round(b * na + buf[i+2] * ia);
  buf[i+3] = Math.max(buf[i+3], a);
}
// Rounded-rect blue background
const rad = 46;
function inRounded(x, y) {
  const inX = x >= 0 && x < S, inY = y >= 0 && y < S;
  if (!inX || !inY) return false;
  const cx = Math.min(Math.max(x, rad), S - 1 - rad);
  const cy = Math.min(Math.max(y, rad), S - 1 - rad);
  const dx = x - cx, dy = y - cy;
  return dx*dx + dy*dy <= rad*rad;
}
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  if (inRounded(x, y)) {
    const t = y / S;
    px(x, y, Math.round(47 + t*10), Math.round(111 - t*20), Math.round(237 - t*40), 255);
  }
}
// White signature stroke (a cursive-ish squiggle) with round brush
function brush(x, y, rr) {
  for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++)
    if (dx*dx + dy*dy <= rr*rr) px(x+dx, y+dy, 255, 255, 255, 255);
}
let prevx = null, prevy = null;
for (let t = 0; t <= 1000; t++) {
  const u = t / 1000;
  const x = Math.round(46 + u * 164);
  const y = Math.round(150 + Math.sin(u * Math.PI * 3) * 34 - u * 10);
  if (prevx !== null) {
    const steps = Math.max(Math.abs(x - prevx), Math.abs(y - prevy));
    for (let s = 0; s <= steps; s++) {
      const ix = Math.round(prevx + (x - prevx) * s / steps);
      const iy = Math.round(prevy + (y - prevy) * s / steps);
      brush(ix, iy, 7);
    }
  }
  prevx = x; prevy = y;
}

// ---- Encode PNG ----
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}
const sig = Buffer.from([137,80,78,71,13,10,26,10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
// raw scanlines with filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S*4+1)] = 0;
  buf.copy(raw, y * (S*4+1) + 1, y * S * 4, (y+1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

// ---- Wrap PNG in ICO ----
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); // reserved, type=icon, count=1
ico.writeUInt8(0, 6); ico.writeUInt8(0, 7);   // 0 => 256
ico.writeUInt8(0, 8); ico.writeUInt8(0, 9);    // colors, reserved
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); // planes, bpp
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(6 + 16, 18);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([ico, png]));
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('wrote build/icon.ico and build/icon.png (256x256)');
