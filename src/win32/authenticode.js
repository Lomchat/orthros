// Authenticode (signed PE files) for wintrust.dll!WinVerifyTrust: synchronous, from scratch — the guest's call is
// synchronous and WebCrypto is not.
//
// What is checked, as Windows does: the file carries a PKCS#7 SignedData in its certificate table whose
// SpcIndirectDataContent digest equals the file's Authenticode image digest (MD5 / SHA-1 / SHA-256), whose signer's
// messageDigest attribute is the digest of that content, and whose signer's RSA signature over the authenticated
// attributes verifies with the signer's certificate (PKCS#1 v1.5). Not checked: the certificate chain up to a trusted
// root, revocation and validity periods (there is no Windows root store here; a file signed by its publisher and left
// intact verifies as it does on a Windows machine that trusts that publisher's root).

export const TRUST_E_NOSIGNATURE = 0x800b0100, TRUST_E_BAD_DIGEST = 0x80096010, TRUST_E_SUBJECT_FORM_UNKNOWN = 0x800b0003, CRYPT_E_SECURITY_SETTINGS = 0x80092026;
export const TRUST_E_NO_SIGNER_CERT = 0x80096002, TRUST_E_FAIL = 0x800b010b;

// ---------------------------------------------------------------- hashes
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** Incremental hash over 64-byte blocks: update(bytes) any number of times, then digest(). */
class BlockHash {
  constructor(kind) {
    this.kind = kind; this.buf = new Uint8Array(64); this.n = 0; this.len = 0; this.w = new Uint32Array(kind === 'sha256' ? 64 : kind === 'sha1' ? 80 : 16);
    this.h = new Uint32Array(kind === 'sha256' ? [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
      : kind === 'sha1' ? [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0] : [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  }
  update(d) {
    let i = 0; this.len += d.length;
    if (this.n) { const k = Math.min(64 - this.n, d.length); this.buf.set(d.subarray(0, k), this.n); this.n += k; i = k; if (this.n < 64) return this; this.block(this.buf, 0); this.n = 0; }
    for (; i + 64 <= d.length; i += 64) this.block(d, i);
    if (i < d.length) { this.buf.set(d.subarray(i), 0); this.n = d.length - i; }
    return this;
  }
  digest() {
    const bits = this.len * 8, le = this.kind === 'md5';
    const pad = new Uint8Array(((this.n + 9 + 63) & ~63) - this.n); pad[0] = 0x80;
    const dv = new DataView(pad.buffer), at = pad.length - 8;
    dv.setUint32(at + (le ? 0 : 4), bits >>> 0, le); dv.setUint32(at + (le ? 4 : 0), Math.floor(bits / 2 ** 32), le);
    this.update(pad);
    const out = new Uint8Array(this.h.length * 4), ov = new DataView(out.buffer);
    this.h.forEach((v, j) => ov.setUint32(j * 4, v, le));
    return out;
  }
  block(d, o) {
    const w = this.w, h = this.h;
    if (this.kind === 'md5') {
      for (let j = 0; j < 16; j++) w[j] = d[o + j * 4] | d[o + j * 4 + 1] << 8 | d[o + j * 4 + 2] << 16 | d[o + j * 4 + 3] << 24;
      let [a, b, c, e] = h;
      for (let j = 0; j < 64; j++) {
        let f, g;
        if (j < 16) { f = (b & c) | (~b & e); g = j; } else if (j < 32) { f = (e & b) | (~e & c); g = (5 * j + 1) & 15; } else if (j < 48) { f = b ^ c ^ e; g = (3 * j + 5) & 15; } else { f = c ^ (b | ~e); g = (7 * j) & 15; }
        const s = MD5_S[(j >> 4) * 4 + (j & 3)], t = (a + f + MD5_K[j] + w[g]) | 0;
        a = e; e = c; c = b; b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += e;
      return;
    }
    for (let j = 0; j < 16; j++) w[j] = d[o + j * 4] << 24 | d[o + j * 4 + 1] << 16 | d[o + j * 4 + 2] << 8 | d[o + j * 4 + 3];
    if (this.kind === 'sha1') {
      for (let j = 16; j < 80; j++) { const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]; w[j] = (x << 1) | (x >>> 31); }
      let [a, b, c, e, f] = h;
      for (let j = 0; j < 80; j++) {
        const k = j < 20 ? ((b & c) | (~b & e)) + 0x5a827999 : j < 40 ? (b ^ c ^ e) + 0x6ed9eba1 : j < 60 ? ((b & c) | (b & e) | (c & e)) + 0x8f1bbcdc : (b ^ c ^ e) + 0xca62c1d6;
        const t = (((a << 5) | (a >>> 27)) + k + f + w[j]) | 0;
        f = e; e = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += e; h[4] += f;
      return;
    }
    for (let j = 16; j < 64; j++) {
      const x = w[j - 15], y = w[j - 2];
      w[j] = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[j - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) + w[j - 16];
    }
    let [a, b, c, e, f, g, k, l] = h;
    for (let j = 0; j < 64; j++) {
      const t1 = (l + (((f >>> 6) | (f << 26)) ^ ((f >>> 11) | (f << 21)) ^ ((f >>> 25) | (f << 7))) + ((f & g) ^ (~f & k)) + K256[j] + w[j]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      l = k; k = g; g = f; f = (e + t1) | 0; e = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += e; h[4] += f; h[5] += g; h[6] += k; h[7] += l;
  }
}

/** @param {'md5'|'sha1'|'sha256'} kind */
export function createHash(kind) { return new BlockHash(kind); }
export function hash(kind, bytes) { return new BlockHash(kind).update(bytes).digest(); }

const DIGEST_OIDS = { '1.2.840.113549.2.5': 'md5', '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256' };

// ---------------------------------------------------------------- DER
/** One DER element at `o`: { tag, start (of the header), hdr (header length), len (content length), end }. */
export function derAt(b, o) {
  if (o + 2 > b.length) throw new Error('DER: truncated');
  const tag = b[o]; let len = b[o + 1], hdr = 2;
  if (len === 0x80) throw new Error('DER: indefinite length');
  if (len & 0x80) { const n = len & 0x7f; if (n > 4) throw new Error('DER: length too long'); len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[o + 2 + i]; hdr += n; }
  if (o + hdr + len > b.length) throw new Error('DER: element past its container');
  return { tag, start: o, hdr, len, end: o + hdr + len, body: o + hdr };
}
/** The children of a constructed element. */
export function derChildren(b, e) { const out = []; for (let o = e.body; o < e.end;) { const c = derAt(b, o); out.push(c); o = c.end; } return out; }
function oid(b, e) {
  if (e.tag !== 6) throw new Error('DER: OID expected');
  const out = [], first = b[e.body]; out.push(Math.floor(first / 40), first % 40);
  let v = 0; for (let i = e.body + 1; i < e.end; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { out.push(v); v = 0; } }
  return out.join('.');
}
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const toBig = (u8) => { let x = 0n; for (const v of u8) x = (x << 8n) | BigInt(v); return x; };
function modPow(base, exp, m) { let r = 1n; base %= m; while (exp > 0n) { if (exp & 1n) r = (r * base) % m; base = (base * base) % m; exp >>= 1n; } return r; }

// ---------------------------------------------------------------- PE
/** The certificate table and the Authenticode digest's holes of a PE file, or null when it is not a PE file. */
export function peLayout(f) {
  if (f.length < 0x40 || f[0] !== 0x4d || f[1] !== 0x5a) return null;
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const pe = dv.getUint32(0x3c, true);
  if (pe + 24 > f.length || dv.getUint32(pe, true) !== 0x4550) return null;
  const opt = pe + 24, magic = dv.getUint16(opt, true);
  const dirs = opt + (magic === 0x20b ? 112 : 96), nDirs = dv.getUint32(dirs - 4, true);
  const checksum = opt + 64, secEntry = dirs + 4 * 8;
  if (secEntry + 8 > f.length) return null;
  const certOff = nDirs > 4 ? dv.getUint32(secEntry, true) : 0, certLen = nDirs > 4 ? dv.getUint32(secEntry + 4, true) : 0;
  return { checksum, secEntry, certOff, certLen };
}
/** Authenticode image digest: every byte of the file except the checksum, the certificate table's directory entry and the table. */
export function imageDigest(f, kind, L = peLayout(f)) {
  const h = createHash(kind), end = L.certLen ? L.certOff : f.length;
  h.update(f.subarray(0, L.checksum)); h.update(f.subarray(L.checksum + 4, L.secEntry)); h.update(f.subarray(L.secEntry + 8, end));
  if (L.certLen && L.certOff + L.certLen < f.length) h.update(f.subarray(L.certOff + L.certLen));
  // (data between the end of the image and the table, not a multiple of 8 bytes, is padded with zeros by signing tools)
  return h.digest();
}

/**
 * WinVerifyTrust's answer for a file's contents (WINTRUST_ACTION_GENERIC_VERIFY_V2 on a file).
 * @param {Uint8Array} f @returns {{ status: number, why: string }}
 */
export function verifyAuthenticode(f) {
  const L = peLayout(f);
  if (!L) return { status: TRUST_E_SUBJECT_FORM_UNKNOWN, why: 'not a PE file' };
  if (!L.certLen || !L.certOff) return { status: TRUST_E_NOSIGNATURE, why: 'no certificate table' };
  if (L.certOff + L.certLen > f.length || L.certLen < 8) return { status: TRUST_E_NOSIGNATURE, why: 'certificate table past the end of the file' }; // (no signature can be read)
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  // WIN_CERTIFICATE entries (8-byte aligned): the first PKCS#7 one (revision 0x200, type 2) is the signature
  let pk = null;
  for (let o = L.certOff; o + 8 <= L.certOff + L.certLen;) {
    const len = dv.getUint32(o, true), type = dv.getUint16(o + 6, true);
    if (len < 8) break;
    if (type === 2) { pk = f.subarray(o + 8, Math.min(o + len, f.length)); break; }
    o += (len + 7) & ~7;
  }
  if (!pk) return { status: TRUST_E_NOSIGNATURE, why: 'no PKCS#7 certificate' };
  try {
    const ci = derAt(pk, 0), [ctype, ctx] = derChildren(pk, ci);
    if (oid(pk, ctype) !== '1.2.840.113549.1.7.2') return { status: TRUST_E_NOSIGNATURE, why: 'not SignedData' };
    const sd = derChildren(pk, derAt(pk, ctx.body));
    const content = derChildren(pk, sd[2]);
    if (oid(pk, content[0]) !== '1.3.6.1.4.1.311.2.1.4') return { status: TRUST_E_NOSIGNATURE, why: 'not SpcIndirectDataContent' };
    const spc = derAt(pk, content[1].body), [, digestInfo] = derChildren(pk, spc);
    const [alg, dig] = derChildren(pk, digestInfo), kind = DIGEST_OIDS[oid(pk, derChildren(pk, alg)[0])];
    if (!kind) return { status: TRUST_E_BAD_DIGEST, why: 'unknown digest algorithm' };
    const want = pk.subarray(dig.body, dig.end), got = imageDigest(f, kind, L);
    if (!bytesEq(want, got)) return { status: TRUST_E_BAD_DIGEST, why: `${kind} image digest differs` };
    // the signer: certificates [0], signerInfos SET (last element)
    let certs = [], signerSet = sd[sd.length - 1];
    for (const e of sd.slice(3)) if (e.tag === 0xa0) certs = derChildren(pk, e);
    const signers = derChildren(pk, signerSet);
    if (!signers.length) return { status: TRUST_E_NO_SIGNER_CERT, why: 'no signer' };
    const si = derChildren(pk, signers[0]);
    // version, issuerAndSerialNumber, digestAlgorithm, [0] authenticatedAttributes, digestEncryptionAlgorithm, encryptedDigest
    const ias = derChildren(pk, si[1]), siKind = DIGEST_OIDS[oid(pk, derChildren(pk, si[2])[0])];
    const attrs = si[3]?.tag === 0xa0 ? si[3] : null, sig = si[attrs ? 5 : 4];
    if (!siKind || !sig) return { status: TRUST_E_FAIL, why: 'malformed signer' };
    let signed;
    if (attrs) {
      let md = null;
      for (const a of derChildren(pk, attrs)) { const [t, vals] = derChildren(pk, a); if (oid(pk, t) === '1.2.840.113549.1.9.4') { const v = derChildren(pk, vals)[0]; md = pk.subarray(v.body, v.end); } }
      // (the content's digest: the SpcIndirectDataContent's value without its own tag and length)
      if (!md || !bytesEq(md, hash(siKind, pk.subarray(spc.body, spc.end)))) return { status: TRUST_E_BAD_DIGEST, why: 'messageDigest attribute differs' };
      const enc = pk.slice(attrs.start, attrs.end); enc[0] = 0x31; // (signed as a SET OF)
      signed = hash(siKind, enc);
    } else signed = hash(siKind, pk.subarray(spc.body, spc.end));
    // the signer's certificate: the one with that issuer and serial number
    let key = null;
    for (const c of certs) {
      if (c.tag !== 0x30) continue;
      const tbs = derChildren(pk, derChildren(pk, c)[0]), off = tbs[0].tag === 0xa0 ? 1 : 0;
      const serial = tbs[off], issuer = tbs[off + 2];
      const ser2 = ias[1], iss2 = ias[0];
      if (!bytesEq(pk.subarray(serial.start, serial.end), pk.subarray(ser2.start, ser2.end)) || !bytesEq(pk.subarray(issuer.start, issuer.end), pk.subarray(iss2.start, iss2.end))) continue;
      const spki = derChildren(pk, tbs[off + 5]);
      if (oid(pk, derChildren(pk, spki[0])[0]) !== '1.2.840.113549.1.1.1') return { status: TRUST_E_FAIL, why: 'signer key is not RSA' };
      const bits = spki[1], rsa = derChildren(pk, derAt(pk, bits.body + 1));
      key = { n: toBig(pk.subarray(rsa[0].body, rsa[0].end)), e: toBig(pk.subarray(rsa[1].body, rsa[1].end)), bytes: rsa[0].len - (pk[rsa[0].body] === 0 ? 1 : 0) };
      break;
    }
    if (!key) return { status: TRUST_E_NO_SIGNER_CERT, why: 'signer certificate not found' };
    // RSA PKCS#1 v1.5: 00 01 FF.. 00 DigestInfo
    const m = modPow(toBig(pk.subarray(sig.body, sig.end)), key.e, key.n);
    const em = new Uint8Array(key.bytes); let x = m; for (let i = em.length - 1; i >= 0; i--) { em[i] = Number(x & 0xffn); x >>= 8n; }
    if (em[0] !== 0 || em[1] !== 1) return { status: TRUST_E_FAIL, why: 'signature does not verify' };
    let i = 2; while (i < em.length && em[i] === 0xff) i++;
    if (em[i] !== 0 || i < 10) return { status: TRUST_E_FAIL, why: 'signature does not verify' };
    const di = derChildren(em, derAt(em, i + 1)), d2 = em.subarray(di[1].body, di[1].end);
    if (DIGEST_OIDS[oid(em, derChildren(em, di[0])[0])] !== siKind || !bytesEq(d2, signed)) return { status: TRUST_E_FAIL, why: 'signature does not verify' };
    return { status: 0, why: `signed (${kind})` };
  } catch (e) {
    return { status: TRUST_E_BAD_DIGEST, why: `malformed signature (${e.message})` };
  }
}
