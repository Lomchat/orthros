// Authenticode verification (WinVerifyTrust): hashes against node:crypto, and PE files signed here (PKCS#7 built by
// hand, RSA key from node:crypto) verified, then tampered with in every part the signature covers.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hash, createHash, verifyAuthenticode, peLayout, TRUST_E_NOSIGNATURE, TRUST_E_BAD_DIGEST, TRUST_E_SUBJECT_FORM_UNKNOWN } from '../src/win32/authenticode.js';

test('md5 / sha1 / sha256 match node:crypto, whole and in pieces', () => {
  let seed = 7; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  for (let n = 0; n < 200; n++) {
    const b = crypto.randomBytes(rnd() % 700);
    for (const k of ['md5', 'sha1', 'sha256']) {
      const want = crypto.createHash(k).update(b).digest('hex');
      assert.equal(Buffer.from(hash(k, b)).toString('hex'), want);
      const h = createHash(k);
      for (let o = 0; o < b.length;) { const s = Math.min(b.length - o, 1 + rnd() % 90); h.update(b.subarray(o, o + s)); o += s; }
      assert.equal(Buffer.from(h.digest()).toString('hex'), want);
    }
  }
});

// ---------------------------------------------------------------- DER builder
const len = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255]);
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map((p) => Buffer.from(p))); return Buffer.concat([Buffer.from([tag, ...len(body.length)]), body]); };
const seq = (...p) => tlv(0x30, ...p), set = (...p) => tlv(0x31, ...p), ctx0 = (...p) => tlv(0xa0, ...p);
const int = (n) => tlv(2, [n]);
const oct = (b) => tlv(4, b);
const oid = (s) => { const a = s.split('.').map(Number), out = [a[0] * 40 + a[1]]; for (const v of a.slice(2)) { const enc = [v & 0x7f]; for (let x = Math.floor(v / 128); x; x = Math.floor(x / 128)) enc.unshift(0x80 | (x & 0x7f)); out.push(...enc); } return tlv(6, out); };
const NULL = Buffer.from([5, 0]);
const ALG = { md5: '1.2.840.113549.2.5', sha1: '1.3.14.3.2.26', sha256: '2.16.840.1.101.3.4.2.1' };

/** A small PE32 file (headers, two sections, some trailing data). */
function makePe(extra = 0) {
  const f = Buffer.alloc(0x600 + extra);
  f.write('MZ', 0); f.writeUInt32LE(0x80, 0x3c); f.write('PE\0\0', 0x80);
  f.writeUInt16LE(0x14c, 0x84); f.writeUInt16LE(2, 0x86); f.writeUInt16LE(224, 0x94);
  const opt = 0x98; f.writeUInt16LE(0x10b, opt); f.writeUInt32LE(0x1234, opt + 64); f.writeUInt32LE(16, opt + 92);
  for (let i = 0x200; i < f.length; i++) f[i] = (i * 31) & 255;
  return f;
}
/** Sign: the certificate table appended (8-aligned), its directory entry set. Returns the signed file. */
function sign(pe, kind = 'sha256', { key = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }), attrs = true } = {}) {
  const f = Buffer.from(pe), certOff = (f.length + 7) & ~7;
  const L = peLayout(f);
  const pad = Buffer.alloc(certOff - f.length);
  // image digest: everything but the checksum and the directory entry (the table is not there yet)
  const h = crypto.createHash(kind); h.update(f.subarray(0, L.checksum)); h.update(f.subarray(L.checksum + 4, L.secEntry)); h.update(f.subarray(L.secEntry + 8)); h.update(pad);
  const spcValue = [seq(oid('1.3.6.1.4.1.311.2.1.15'), seq()), seq(seq(oid(ALG[kind]), NULL), oct(h.digest()))];
  const spc = seq(...spcValue), spcBody = Buffer.concat(spcValue);
  const serial = int(0x2a), issuer = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('Orthros test')))));
  const spki = key.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(ctx0(int(2)), serial, seq(oid('1.2.840.113549.1.1.11'), NULL), issuer, seq(tlv(0x17, Buffer.from('200101000000Z')), tlv(0x17, Buffer.from('400101000000Z'))), issuer, spki);
  const cert = seq(tbs, seq(oid('1.2.840.113549.1.1.11'), NULL), tlv(3, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, key.privateKey)])));
  let signerParts;
  if (attrs) {
    const a = [seq(oid('1.2.840.113549.1.9.3'), set(oid('1.3.6.1.4.1.311.2.1.4'))), seq(oid('1.2.840.113549.1.9.4'), set(oct(crypto.createHash(kind).update(spcBody).digest())))];
    const asSet = set(...a), sig = crypto.sign(kind, asSet, key.privateKey);
    signerParts = [int(1), seq(issuer, serial), seq(oid(ALG[kind]), NULL), tlv(0xa0, ...a), seq(oid('1.2.840.113549.1.1.1'), NULL), oct(sig)];
  } else signerParts = [int(1), seq(issuer, serial), seq(oid(ALG[kind]), NULL), seq(oid('1.2.840.113549.1.1.1'), NULL), oct(crypto.sign(kind, spcBody, key.privateKey))];
  const sd = seq(int(1), set(seq(oid(ALG[kind]), NULL)), seq(oid('1.3.6.1.4.1.311.2.1.4'), ctx0(spc)), ctx0(cert), set(seq(...signerParts)));
  const p7 = seq(oid('1.2.840.113549.1.7.2'), ctx0(sd));
  const wlen = (8 + p7.length + 7) & ~7, win = Buffer.alloc(wlen);
  win.writeUInt32LE(wlen, 0); win.writeUInt16LE(0x200, 4); win.writeUInt16LE(2, 6); p7.copy(win, 8);
  const out = Buffer.concat([f, pad, win]);
  out.writeUInt32LE(certOff, L.secEntry); out.writeUInt32LE(wlen, L.secEntry + 4);
  out.writeUInt32LE(0xbeef, L.checksum); // (the checksum is outside the digest)
  return { file: out, certOff, key };
}

