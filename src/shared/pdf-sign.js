'use strict';

/*
 * Real (PKI / PAdES) PDF digital signing — offline, browser-safe.
 *
 * This is a dependency-free port of the well-known @signpdf algorithm
 * (placeholder + ByteRange + adbe.pkcs7.detached) rewritten to run in the
 * WebView with NO Node `Buffer`: bytes are Uint8Array throughout, and the
 * crypto is node-forge (which ships a browser build) + the pdf-lib we already
 * bundle. Because it never leaves the renderer it ships to Windows, macOS and
 * Android from one implementation, and it stays fully offline — the .p12 key
 * and its passphrase are used only here, in memory, and never persisted or
 * transmitted.
 *
 * The crypto is intentionally identical in shape to @signpdf so the output
 * validates the same way (Adobe shows the signature panel; a trusted CA cert —
 * e.g. an AATL member — shows the green "valid" state). Unit-tested in Node
 * against a self-signed identity in test/unit/pdf-sign.test.js.
 *
 * Dual export: `require()` in Node returns { PdfSign }; a <script> tag assigns
 * App.PdfSign. node-forge and pdf-lib are resolved from globals in the browser
 * (window.forge / window.PDFLib) or via require() in Node.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_SIGNATURE_LENGTH = 8192;         // reserved bytes for the PKCS#7
  const BYTE_RANGE_PLACEHOLDER = '**********';   // 10 chars, matches @signpdf
  const SUBFILTER = 'adbe.pkcs7.detached';

  function resolveForge() {
    if (typeof self !== 'undefined' && self.forge) return self.forge;
    if (typeof require !== 'undefined') return require('node-forge');
    throw new Error('node-forge is not available');
  }
  function resolvePDFLib() {
    if (typeof self !== 'undefined' && self.PDFLib) return self.PDFLib;
    if (typeof require !== 'undefined') return require('pdf-lib');
    throw new Error('pdf-lib is not available');
  }

  /* ---------- byte helpers (Uint8Array, no Buffer) ---------- */
  function strToU8(str) {
    const u = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 0xff;
    return u;
  }
  function u8ToBinary(u8) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return s;
  }
  function u8Concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  function indexOfStr(u8, str, from) {
    const pat = strToU8(str);
    const start = Math.max(0, from || 0);
    for (let i = start; i <= u8.length - pat.length; i++) {
      let ok = true;
      for (let j = 0; j < pat.length; j++) { if (u8[i + j] !== pat[j]) { ok = false; break; } }
      if (ok) return i;
    }
    return -1;
  }
  function binToHex(bin) {
    let h = '';
    for (let i = 0; i < bin.length; i++) h += (bin.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
    return h;
  }
  function sliceLastChar(u8, ch) {
    if (u8.length && u8[u8.length - 1] === ch.charCodeAt(0)) return u8.subarray(0, u8.length - 1);
    return u8;
  }
  // Trim a trailing newline and assert the PDF ends with %%EOF, so ByteRange[3]
  // reaches exactly to the end of the file (per the PDF signing spec).
  function removeTrailingNewLine(u8) {
    let o = sliceLastChar(u8, '\n');
    o = sliceLastChar(o, '\r');
    const last6 = u8ToBinary(o.subarray(o.length - 6));
    if (last6 !== '\n%%EOF' && last6 !== '\r%%EOF') {
      throw new Error('A PDF file must end with an EOF line to be signed.');
    }
    return o;
  }

  /* ---------- placeholder (ported from @signpdf/placeholder-pdf-lib) ---------- */
  // Adds an AcroForm signature field + widget with a ByteRange/Contents
  // placeholder to a pdf-lib PDFDocument. widgetRect [x1,y1,x2,y2] is the
  // visible rectangle ([0,0,0,0] = invisible field). Mutates `doc`.
  function addPlaceholder(doc, opts) {
    const P = resolvePDFLib();
    const o = opts || {};
    const page = (typeof o.pageIndex === 'number' ? doc.getPages()[o.pageIndex] : doc.getPages()[0]);
    const widgetRect = o.widgetRect || [0, 0, 0, 0];
    const signingTime = o.signingTime || new Date();

    const byteRange = P.PDFArray.withContext(doc.context);
    byteRange.push(P.PDFNumber.of(0));
    byteRange.push(P.PDFName.of(BYTE_RANGE_PLACEHOLDER));
    byteRange.push(P.PDFName.of(BYTE_RANGE_PLACEHOLDER));
    byteRange.push(P.PDFName.of(BYTE_RANGE_PLACEHOLDER));

    const placeholder = P.PDFHexString.of(String.fromCharCode(0).repeat(o.signatureLength || DEFAULT_SIGNATURE_LENGTH));

    const dict = {
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: SUBFILTER,
      ByteRange: byteRange,
      Contents: placeholder,
      M: P.PDFString.fromDate(signingTime),
      Prop_Build: { Filter: { Name: 'Adobe.PPKLite' }, App: { Name: o.appName || 'PDF Signer' } }
    };
    if (o.reason) dict.Reason = P.PDFString.of(o.reason);
    if (o.name) dict.Name = P.PDFString.of(o.name);
    if (o.location) dict.Location = P.PDFString.of(o.location);
    if (o.contactInfo) dict.ContactInfo = P.PDFString.of(o.contactInfo);
    const signatureDict = doc.context.obj(dict);

    // Keep the signature dict out of an object stream (must stay plaintext so
    // the ByteRange/Contents can be located + patched after serialization).
    const buf = new Uint8Array(signatureDict.sizeInBytes());
    signatureDict.copyBytesInto(buf, 0);
    const signatureDictRef = doc.context.register(P.PDFInvalidObject.of(buf));

    const rect = P.PDFArray.withContext(doc.context);
    widgetRect.forEach((c) => rect.push(P.PDFNumber.of(c)));
    const apStream = doc.context.formXObject([], { BBox: widgetRect, Resources: {} });

    const widgetDict = doc.context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: rect,
      V: signatureDictRef, T: P.PDFString.of(o.fieldName || 'Signature1'),
      F: 4 /* PRINT */, P: page.ref, AP: { N: doc.context.register(apStream) }
    });
    const widgetDictRef = doc.context.register(widgetDict);

    let annotations = page.node.lookupMaybe(P.PDFName.of('Annots'), P.PDFArray);
    if (typeof annotations === 'undefined') annotations = doc.context.obj([]);
    annotations.push(widgetDictRef);
    page.node.set(P.PDFName.of('Annots'), annotations);

    let acroForm = doc.catalog.lookupMaybe(P.PDFName.of('AcroForm'), P.PDFDict);
    if (typeof acroForm === 'undefined') {
      acroForm = doc.context.obj({ Fields: [] });
      doc.catalog.set(P.PDFName.of('AcroForm'), doc.context.register(acroForm));
    }
    const prevFlags = acroForm.has(P.PDFName.of('SigFlags')) ? acroForm.get(P.PDFName.of('SigFlags')).asNumber() : 0;
    acroForm.set(P.PDFName.of('SigFlags'), P.PDFNumber.of(prevFlags | 1 /* SIGNATURES_EXIST */ | 2 /* APPEND_ONLY */));
    let fields = acroForm.get(P.PDFName.of('Fields'));
    if (!(fields instanceof P.PDFArray)) { fields = doc.context.obj([]); acroForm.set(P.PDFName.of('Fields'), fields); }
    fields.push(widgetDictRef);
  }

  /* ---------- PKCS#7 detached signer (ported from @signpdf/signer-p12) ---------- */
  // Produces the raw PKCS#7 as a forge "binary string" over the given bytes.
  function pkcs7Sign(pdfU8, p12U8, opts) {
    const forge = resolveForge();
    const o = opts || {};
    const p12Der = forge.util.createBuffer(u8ToBinary(p12U8));
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, o.passphrase || '');

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    let keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
    if (!keyBags || !keyBags.length) keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];
    if (!keyBags || !keyBags.length) throw new Error('No private key found in the digital ID (.p12/.pfx).');
    const privateKey = keyBags[0].key;

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(u8ToBinary(pdfU8));

    let certificate;
    Object.keys(certBags).forEach((i) => {
      const cert = certBags[i].cert;
      p7.addCertificate(cert);
      const pub = cert.publicKey;
      if (pub && pub.n && privateKey.n.compareTo(pub.n) === 0 && privateKey.e.compareTo(pub.e) === 0) certificate = cert;
    });
    if (!certificate) throw new Error('Failed to find a certificate matching the private key.');

    p7.addSigner({
      key: privateKey,
      certificate,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.signingTime, value: o.signingTime || new Date() },
        { type: forge.pki.oids.messageDigest }
      ]
    });
    p7.sign({ detached: true });
    return forge.asn1.toDer(p7.toAsn1()).getBytes();
  }

  /* ---------- embed (ported from @signpdf/signpdf core) ---------- */
  function embedSignature(pdfWithPlaceholder, signerFn) {
    let pdf = removeTrailingNewLine(pdfWithPlaceholder);

    const brPos = indexOfStr(pdf, '/ByteRange');
    if (brPos === -1) throw new Error('No ByteRange placeholder found.');
    const rangeStart = indexOfStr(pdf, '[', brPos);
    const rangeEnd = indexOfStr(pdf, ']', rangeStart);
    const byteRangePlaceholder = u8ToBinary(pdf.subarray(brPos, rangeEnd + 1));
    const byteRangeEnd = brPos + byteRangePlaceholder.length;

    const contentsTagPos = indexOfStr(pdf, '/Contents ', byteRangeEnd);
    const placeholderPos = indexOfStr(pdf, '<', contentsTagPos);
    const placeholderEnd = indexOfStr(pdf, '>', placeholderPos);
    const placeholderLengthWithBrackets = placeholderEnd + 1 - placeholderPos;
    const placeholderLength = placeholderLengthWithBrackets - 2;

    const byteRange = [0, 0, 0, 0];
    byteRange[1] = placeholderPos;
    byteRange[2] = byteRange[1] + placeholderLengthWithBrackets;
    byteRange[3] = pdf.length - byteRange[2];
    let actualByteRange = `/ByteRange [${byteRange.join(' ')}]`;
    actualByteRange += ' '.repeat(byteRangePlaceholder.length - actualByteRange.length);

    // Same-length swap of the ByteRange placeholder (offsets after it unchanged).
    pdf = u8Concat([pdf.subarray(0, brPos), strToU8(actualByteRange), pdf.subarray(byteRangeEnd)]);
    // Remove the placeholder <00..> contents; sign everything that remains.
    pdf = u8Concat([pdf.subarray(0, byteRange[1]), pdf.subarray(byteRange[2], byteRange[2] + byteRange[3])]);

    const raw = signerFn(pdf);
    if (raw.length * 2 > placeholderLength) {
      throw new Error(`Signature exceeds placeholder length: ${raw.length * 2} > ${placeholderLength}`);
    }
    let signature = binToHex(raw);
    signature += '00'.repeat(placeholderLength / 2 - raw.length);   // pad to fixed width

    return u8Concat([pdf.subarray(0, byteRange[1]), strToU8('<' + signature + '>'), pdf.subarray(byteRange[1])]);
  }

  /* ---------- public API ---------- */
  // Sign `pdfBytes` (Uint8Array/ArrayBuffer) with a PKCS#12 identity
  // (`p12Bytes`). options: { passphrase, reason, name, location, contactInfo,
  // signingTime, widgetRect, pageIndex, signatureLength }. Returns a signed
  // Uint8Array. Signing is a terminal step — editing the result invalidates it.
  async function signPdf(pdfBytes, p12Bytes, options) {
    const P = resolvePDFLib();
    const o = options || {};
    const pdfU8 = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    const p12U8 = p12Bytes instanceof Uint8Array ? p12Bytes : new Uint8Array(p12Bytes);
    const signingTime = o.signingTime || new Date();

    const doc = await P.PDFDocument.load(pdfU8, { ignoreEncryption: true });

    // Optional visible appearance: draw a bordered block with the signer lines
    // directly on the page (so it's part of the signed content), and point the
    // signature widget's rectangle at it. Purely renderer/pdf-lib drawing.
    let widgetRect = o.widgetRect || [0, 0, 0, 0];
    let pageIndex = typeof o.pageIndex === 'number' ? o.pageIndex : 0;
    if (o.visible) {
      const v = o.visible;
      pageIndex = typeof v.pageIndex === 'number' ? v.pageIndex : 0;
      const page = doc.getPages()[pageIndex];
      // Either an explicit [x,y,w,h] rect, or a corner ('bl','br','tl','tr')
      // + size, positioned in PDF points with a 36pt margin.
      let x, y, w, h;
      if (v.rect) { [x, y, w, h] = v.rect; }
      else {
        const size = page.getSize();
        w = v.width || 230; h = v.height || 66;
        const margin = 36; const corner = v.corner || 'bl';
        x = corner.indexOf('r') !== -1 ? size.width - margin - w : margin;
        y = corner.indexOf('t') !== -1 ? size.height - margin - h : margin;
      }
      const font = await doc.embedFont(P.StandardFonts.Helvetica);
      page.drawRectangle({ x, y, width: w, height: h, borderWidth: 1, borderColor: P.rgb(0.16, 0.31, 0.61), color: P.rgb(0.94, 0.96, 1) });
      let ty = y + h - 13;
      for (const line of (v.lines || [])) {
        page.drawText(String(line), { x: x + 6, y: ty, size: 9, font, color: P.rgb(0.1, 0.12, 0.22) });
        ty -= 12;
      }
      widgetRect = [x, y, x + w, y + h];
    }

    addPlaceholder(doc, Object.assign({}, o, { signingTime, widgetRect, pageIndex }));
    const withPlaceholder = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });

    return embedSignature(withPlaceholder instanceof Uint8Array ? withPlaceholder : new Uint8Array(withPlaceholder),
      (bytes) => pkcs7Sign(bytes, p12U8, { passphrase: o.passphrase, signingTime }));
  }

  return { PdfSign: { signPdf, addPlaceholder, embedSignature, pkcs7Sign, _internal: { removeTrailingNewLine, indexOfStr } } };
});
