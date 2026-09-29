// DEFLATE decoder (RFC 1951) with zlib wrapper support (RFC 1950). Written from scratch.
//
// Table-driven: a Huffman code is decoded by one lookup of the next FAST_BITS input bits (DEFLATE packs codes
// most-significant bit first into an LSB-first bit stream, so the table is indexed by the bit-reversed code), each
// entry holding the symbol and its code length; the rare codes longer than FAST_BITS go through the canonical
// bit-by-bit decode. The bit buffer holds up to 32 bits and is refilled a byte at a time; past the end of the input it
// reads zero bits, as the bit-serial decoder this replaces did (a truncated stream decodes what it can, and the
// position still counts those bytes so that a stored block realigns correctly), but no longer forever.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** Length/distance symbol -> (base << 4) | extra bits, one lookup per match. */
const LEN_INFO = new Int32Array(32), DIST_INFO = new Int32Array(32);
for (let i = 0; i < 29; i++) LEN_INFO[i] = (LEN_BASE[i] << 4) | LEN_EXTRA[i];
for (let i = 0; i < 30; i++) DIST_INFO[i] = (DIST_BASE[i] << 4) | DIST_EXTRA[i];

const FAST_BITS = 10, FAST_MASK = (1 << FAST_BITS) - 1;

/**
 * Build a canonical Huffman decoding table: { count[16], symbols[], fast }. fast[next FAST_BITS bits] is
 * (symbol << 4) | length for codes up to FAST_BITS long, 0 for the prefixes of longer codes (and unused codes).
 */
function buildTable(lengths) {
  const count = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  const fast = new Int32Array(1 << FAST_BITS);
  // canonical codes in (length, symbol) order: the order of `symbols`
  let code = 0, k = 0;
  for (let len = 1; len <= FAST_BITS; len++) {
    for (let i = 0; i < count[len]; i++, k++, code++) {
      let rev = 0;
      for (let b = 0; b < len; b++) rev |= ((code >> b) & 1) << (len - 1 - b);
      const e = (symbols[k] << 4) | len;
      for (let j = rev; j <= FAST_MASK; j += 1 << len) fast[j] = e;
    }
    code <<= 1;
  }
  return { count, symbols, fast };
}

let fixedLit = null, fixedDist = null;

/**
 * Bit reader for the block headers and the rare slow decodes. The symbol loop keeps the same three fields in locals
 * (no closure captures them: a captured variable lives in a heap context, one memory access per use) and syncs them
 * around calls to this.
 */
class Bits {
  constructor(input, pos) { this.input = input; this.pos = pos; this.acc = 0; this.n = 0; /** @type {Uint8Array} */ this.out = null; }
  bits(k) {
    while (this.n < k) { this.acc |= (this.pos < this.input.length ? this.input[this.pos] : 0) << this.n; this.pos++; this.n += 8; }
    const v = this.acc & ((1 << k) - 1); this.acc >>>= k; this.n -= k; return v;
  }
  /** One symbol: the fast table, else the canonical bit-by-bit decode (codes longer than FAST_BITS, invalid ones). */
  decode(t) {
    while (this.n < 24) { this.acc |= (this.pos < this.input.length ? this.input[this.pos] : 0) << this.n; this.pos++; this.n += 8; }
    const e = t.fast[this.acc & FAST_MASK];
    if (e) { const l = e & 15; this.acc >>>= l; this.n -= l; return e >> 4; }
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const c = t.count[len];
      if (code - first < c) return t.symbols[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  }
}

function grow(out, olen, k) { const nb = new Uint8Array(Math.max(out.length * 2, olen + k)); nb.set(out.subarray(0, olen)); return nb; }

export function inflate(input, opts = {}) {
  let start = 0;
  if (opts.zlib !== false && input.length >= 2 && (input[0] & 0x0f) === 8 && ((input[0] << 8) | input[1]) % 31 === 0) start = 2; // zlib header
  const inLen = input.length;
  const br = new Bits(input, start);
  let out = new Uint8Array(Math.max(opts.sizeHint ?? inLen * 4, 1024));
  let olen = 0;
  br.out = out;
  // A truncated stream decodes as if zero bits followed (what the stream holds comes out) and ends once more than the
  // read-ahead was consumed past its end: zero bits alone would repeat empty blocks or literals forever.
  while (br.pos < inLen + 8) {
    const final = br.bits(1), type = br.bits(2);
    if (type === 0) {
      let pos = br.pos - (br.n >> 3); br.acc = 0; br.n = 0; // byte align (the whole bytes still buffered go back to the input)
      const len = input[pos] | (input[pos + 1] << 8); pos += 4;
      if (olen + len > out.length) br.out = out = grow(out, olen, len);
      out.set(input.subarray(pos, pos + len), olen); olen += len; br.pos = pos + len;
    } else {
      let lit, dist;
      if (type === 1) {
        if (!fixedLit) { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); fixedLit = buildTable(l); fixedDist = buildTable(new Uint8Array(30).fill(5)); }
        lit = fixedLit; dist = fixedDist;
      } else if (type === 2) {
        const hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = br.bits(3);
        const clt = buildTable(cl);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = br.decode(clt);
          if (sym < 16) lens[i++] = sym;
          else if (sym === 16) { const prev = lens[i - 1]; let r = 3 + br.bits(2); while (r--) lens[i++] = prev; }
          else if (sym === 17) { let r = 3 + br.bits(3); while (r--) lens[i++] = 0; }
          else { let r = 11 + br.bits(7); while (r--) lens[i++] = 0; }
        }
        lit = buildTable(lens.subarray(0, hlit)); dist = buildTable(lens.subarray(hlit));
      } else throw new Error('inflate: bad block type');
      olen = inflateBlock(br, input, lit, dist, olen); out = br.out;
    }
    if (final) break;
  }
  return out.subarray(0, olen);
}