test('signed PE files verify; unsigned and tampered ones do not', () => {
  for (const kind of ['sha256', 'sha1', 'md5']) {
    for (const attrs of [true, false]) {
      for (const extra of [0, 3]) {
        const { file, certOff } = sign(makePe(extra), kind, { attrs });
        assert.equal(verifyAuthenticode(new Uint8Array(file)).status, 0, `${kind} attrs ${attrs} extra ${extra}`);
        // the checksum changed after signing: still valid
        const c = Buffer.from(file); c.writeUInt32LE(0x55, peLayout(c).checksum); assert.equal(verifyAuthenticode(new Uint8Array(c)).status, 0);
        // a byte of a section changed: bad digest
        const t = Buffer.from(file); t[0x300] ^= 1; assert.equal(verifyAuthenticode(new Uint8Array(t)).status, TRUST_E_BAD_DIGEST);
        // a header byte changed
        const t2 = Buffer.from(file); t2[0x40] ^= 1; assert.equal(verifyAuthenticode(new Uint8Array(t2)).status, TRUST_E_BAD_DIGEST);
        // the signature itself changed (its last byte)
        const t3 = Buffer.from(file); const p7len = t3.readUInt32LE(certOff); let last = certOff + p7len - 1; while (t3[last] === 0) last--; t3[last] ^= 1;
        assert.notEqual(verifyAuthenticode(new Uint8Array(t3)).status, 0);
        // the table cut off by the end of the file
        assert.equal(verifyAuthenticode(new Uint8Array(file.subarray(0, file.length - 8))).status, TRUST_E_NOSIGNATURE);
      }
    }
  }
});

test('a signature by another key than the certificate\'s fails', () => {
  const { file } = sign(makePe(), 'sha256');
  const other = sign(makePe(), 'sha256');
  // the encrypted digest (the signer info's last 128 bytes, 1024-bit keys) replaced by the other key's: the image and
  // attribute digests still match, the RSA signature no longer verifies with the certificate's key
  const a = Buffer.from(file), b = other.file, end = (f) => { let e = f.length; while (f[e - 1] === 0) e--; return e; };
  a.set(b.subarray(end(b) - 128, end(b)), end(a) - 128);
  assert.equal(verifyAuthenticode(new Uint8Array(a)).why, 'signature does not verify');
});

test('files without a signature, and files that are not PE', () => {
  assert.equal(verifyAuthenticode(new Uint8Array(makePe())).status, TRUST_E_NOSIGNATURE);
  assert.equal(verifyAuthenticode(new Uint8Array(Buffer.from('hello world, not a PE file at all.......................................'))).status, TRUST_E_SUBJECT_FORM_UNKNOWN);
});
