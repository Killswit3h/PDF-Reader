import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { PDFDocument } from 'pdf-lib';
import pkg from '../../src/shared/pdf-sign.js';

const { PdfSign } = pkg;

// ---- helpers -------------------------------------------------------------
function u8ToBin(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

// Build a throwaway self-signed identity + PKCS#12 (never a real key).
function makeSelfSignedP12(passphrase) {
  const keys = forge.pki.rsa.generateKeyPair(1024); // small = fast; test-only
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(2020, 0, 1);
  cert.validity.notAfter = new Date(2035, 0, 1);
  const attrs = [{ name: 'commonName', value: 'Test Signer' }, { name: 'organizationName', value: 'Test Org' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' });
  const der = forge.asn1.toDer(asn1).getBytes();
  return Uint8Array.from(der, (c) => c.charCodeAt(0) & 0xff);
}

async function makePdf(text) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  page.drawText(text || 'Sign me', { x: 50, y: 350, size: 18 });
  return doc.save();
}

// Pull the OID's attribute value out of a forge authenticatedAttributes array.
function attrValue(attrs, oid) {
  for (const a of attrs) {
    if (forge.asn1.derToOid(a.value[0].value) === oid) return a.value[1].value[0].value;
  }
  return null;
}

// Verify a signed PDF the way a validator does: the PKCS#7 verifies over its
// authenticated attributes, and the embedded messageDigest equals SHA-256 of
// the ByteRange content. Returns { sigValid, digestMatch }.
function verifySigned(signed) {
  const text = u8ToBin(signed);
  const m = text.match(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/);
  const [, , l1, p2, l3] = m.map(Number);
  const content = new Uint8Array(l1 + l3);
  content.set(signed.subarray(0, l1), 0);
  content.set(signed.subarray(p2, p2 + l3), l1);
  const md = forge.md.sha256.create();
  md.update(u8ToBin(content));

  const hex = u8ToBin(signed.subarray(l1 + 1, p2 - 1));
  const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(forge.util.hexToBytes(hex)), { parseAllBytes: false }));
  const authAttrs = p7.rawCapture.authenticatedAttributes;
  const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, authAttrs);
  const attrsMd = forge.md.sha256.create();
  attrsMd.update(forge.asn1.toDer(set).getBytes());
  return {
    sigValid: p7.certificates[0].publicKey.verify(attrsMd.digest().bytes(), p7.rawCapture.signature),
    digestMatch: attrValue(authAttrs, forge.pki.oids.messageDigest) === md.digest().bytes()
  };
}

// ---- tests ---------------------------------------------------------------
describe('PdfSign.signPdf', () => {
  it('produces a cryptographically valid, document-bound signature', async () => {
    const pass = 's3cret';
    const p12 = makeSelfSignedP12(pass);
    const pdf = await makePdf('Confidential agreement');

    const signed = await PdfSign.signPdf(pdf, p12, {
      passphrase: pass, reason: 'I approve', name: 'Test Signer', location: 'Earth'
    });

    // Structurally a signed PDF.
    const text = u8ToBin(signed);
    expect(signed).toBeInstanceOf(Uint8Array);
    expect(signed.length).toBeGreaterThan(pdf.length);
    expect(text).toContain('/Type /Sig');
    expect(text).toContain('/SubFilter /adbe.pkcs7.detached');

    // Parse the real ByteRange (placeholder must be gone).
    const m = text.match(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/);
    expect(m).toBeTruthy();
    const [, a, l1, p2, l3] = m.map(Number);
    expect(a).toBe(0);

    // Reconstruct exactly what a validator hashes: everything except <Contents>.
    const content = new Uint8Array(l1 + l3);
    content.set(signed.subarray(0, l1), 0);
    content.set(signed.subarray(p2, p2 + l3), l1);
    const md = forge.md.sha256.create();
    md.update(u8ToBin(content));
    const contentDigest = md.digest().bytes();

    // Extract + parse the PKCS#7 from between the < > at offset l1.
    const hex = u8ToBin(signed.subarray(l1 + 1, p2 - 1));
    const der = forge.util.hexToBytes(hex);
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(der), { parseAllBytes: false }));

    // 1) The signature verifies over the authenticated attributes.
    const authAttrs = p7.rawCapture.authenticatedAttributes;
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, authAttrs);
    const attrsDer = forge.asn1.toDer(set).getBytes();
    const attrsMd = forge.md.sha256.create();
    attrsMd.update(attrsDer);
    const cert = p7.certificates[0];
    expect(cert.publicKey.verify(attrsMd.digest().bytes(), p7.rawCapture.signature)).toBe(true);

    // 2) The signed messageDigest attribute equals SHA-256 of the document's
    //    ByteRange — i.e. the signature is bound to *this* content, not just
    //    internally consistent. This is what proves the ByteRange wiring.
    const signedDigest = attrValue(authAttrs, forge.pki.oids.messageDigest);
    expect(signedDigest).toBe(contentDigest);
  }, 30000);

  it('stays cryptographically valid with a visible signature block', async () => {
    const pass = 'vis';
    const p12 = makeSelfSignedP12(pass);
    const signed = await PdfSign.signPdf(await makePdf('Visible test'), p12, {
      passphrase: pass, name: 'Jane Doe', reason: 'Approved',
      visible: { pageIndex: 0, corner: 'bl' }
    });
    const v = verifySigned(signed);
    expect(v.sigValid).toBe(true);
    expect(v.digestMatch).toBe(true);   // draw-then-sign composes correctly
  }, 30000);

  it('rejects a wrong passphrase', async () => {
    const p12 = makeSelfSignedP12('right');
    const pdf = await makePdf();
    await expect(PdfSign.signPdf(pdf, p12, { passphrase: 'wrong' })).rejects.toBeTruthy();
  }, 30000);

  it('detects tampering — editing after signing breaks the digest match', async () => {
    const pass = 'p';
    const p12 = makeSelfSignedP12(pass);
    const signed = await PdfSign.signPdf(await makePdf('original'), p12, { passphrase: pass });

    const text = u8ToBin(signed);
    const [, , l1, p2, l3] = text.match(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/).map(Number);
    // Flip a byte inside the signed range (before Contents).
    const tampered = signed.slice();
    tampered[10] = tampered[10] ^ 0xff;

    const content = new Uint8Array(l1 + l3);
    content.set(tampered.subarray(0, l1), 0);
    content.set(tampered.subarray(p2, p2 + l3), l1);
    const md = forge.md.sha256.create();
    md.update(u8ToBin(content));

    const hex = u8ToBin(signed.subarray(l1 + 1, p2 - 1));
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(forge.util.hexToBytes(hex)), { parseAllBytes: false }));
    const signedDigest = attrValue(p7.rawCapture.authenticatedAttributes, forge.pki.oids.messageDigest);
    expect(md.digest().bytes()).not.toBe(signedDigest); // tamper detected
  }, 30000);
});