/**
 * The symbols of one compressed block up to its end code, appended to br.out from olen (br.out replaced when it grows);
 * returns the new length. A function of its own so that the engine optimizes it whole: as a loop nested in inflate it
 * ran as on-stack-replaced code that was thrown away at every block end.
 */
function inflateBlock(br, input, lit, dist, olen) {
  const litFast = lit.fast, distFast = dist.fast, inLen = input.length;
  let out = br.out, acc = br.acc, n = br.n, pos = br.pos;
  const limit = inLen + 8; // (read ahead is at most 4 bytes: past this, zero bits were decoded as data)
  while (pos < limit) {
    // (at least 24 bits buffered: a fast code plus its extra bits, 10 + 5 or 10 + 13)
    while (n < 24) { acc |= (pos < inLen ? input[pos] : 0) << n; pos++; n += 8; }
    let sym;
    const e = litFast[acc & FAST_MASK];
    if (e) {
      const l = e & 15; acc >>>= l; n -= l; sym = e >> 4;
      if (sym < 256) {
        if (olen >= out.length) out = grow(out, olen, 1);
        out[olen++] = sym;
        // (a second literal from the same refill: at least 14 bits are left, enough for any fast code)
        const e2 = litFast[acc & FAST_MASK];
        if (e2 && e2 < 256 << 4) { const l2 = e2 & 15; acc >>>= l2; n -= l2; if (olen >= out.length) out = grow(out, olen, 1); out[olen++] = e2 >> 4; }
        continue;
      }
    } else { br.acc = acc; br.n = n; br.pos = pos; sym = br.decode(lit); acc = br.acc; n = br.n; pos = br.pos; }
    if (sym < 256) { if (olen >= out.length) out = grow(out, olen, 1); out[olen++] = sym; continue; }
    if (sym === 256) break;
    if (sym > 285) throw new Error('inflate: bad length code');
    while (n < 24) { acc |= (pos < inLen ? input[pos] : 0) << n; pos++; n += 8; }
    const li = LEN_INFO[sym - 257], lx = li & 15;
    const len = (li >> 4) + (acc & ((1 << lx) - 1)); acc >>>= lx; n -= lx;
    while (n < 24) { acc |= (pos < inLen ? input[pos] : 0) << n; pos++; n += 8; }
    let di;
    const de = distFast[acc & FAST_MASK];
    if (de) { const l = de & 15; acc >>>= l; n -= l; di = de >> 4; }
    else { br.acc = acc; br.n = n; br.pos = pos; di = br.decode(dist); acc = br.acc; n = br.n; pos = br.pos; }
    if (di > 29) throw new Error('inflate: bad distance code');
    while (n < 24) { acc |= (pos < inLen ? input[pos] : 0) << n; pos++; n += 8; }
    const dinfo = DIST_INFO[di], dx = dinfo & 15;
    const d = (dinfo >> 4) + (acc & ((1 << dx) - 1)); acc >>>= dx; n -= dx;
    if (olen + len > out.length) out = grow(out, olen, len);
    let from = olen - d;
    if (d >= len && len > 32 && from >= 0) { out.copyWithin(olen, from, from + len); olen += len; continue; }
    for (let i = 0; i < len; i++) out[olen++] = out[from++];
  }
  br.acc = acc; br.n = n; br.pos = pos; br.out = out;
  return olen;
}
