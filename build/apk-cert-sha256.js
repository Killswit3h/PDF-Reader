'use strict';

/*
 * Print the SHA-256 (lowercase hex, no colons) of an APK's v2/v3 signing
 * certificate — the value Android compares when deciding whether a new APK may
 * update an installed one. Used by CI to assert every release is signed with the
 * committed debug keystore (build/debug.keystore) so updates install in place.
 *
 *   node build/apk-cert-sha256.js path/to/app.apk
 *
 * No Android SDK / apksigner needed: parses the APK Signing Block directly.
 */
const fs = require('fs');
const crypto = require('crypto');

function certSha256(file) {
  const buf = fs.readFileSync(file);

  // End of Central Directory (0x06054b50), scanned from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no EOCD (not a zip/apk?)');
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // APK Signing Block precedes the central directory.
  if (buf.slice(cdOffset - 16, cdOffset).toString('latin1') !== 'APK Sig Block 42') {
    throw new Error('no APK Signing Block (unsigned or v1-only)');
  }
  const size = Number(buf.readBigUInt64LE(cdOffset - 24));
  const blockStart = cdOffset - size - 8;
  const pairsEnd = cdOffset - 24;

  let value = null; // prefer v2 (0x7109871a); fall back to v3 (0xf05368c0)
  for (let pos = blockStart + 8; pos + 12 <= pairsEnd;) {
    const pairLen = Number(buf.readBigUInt64LE(pos));
    const id = buf.readUInt32LE(pos + 8);
    const val = buf.slice(pos + 12, pos + 8 + pairLen);
    if (id === 0x7109871a) value = val;
    else if (id === 0xf05368c0 && !value) value = val;
    pos += 8 + pairLen;
  }
  if (!value) throw new Error('no v2/v3 signature block');

  // Length-prefixed (uint32 LE): signers -> signer -> signedData ->
  // (digests) (certificates -> first cert = DER X.509).
  let p = 0;
  const u32 = () => { const n = value.readUInt32LE(p); p += 4; return n; };
  u32();                        // signers sequence length
  u32();                        // first signer length
  u32();                        // signed data length
  const digestsLen = u32();     // digests sequence length
  p += digestsLen;              // skip digests (NB: separate stmt — `p += u32()`
                                // would capture p before u32() advances it)
  u32();                        // certificates sequence length
  const certLen = u32();        // first certificate length
  const der = value.slice(p, p + certLen);
  return crypto.createHash('sha256').update(der).digest('hex');
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node build/apk-cert-sha256.js app.apk'); process.exit(2); }
  try { process.stdout.write(certSha256(file) + '\n'); }
  catch (e) { console.error('apk-cert-sha256: ' + e.message); process.exit(1); }
}

module.exports = { certSha256 };
