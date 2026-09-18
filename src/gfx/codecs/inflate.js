// DEFLATE decoder (RFC 1951) with zlib wrapper support (RFC 1950). Written from scratch.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Build a canonical Huffman decoding table: returns { count[16], symbols[] } */
function buildTable(lengths) {
  const count = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { count, symbols };
}

export function inflate(input, opts = {}) {
  let pos = 0;
  if (opts.zlib !== false && input.length >= 2 && (input[0] & 0x0f) === 8 && ((input[0] << 8) | input[1]) % 31 === 0) pos = 2; // zlib header
  let out = new Uint8Array(Math.max(opts.sizeHint ?? input.length * 4, 1024));
  let olen = 0;
  let acc = 0, n = 0;
  const need = (k) => { while (n < k) { acc |= (pos < input.length ? input[pos++] : 0) << n; n += 8; } };
  const bits = (k) => { need(k); const v = acc & ((1 << k) - 1); acc >>>= k; n -= k; return v; };
  const ensure = (k) => { if (olen + k > out.length) { const nb = new Uint8Array(Math.max(out.length * 2, olen + k)); nb.set(out.subarray(0, olen)); out = nb; } };
  const decodeSym = (t) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = t.count[len];
      if (code - first < c) return t.symbols[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  let fixedLit = null, fixedDist = null;
  for (;;) {
    const final = bits(1), type = bits(2);
    if (type === 0) {
      acc = 0; n = 0; // byte align
      const len = input[pos] | (input[pos + 1] << 8); pos += 4;
      ensure(len); out.set(input.subarray(pos, pos + len), olen); olen += len; pos += len;
    } else {
      let lit, dist;
      if (type === 1) {
        if (!fixedLit) { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); fixedLit = buildTable(l); fixedDist = buildTable(new Uint8Array(30).fill(5)); }
        lit = fixedLit; dist = fixedDist;
      } else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
        const clt = buildTable(cl);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decodeSym(clt);
          if (sym < 16) lens[i++] = sym;
          else if (sym === 16) { const prev = lens[i - 1]; let r = 3 + bits(2); while (r--) lens[i++] = prev; }
          else if (sym === 17) { let r = 3 + bits(3); while (r--) lens[i++] = 0; }
          else { let r = 11 + bits(7); while (r--) lens[i++] = 0; }
        }
        lit = buildTable(lens.subarray(0, hlit)); dist = buildTable(lens.subarray(hlit));
      } else throw new Error('inflate: bad block type');
      for (;;) {
        const sym = decodeSym(lit);
        if (sym < 256) { ensure(1); out[olen++] = sym; continue; }
        if (sym === 256) break;
        const li = sym - 257;
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decodeSym(dist);
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        ensure(len);
        for (let i = 0; i < len; i++) { out[olen] = out[olen - d]; olen++; }
      }
    }
    if (final) break;
  }
  return out.subarray(0, olen);
}
